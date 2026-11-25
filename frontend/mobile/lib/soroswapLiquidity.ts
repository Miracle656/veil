import {
  Asset,
  Horizon,
  nativeToScVal,
  rpc as SorobanRpc,
  type xdr,
} from '@stellar/stellar-sdk';

import { getNetwork } from './network';
import { simulateRead } from './contractInvoke';
import { SOROSWAP_FACTORY_IDS } from './soroswapLpPositions';
import { checkSwapAsset, classicAsset, swapRouteInput, type SwapAsset } from './swapAssets';

export const DEFAULT_LIQUIDITY_SLIPPAGE_BPS = 50;
export const MIN_LIQUIDITY_SLIPPAGE_BPS = 10;
export const MAX_LIQUIDITY_SLIPPAGE_BPS = 500;
export const HIGH_LIQUIDITY_SLIPPAGE_BPS = 100;
export const SOROSWAP_MINIMUM_LIQUIDITY = 1_000n;
export const STELLAR_DECIMALS = 7;

const BASIS_POINTS = 10_000n;
const I128_MAX = (1n << 127n) - 1n;
const FEE_BUFFER_STROOPS = 500_000n; // Matches getFeePayerXlm's 0.05 XLM fee buffer.
const ROUTER_IDS = {
  mainnet: 'CAG5LRYQ5JVEUI5TEID72EYOVX44TTUJT5BQR2J6J77FH65PCCFAJDDH',
  testnet: 'CCJUD55AG6W5HAI5LRVNKAE5WDP5XGZBUDS5WNTIVDU7O264UZZE7BRD',
} as const;

export type SoroswapPairState = {
  pairId: string;
  tokenAId: string;
  tokenBId: string;
  reserveA: bigint;
  reserveB: bigint;
  balanceA: bigint;
  balanceB: bigint;
  totalSupply: bigint;
  kLast: bigint;
  feesEnabled: boolean;
  decimalsA: number;
  decimalsB: number;
  lpDecimals: number;
};

export type PairLookup =
  | { kind: 'missing' }
  | { kind: 'found'; pair: SoroswapPairState };

export type AddLiquidityEstimate = {
  amountA: bigint;
  amountB: bigint;
  minimumA: bigint;
  minimumB: bigint;
  liquidity: bigint;
  supplyAfterProtocolFee: bigint;
  poolSharePercent: string;
};

export type RemoveLiquidityEstimate = {
  liquidity: bigint;
  amountA: bigint;
  amountB: bigint;
  minimumA: bigint;
  minimumB: bigint;
};

export type LiquidityRouterArgs = {
  method: 'add_liquidity' | 'remove_liquidity' | 'transfer';
  args: xdr.ScVal[];
};

function readError(contractId: string, method: string): Error {
  return new Error(`Could not read Soroswap ${method} from ${contractId}.`);
}

async function requiredRead(
  contractId: string,
  method: string,
  args: xdr.ScVal[] = [],
): Promise<unknown> {
  const value = await simulateRead(contractId, method, args);
  if (value === null) throw readError(contractId, method);
  return value;
}

function asInteger(value: unknown, contractId: string, method: string): bigint {
  if (typeof value === 'bigint' && value >= 0n) return value;
  if (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0) {
    return BigInt(value);
  }
  if (typeof value === 'string' && /^\d+$/.test(value)) return BigInt(value);
  throw readError(contractId, method);
}

function asDecimals(value: unknown, contractId: string, method: string): number {
  const decimals = asInteger(value, contractId, method);
  if (decimals > 18n) throw new Error(`Unsupported token precision reported by ${contractId}.`);
  return Number(decimals);
}

function asAddress(value: unknown, contractId: string, method: string): string {
  if (typeof value !== 'string' || !value) throw readError(contractId, method);
  return value;
}

