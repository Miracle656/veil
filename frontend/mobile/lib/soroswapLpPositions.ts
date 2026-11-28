import { Asset, Horizon, nativeToScVal } from '@stellar/stellar-sdk';

import { getFeePayerAddress } from './activity';
import { ASSET_REGISTRY, getAssetIssuer } from './assets';
import { fetchPrice, usdValue } from './fetchPrice';
import { getNetwork } from './network';
import { simulateRead } from './contractInvoke';

// These are the deployed Soroswap factories in soroswap/core's public
// mainnet.contracts.json and testnet.contracts.json. Pairs are discovered from
// each factory at runtime; no position or pair list is bundled here.
export const SOROSWAP_FACTORY_IDS = {
  mainnet: 'CA4HEQTL2WPEUYKYKCDOHCDNIV4QHNJ7EL4J4NQ6VADP7SYHVRYZ7AW2',
  testnet: 'CDP3HMUH6SMS3S7NPGNDJLULCOXXEPSHY4JKUKMBNQMATHDHWXRRJTBY',
} as const;

const READ_CONCURRENCY = 8;
const MAX_TOKEN_DECIMALS = 38;

export type LpPosition = {
  pairId: string;
  tokenAId: string;
  tokenBId: string;
  tokenA: string;
  tokenB: string;
  lpBalance: string;
  lpBalanceRaw: string;
  ownerBalances: { address: string; raw: string }[];
  ownershipPercent: string;
  underlyingA: string;
  underlyingB: string;
  usd: number | null;
};

type UnderlyingAsset = {
  symbol: string;
  issuer: string | null;
  decimals: number;
  native: boolean;
};

function readError(contractId: string, method: string): Error {
  return new Error(`Could not read Soroswap ${method} from ${contractId}.`);
}

async function requiredRead(
  contractId: string,
  method: string,
  args: Parameters<typeof simulateRead>[2] = []
): Promise<unknown> {
  const value = await simulateRead(contractId, method, args);
  if (value === null) throw readError(contractId, method);
  return value;
}

function integer(value: unknown, contractId: string, method: string): bigint {
  try {
    if (typeof value === 'bigint' && value >= 0n) return value;
    if (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0)
      return BigInt(value);
    if (typeof value === 'string' && /^\d+$/.test(value)) return BigInt(value);
  } catch {
    // Report the same explicit contract-read error for malformed RPC values.
  }
  throw readError(contractId, method);
}

function decimalsValue(value: unknown, contractId: string): number {
  const decimals = integer(value, contractId, 'decimals');
  if (decimals > BigInt(MAX_TOKEN_DECIMALS)) {
    throw new Error(`Unsupported token precision reported by ${contractId}.`);
  }
  return Number(decimals);
}

function formatUnits(amount: bigint, decimals: number): string {
  const scale = 10n ** BigInt(decimals);
  const whole = amount / scale;
  const fraction =
    decimals === 0 ? '' : (amount % scale).toString().padStart(decimals, '0').replace(/0+$/, '');
  return fraction ? `${whole}.${fraction}` : whole.toString();
}

function resolveKnownAsset(
  contractId: string
): { symbol: string; issuer: string | null; native: boolean } | null {
  const network = getNetwork();
  if (contractId === Asset.native().contractId(network.networkPassphrase)) {
    return { symbol: 'XLM', issuer: null, native: true };
  }

  for (const code of Object.keys(ASSET_REGISTRY)) {
    if (code === 'XLM') continue;
    const issuer = getAssetIssuer(code, network.name);
    if (issuer && new Asset(code, issuer).contractId(network.networkPassphrase) === contractId) {
      return { symbol: code, issuer, native: false };
    }
  }
  return null;
}

async function resolveClassicAsset(
  contractId: string,
  symbol: string
): Promise<{ symbol: string; issuer: string } | null> {
  if (!/^[A-Za-z0-9]{1,12}$/.test(symbol)) return null;
  const network = getNetwork();
  const server = new Horizon.Server(network.horizonUrl);

  try {
    let page = await server.assets().forCode(symbol).limit(200).call();
    while (page.records.length > 0) {
      for (const record of page.records as { asset_code: string; asset_issuer: string }[]) {
        if (
          record.asset_code === symbol &&
          new Asset(symbol, record.asset_issuer).contractId(network.networkPassphrase) ===
            contractId
        ) {
          return { symbol, issuer: record.asset_issuer };
        }
      }
      if (page.records.length < 200) break;
      page = await page.next();
    }
  } catch (err) {
    console.warn(
      '[soroswap-lp] could not resolve underlying asset issuer:',
      err instanceof Error ? `${err.name}: ${err.message}` : err
    );
  }
  return null;
}

async function readUnderlyingAsset(contractId: string): Promise<UnderlyingAsset> {
  const known = resolveKnownAsset(contractId);
  const [symbolValue, decimalsValueResult] = await Promise.all([
    known ? Promise.resolve(known.symbol) : simulateRead(contractId, 'symbol', []),
    requiredRead(contractId, 'decimals'),
  ]);
  const symbol =
    typeof symbolValue === 'string' && symbolValue.trim()
      ? symbolValue.trim()
      : `${contractId.slice(0, 4)}…${contractId.slice(-4)}`;
  const resolved = known ?? (await resolveClassicAsset(contractId, symbol));

  return {
    symbol,
    issuer: resolved?.issuer ?? null,
    decimals: decimalsValue(decimalsValueResult, contractId),
    native: known?.native ?? false,
  };
}