function asPairNumbers(value: unknown, contractId: string): [bigint, bigint] {
  if (!Array.isArray(value) || value.length !== 2) throw readError(contractId, 'get_reserves');
  return [
    asInteger(value[0], contractId, 'get_reserves'),
    asInteger(value[1], contractId, 'get_reserves'),
  ];
}

function tokenId(asset: SwapAsset): string {
  const network = getNetwork();
  const checked = checkSwapAsset(asset, network.name);
  if (!checked.ok) throw new Error(checked.reason);
  return classicAsset(checked.asset).contractId(network.networkPassphrase);
}

export function parseLiquidityAmount(value: string, decimals = STELLAR_DECIMALS): bigint {
  const amount = parseUnits(value, decimals);
  if (amount <= 0n) throw new Error('Enter an amount greater than zero.');
  return amount;
}

function parseUnits(value: string, decimals: number): bigint {
  const trimmed = value.trim();
  const match = /^(0|[1-9]\d*)(?:\.(\d+))?$/.exec(trimmed);
  if (!match) throw new Error('Enter a valid positive amount.');
  const fraction = match[2] ?? '';
  if (fraction.length > decimals) {
    throw new Error(`Use no more than ${decimals} decimal places.`);
  }
  const scale = 10n ** BigInt(decimals);
  const amount = BigInt(match[1]!) * scale + BigInt(fraction.padEnd(decimals, '0') || '0');
  if (amount > I128_MAX) throw new Error('That amount is too large.');
  return amount;
}

export function formatLiquidityAmount(amount: bigint, decimals = STELLAR_DECIMALS): string {
  const scale = 10n ** BigInt(decimals);
  const whole = amount / scale;
  const fraction =
    decimals === 0
      ? ''
      : (amount % scale).toString().padStart(decimals, '0').replace(/0+$/, '');
  return fraction ? `${whole}.${fraction}` : whole.toString();
}

export function parseSlippagePercent(value: string): number {
  const trimmed = value.trim();
  const match = /^(0|[1-9]\d*)(?:\.(\d{1,2}))?$/.exec(trimmed);
  if (!match) throw new Error('Enter slippage as a percentage with up to 2 decimal places.');
  const whole = BigInt(match[1]!);
  const fraction = BigInt((match[2] ?? '').padEnd(2, '0') || '0');
  const bps = Number(whole * 100n + fraction);
  if (bps < MIN_LIQUIDITY_SLIPPAGE_BPS || bps > MAX_LIQUIDITY_SLIPPAGE_BPS) {
    throw new Error('Slippage must be between 0.10% and 5.00%.');
  }
  return bps;
}

export function minimumAmount(amount: bigint, slippageBps: number): bigint {
  if (
    !Number.isInteger(slippageBps) ||
    slippageBps < MIN_LIQUIDITY_SLIPPAGE_BPS ||
    slippageBps > MAX_LIQUIDITY_SLIPPAGE_BPS
  ) {
    throw new Error('Slippage must be between 10 and 500 basis points.');
  }
  const minimum = (amount * (BASIS_POINTS - BigInt(slippageBps))) / BASIS_POINTS;
  if (amount > 0n && minimum === 0n) {
    throw new Error('The amount is too small to set a non-zero minimum at this slippage tolerance.');
  }
  return minimum;
}

export function integerSquareRoot(value: bigint): bigint {
  if (value < 0n) throw new Error('Cannot take the square root of a negative amount.');
  if (value < 2n) return value;
  let x = value;
  let y = (x + 1n) >> 1n;
  while (y < x) {
    x = y;
    y = (x + value / x) >> 1n;
  }
  return x;
}

function supplyAfterProtocolFee(pair: SoroswapPairState): bigint {
  if (!pair.feesEnabled || pair.kLast === 0n) return pair.totalSupply;
  const rootK = integerSquareRoot(pair.reserveA * pair.reserveB);
  const rootKLast = integerSquareRoot(pair.kLast);
  if (rootK <= rootKLast) return pair.totalSupply;
  const feeLiquidity =
    (pair.totalSupply * (rootK - rootKLast)) / (5n * rootK + rootKLast);
  return pair.totalSupply + feeLiquidity;
}

function percent(numerator: bigint, denominator: bigint): string {
  const scaled = (numerator * 1_000_000n) / denominator;
  const whole = scaled / 10_000n;
  const fraction = (scaled % 10_000n).toString().padStart(4, '0');
  return `${whole}.${fraction}`;
}

export function estimateAddLiquidity(
  pair: SoroswapPairState,
  amountA: bigint,
  slippageBps: number,
): AddLiquidityEstimate {
  if (pair.reserveA <= 0n || pair.reserveB <= 0n || pair.totalSupply <= 0n) {
    throw new Error('This pool has no liquidity yet. First-liquidity deposits are not supported here.');
  }
  if (amountA <= 0n || amountA > I128_MAX) throw new Error('Enter a valid positive amount.');

  const amountB = (amountA * pair.reserveB) / pair.reserveA;
  if (amountB <= 0n) throw new Error('That amount is too small to add liquidity at this pool ratio.');
  if (amountB > I128_MAX) throw new Error('The required counter-amount is too large for Soroswap.');

  const supply = supplyAfterProtocolFee(pair);
  if (supply > I128_MAX) throw new Error('The pool supply is too large to estimate safely.');
  const liquidityA = (amountA * supply) / pair.reserveA;
  const liquidityB = (amountB * supply) / pair.reserveB;
  const liquidity = liquidityA < liquidityB ? liquidityA : liquidityB;
  if (liquidity <= 0n) throw new Error('That deposit would mint no LP tokens.');
  if (liquidity > I128_MAX) throw new Error('The estimated LP amount is too large for Soroswap.');

  return {
    amountA,
    amountB,
    minimumA: minimumAmount(amountA, slippageBps),
    minimumB: minimumAmount(amountB, slippageBps),
    liquidity,
    supplyAfterProtocolFee: supply,
    poolSharePercent: percent(liquidity, supply + liquidity),
  };
}

export function estimateRemoveLiquidity(
  pair: SoroswapPairState,
  liquidity: bigint,
  availableLiquidity: bigint,
  slippageBps: number,
): RemoveLiquidityEstimate {
  if (liquidity <= 0n) throw new Error('Enter an LP amount greater than zero.');
  if (liquidity > availableLiquidity) throw new Error('Not enough LP tokens in this account.');

  const supply = supplyAfterProtocolFee(pair);
  if (supply <= 0n) throw new Error('This pool has no LP token supply.');
  const amountA = (pair.balanceA * liquidity) / supply;
  const amountB = (pair.balanceB * liquidity) / supply;
  if (amountA <= 0n || amountB <= 0n) {
    throw new Error('That LP amount is too small to return both pool assets.');
  }

  return {
    liquidity,
    amountA,
    amountB,
    minimumA: minimumAmount(amountA, slippageBps),
    minimumB: minimumAmount(amountB, slippageBps),
  };
}

export async function readSoroswapPair(
  assetA: SwapAsset,
  assetB: SwapAsset,
): Promise<PairLookup> {
  const network = getNetwork();
  const route = swapRouteInput(assetA, assetB, network.name, network.networkPassphrase);
  if (!route.ok) throw new Error(route.reason);
  const factoryId = SOROSWAP_FACTORY_IDS[network.name];
  const pairArgs = [
    nativeToScVal(route.tokenIn, { type: 'address' }),
    nativeToScVal(route.tokenOut, { type: 'address' }),
  ];
  const exists = await requiredRead(factoryId, 'pair_exists', pairArgs);
  if (typeof exists !== 'boolean') throw readError(factoryId, 'pair_exists');
  if (!exists) return { kind: 'missing' };

  const pairId = asAddress(
    await requiredRead(factoryId, 'get_pair', pairArgs),
    factoryId,
    'get_pair',
  );
  return {
    kind: 'found',
    pair: await readSoroswapPairById(pairId, route.tokenIn, route.tokenOut),
  };
}