async function mapInBatches<T, R>(values: T[], fn: (value: T) => Promise<R>): Promise<R[]> {
  const results: R[] = [];
  for (let i = 0; i < values.length; i += READ_CONCURRENCY) {
    results.push(...(await Promise.all(values.slice(i, i + READ_CONCURRENCY).map(fn))));
  }
  return results;
}

function formatPercent(balance: bigint, supply: bigint): string {
  const hundredths = (balance * 10_000n) / supply;
  if (balance > 0n && hundredths === 0n) return '<0.01';
  return (Number(hundredths) / 100).toFixed(2);
}

async function readPosition(
  pairId: string,
  ownerBalances: { address: string; raw: bigint }[],
): Promise<LpPosition> {
  const [tokenAIdValue, tokenBIdValue, reserveValues, supplyValue, lpDecimalsValue] =
    await Promise.all([
      requiredRead(pairId, 'token_0'),
      requiredRead(pairId, 'token_1'),
      requiredRead(pairId, 'get_reserves'),
      requiredRead(pairId, 'total_supply'),
      requiredRead(pairId, 'decimals'),
    ]);
  if (
    typeof tokenAIdValue !== 'string' ||
    typeof tokenBIdValue !== 'string' ||
    !Array.isArray(reserveValues) ||
    reserveValues.length !== 2
  ) {
    throw readError(pairId, 'pair metadata');
  }

  const balance = ownerBalances.reduce((total, held) => total + held.raw, 0n);
  const supply = integer(supplyValue, pairId, 'total_supply');
  if (supply === 0n || balance > supply) throw readError(pairId, 'total_supply');
  const reserveA = integer(reserveValues[0], pairId, 'get_reserves');
  const reserveB = integer(reserveValues[1], pairId, 'get_reserves');
  const lpDecimals = decimalsValue(lpDecimalsValue, pairId);
  const [assetA, assetB] = await Promise.all([
    readUnderlyingAsset(tokenAIdValue),
    readUnderlyingAsset(tokenBIdValue),
  ]);
  const amountA = (reserveA * balance) / supply;
  const amountB = (reserveB * balance) / supply;
  const underlyingA = formatUnits(amountA, assetA.decimals);
  const underlyingB = formatUnits(amountB, assetB.decimals);

  const [priceA, priceB] = await Promise.all([
    assetA.native
      ? fetchPrice(assetA.symbol, assetA.issuer)
      : assetA.issuer !== null && assetA.symbol !== 'XLM'
        ? fetchPrice(assetA.symbol, assetA.issuer)
        : Promise.resolve(null),
    assetB.native
      ? fetchPrice(assetB.symbol, assetB.issuer)
      : assetB.issuer !== null && assetB.symbol !== 'XLM'
        ? fetchPrice(assetB.symbol, assetB.issuer)
        : Promise.resolve(null),
  ]);
  const valueA = usdValue(underlyingA, priceA);
  const valueB = usdValue(underlyingB, priceB);

  return {
    pairId,
    tokenAId: tokenAIdValue,
    tokenBId: tokenBIdValue,
    tokenA: assetA.symbol,
    tokenB: assetB.symbol,
    lpBalance: formatUnits(balance, lpDecimals),
    lpBalanceRaw: balance.toString(),
    ownerBalances: ownerBalances.map(({ address, raw }) => ({ address, raw: raw.toString() })),
    ownershipPercent: formatPercent(balance, supply),
    underlyingA,
    underlyingB,
    usd: valueA === null || valueB === null ? null : valueA + valueB,
  };
}

/**
 * Discover held Soroswap LP positions from the active network's factory.
 * The pair's SEP-41 balance is checked for both a smart-wallet C-address and
 * its fee-payer G-address, and those balances are combined for the position.
 */
export async function loadSoroswapLpPositions(address: string): Promise<LpPosition[]> {
  const network = getNetwork();
  const factoryId = SOROSWAP_FACTORY_IDS[network.name];
  const count = integer(
    await requiredRead(factoryId, 'all_pairs_length'),
    factoryId,
    'all_pairs_length'
  );
  const pairIds = await mapInBatches(
    Array.from({ length: Number(count) }, (_, index) => index),
    async (index) => {
      const pairId = await requiredRead(factoryId, 'all_pairs', [
        nativeToScVal(index, { type: 'u32' }),
      ]);
      if (typeof pairId !== 'string') throw readError(factoryId, 'all_pairs');
      return pairId;
    }
  );
  const owners = [
    ...new Set([
      address,
      ...(address.startsWith('C')
        ? [await getFeePayerAddress()].filter((v): v is string => !!v)
        : []),
    ]),
  ];

  const balances = await mapInBatches(pairIds, async (pairId) => {
    const ownerBalances = await Promise.all(
      owners.map((owner) =>
        requiredRead(pairId, 'balance', [nativeToScVal(owner, { type: 'address' })]).then((value) =>
          integer(value, pairId, 'balance')
        )
      )
    );
    return {
      pairId,
      ownerBalances: owners.map((address, index) => ({ address, raw: ownerBalances[index]! })),
    };
  });
  const held = balances.filter((position) =>
    position.ownerBalances.some(({ raw }) => raw > 0n),
  );
  return mapInBatches(held, ({ pairId, ownerBalances }) =>
    readPosition(pairId, ownerBalances),
  );
}