export async function readSoroswapPairById(
  pairId: string,
  tokenAId: string,
  tokenBId: string,
): Promise<SoroswapPairState> {
  const network = getNetwork();
  const factoryId = SOROSWAP_FACTORY_IDS[network.name];
  const [token0Value, token1Value, reservesValue, supplyValue, kLastValue, feesEnabledValue] =
    await Promise.all([
      requiredRead(pairId, 'token_0'),
      requiredRead(pairId, 'token_1'),
      requiredRead(pairId, 'get_reserves'),
      requiredRead(pairId, 'total_supply'),
      requiredRead(pairId, 'k_last'),
      requiredRead(factoryId, 'fees_enabled'),
    ]);

  const token0 = asAddress(token0Value, pairId, 'token_0');
  const token1 = asAddress(token1Value, pairId, 'token_1');
  const [reserve0, reserve1] = asPairNumbers(reservesValue, pairId);
  const isDirectOrder = tokenAId === token0 && tokenBId === token1;
  const isReverseOrder = tokenAId === token1 && tokenBId === token0;
  if (!isDirectOrder && !isReverseOrder) throw readError(pairId, 'token ordering');
  if (typeof feesEnabledValue !== 'boolean') throw readError(factoryId, 'fees_enabled');

  const [balance0Value, balance1Value, decimals0Value, decimals1Value, lpDecimalsValue] =
    await Promise.all([
      requiredRead(token0, 'balance', [nativeToScVal(pairId, { type: 'address' })]),
      requiredRead(token1, 'balance', [nativeToScVal(pairId, { type: 'address' })]),
      requiredRead(token0, 'decimals'),
      requiredRead(token1, 'decimals'),
      requiredRead(pairId, 'decimals'),
    ]);
  const balance0 = asInteger(balance0Value, token0, 'balance');
  const balance1 = asInteger(balance1Value, token1, 'balance');
  const decimals0 = asDecimals(decimals0Value, token0, 'decimals');
  const decimals1 = asDecimals(decimals1Value, token1, 'decimals');
  const lpDecimals = asDecimals(lpDecimalsValue, pairId, 'decimals');

  return {
    pairId,
    tokenAId,
    tokenBId,
    reserveA: isDirectOrder ? reserve0 : reserve1,
    reserveB: isDirectOrder ? reserve1 : reserve0,
    balanceA: isDirectOrder ? balance0 : balance1,
    balanceB: isDirectOrder ? balance1 : balance0,
    totalSupply: asInteger(supplyValue, pairId, 'total_supply'),
    kLast: asInteger(kLastValue, pairId, 'k_last'),
    feesEnabled: feesEnabledValue,
    decimalsA: isDirectOrder ? decimals0 : decimals1,
    decimalsB: isDirectOrder ? decimals1 : decimals0,
    lpDecimals,
  };
}

export async function readLpBalance(pairId: string, owner: string): Promise<bigint> {
  const value = await requiredRead(pairId, 'balance', [nativeToScVal(owner, { type: 'address' })]);
  return asInteger(value, pairId, 'balance');
}

export async function readLiquidityAssetBalance(
  owner: string,
  asset: SwapAsset,
): Promise<bigint> {
  const network = getNetwork();
  tokenId(asset);
  if (owner.startsWith('C')) {
    const server = new SorobanRpc.Server(network.rpcUrl);
    const sacAsset = asset.issuer ? new Asset(asset.code, asset.issuer) : Asset.native();
    const entry = await server.getSACBalance(owner, sacAsset, network.networkPassphrase);
    const amount = entry.balanceEntry?.amount;
    return amount ? BigInt(amount) : 0n;
  }

  const server = new Horizon.Server(network.horizonUrl);
  try {
    const account = await server.loadAccount(owner);
    const rows = account.balances as {
      asset_type: string;
      asset_code?: string;
      asset_issuer?: string;
      balance: string;
      selling_liabilities?: string;
    }[];
    const row = asset.issuer
      ? rows.find((item) => item.asset_code === asset.code && item.asset_issuer === asset.issuer)
      : rows.find((item) => item.asset_type === 'native');
    if (!row) return 0n;
    let available = parseUnits(row.balance, STELLAR_DECIMALS);
    if (row.selling_liabilities) {
      available -= parseUnits(row.selling_liabilities, STELLAR_DECIMALS);
    }
    if (!asset.issuer) {
      const subentriesValue = (account as unknown as { subentry_count?: number }).subentry_count ?? 0;
      if (!Number.isSafeInteger(subentriesValue) || subentriesValue < 0) {
        throw new Error('Could not read the spending account reserve.');
      }
      available -= (2n + BigInt(subentriesValue)) * 5_000_000n + FEE_BUFFER_STROOPS;
    }
    return available > 0n ? available : 0n;
  } catch (error) {
    const status = (error as { response?: { status?: number } })?.response?.status;
    if (status === 404 || (error instanceof Error && error.name === 'NotFoundError')) return 0n;
    throw error;
  }
}

export function buildAddLiquidityArgs(params: {
  assetA: string;
  assetB: string;
  amountA: bigint;
  amountB: bigint;
  minimumA: bigint;
  minimumB: bigint;
  recipient: string;
  deadline?: bigint;
}): LiquidityRouterArgs {
  return {
    method: 'add_liquidity',
    args: [
      nativeToScVal(params.assetA, { type: 'address' }),
      nativeToScVal(params.assetB, { type: 'address' }),
      nativeToScVal(params.amountA, { type: 'i128' }),
      nativeToScVal(params.amountB, { type: 'i128' }),
      nativeToScVal(params.minimumA, { type: 'i128' }),
      nativeToScVal(params.minimumB, { type: 'i128' }),
      nativeToScVal(params.recipient, { type: 'address' }),
      nativeToScVal(params.deadline ?? BigInt(Math.floor(Date.now() / 1000) + 300), { type: 'u64' }),
    ],
  };
}

export function buildRemoveLiquidityArgs(params: {
  assetA: string;
  assetB: string;
  liquidity: bigint;
  minimumA: bigint;
  minimumB: bigint;
  recipient: string;
  deadline?: bigint;
}): LiquidityRouterArgs {
  return {
    method: 'remove_liquidity',
    args: [
      nativeToScVal(params.assetA, { type: 'address' }),
      nativeToScVal(params.assetB, { type: 'address' }),
      nativeToScVal(params.liquidity, { type: 'i128' }),
      nativeToScVal(params.minimumA, { type: 'i128' }),
      nativeToScVal(params.minimumB, { type: 'i128' }),
      nativeToScVal(params.recipient, { type: 'address' }),
      nativeToScVal(params.deadline ?? BigInt(Math.floor(Date.now() / 1000) + 300), { type: 'u64' }),
    ],
  };
}

export function buildPairTokenTransferArgs(params: {
  from: string;
  to: string;
  amount: bigint;
}): LiquidityRouterArgs {
  return {
    method: 'transfer',
    args: [
      nativeToScVal(params.from, { type: 'address' }),
      nativeToScVal(params.to, { type: 'address' }),
      nativeToScVal(params.amount, { type: 'i128' }),
    ],
  };
}

export function soroswapRouterId(): string {
  return ROUTER_IDS[getNetwork().name];
}

export function slippageFailureMessage(error: unknown): string | null {
  const message = error instanceof Error ? error.message : String(error);
  if (
    /Error\(Contract,\s*#(?:505|506)\)/i.test(message) ||
    /InsufficientAAmount|InsufficientBAmount/i.test(message)
  ) {
    return 'The pool moved beyond your slippage limit. No worse trade was accepted. Refresh the quote and try again.';
  }
  return null;
}
