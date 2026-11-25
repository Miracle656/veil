import AsyncStorage from '@react-native-async-storage/async-storage';
import {
  Account,
  Address,
  BASE_FEE,
  Contract,
  Operation,
  TransactionBuilder,
  nativeToScVal,
  rpc as SorobanRpc,
  scValToNative,
  xdr,
} from '@stellar/stellar-sdk';

import { assertValidContractAddress } from '../config/defindex';
import { getNetwork } from './network';
import { inclusionFee } from './fees';
import { rejectionFromResult } from './networkErrors';
import { registerPasskeySigner } from './passkey';
import { pollForResult } from './sendPayment';
import { signXdrPayload } from './walletConnect';
import { getFeePayerAddress } from './activity';

export const STROOPS_PER_UNIT = 10_000_000n;
const STRATEGY_STORAGE_PREFIX = 'veil_defindex_strategies_';

export interface StrategyAllocation {
  address: string;
  name: string;
  amount: bigint;
  paused: boolean;
  percentage: number; // 0 to 100
}

export interface DefindexVaultState {
  vaultAddress: string;
  name: string;
  symbol: string;
  manager: string;
  emergencyManager: string;
  rebalanceManager: string;
  vaultFeeBps: number;
  veilFeeBps: number;
  defindexProtocolFeeRate: number;
  totalSupply: bigint;
  totalAmount: bigint;
  idleAmount: bigint;
  investedAmount: bigint;
  sharePrice: number; // underlying units per share
  strategies: StrategyAllocation[];
  singleStrategyNotice: string | null;
  isPaused: boolean;
  isEmptied: boolean;
  driftDetected: boolean;
  previousStrategies?: string[];
}

export interface DefindexUserPosition {
  shares: bigint;
  sharesFormatted: string;
  underlyingAmount: bigint;
  underlyingFormatted: string;
  sharePrice: number;
  vaultAddress: string;
  userAddress: string;
}

/** Formats stroops into human-readable decimal string (7 decimals). */
export function formatStroops(stroops: bigint, decimals = 4): string {
  const isNegative = stroops < 0n;
  const abs = isNegative ? -stroops : stroops;
  const whole = abs / STROOPS_PER_UNIT;
  const frac = (abs % STROOPS_PER_UNIT).toString().padStart(7, '0');
  const num = Number(`${whole}.${frac}`);
  return `${isNegative ? '-' : ''}${num.toLocaleString('en-US', {
    minimumFractionDigits: 2,
    maximumFractionDigits: decimals,
  })}`;
}

/** Parses user input string (e.g. "12.345") to BigInt stroops. */
export function parseToStroops(amountStr: string): bigint {
  const trimmed = amountStr.trim();
  if (!trimmed || !/^\d+(?:\.\d{0,7})?$/.test(trimmed)) {
    throw new Error('Enter a valid amount with no more than 7 decimal places.');
  }
  const [whole, fraction = ''] = trimmed.split('.');
  const stroops = BigInt(whole) * STROOPS_PER_UNIT + BigInt(fraction.padEnd(7, '0'));
  if (stroops <= 0n) {
    throw new Error('Amount must be greater than zero.');
  }
  return stroops;
}

/** Format basis points to percentage display (e.g. 1809 -> "18.09%"). */
export function formatBps(bps: number): string {
  return `${(bps / 100).toFixed(2)}%`;
}

/**
 * Checks whether current active strategies differ from previously seen strategies.
 */
export function detectStrategyDrift(
  previousStrategies: string[],
  currentStrategies: string[],
): boolean {
  if (!previousStrategies || previousStrategies.length === 0) return false;
  if (previousStrategies.length !== currentStrategies.length) return true;
  const prevSorted = [...previousStrategies].sort();
  const currSorted = [...currentStrategies].sort();
  return prevSorted.some((addr, i) => addr !== currSorted[i]);
}

/**
 * Loads the previously saved strategies from storage.
 */
export async function getSavedStrategies(vaultAddress: string): Promise<string[] | null> {
  try {
    const raw = await AsyncStorage.getItem(`${STRATEGY_STORAGE_PREFIX}${vaultAddress}`);
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

/**
 * Persists the current strategies to storage.
 */
export async function saveCurrentStrategies(
  vaultAddress: string,
  strategies: string[],
): Promise<void> {
  try {
    await AsyncStorage.setItem(
      `${STRATEGY_STORAGE_PREFIX}${vaultAddress}`,
      JSON.stringify(strategies),
    );
  } catch {
    // Non-fatal if storage fails
  }
}

/**
 * Reads vault state live from Soroban RPC.
 */
export async function loadDefindexVaultState(
  vaultAddressInput: string,
  customRpcUrl?: string,
  customNetworkPassphrase?: string,
): Promise<DefindexVaultState> {
  const vaultAddress = assertValidContractAddress(vaultAddressInput);
  const network = getNetwork();
  const rpcUrl = customRpcUrl || network.rpcUrl;
  const networkPassphrase = customNetworkPassphrase || network.networkPassphrase;
  const server = new SorobanRpc.Server(rpcUrl);
  const contract = new Contract(vaultAddress);

  // Read-only calls run as a zero-sequence transaction against a dummy source
  const dummyAccount = new Account('GAYBFYMAQU7GSHSHNX7RBUE2KSSRQBME7XHP5BONAVKXI5BSUOQXTWPL', '0');

  async function simulateCall(method: string, ...args: xdr.ScVal[]): Promise<any> {
    const tx = new TransactionBuilder(dummyAccount, {
      fee: BASE_FEE,
      networkPassphrase,
    })
      .addOperation(contract.call(method, ...args))
      .setTimeout(30)
      .build();

    const sim = await server.simulateTransaction(tx);
    const anySim = sim as any;
    if (!anySim.result) {
      throw new Error(`Simulation failed for ${method}: ${anySim.error || 'Unknown error'}`);
    }
    return scValToNative(anySim.result.retval);
  }

  // Fetch core metadata in parallel
  const [
    manager,
    emergencyManager,
    rebalanceManager,
    fees,
    assetsRaw,
    fundsRaw,
    totalSupplyRaw,
  ] = await Promise.all([
    simulateCall('get_manager').catch(() => ''),
    simulateCall('get_emergency_manager').catch(() => ''),
    simulateCall('get_rebalance_manager').catch(() => ''),
    simulateCall('get_fees').catch(() => [0, 0]),
    simulateCall('get_assets').catch(() => []),
    simulateCall('fetch_total_managed_funds').catch(() => []),
    simulateCall('total_supply').catch(() => 0n),
  ]);

  const vaultFeeBps = Number(Array.isArray(fees) ? fees[0] ?? 0 : 0);
  const defindexProtocolFeeRate = Number(Array.isArray(fees) ? fees[1] ?? 0 : 0);
  const totalSupply = BigInt(totalSupplyRaw ?? 0n);

  // Strategy names map from get_assets
  const strategyNames = new Map<string, string>();
  if (Array.isArray(assetsRaw)) {
    for (const assetEntry of assetsRaw) {
      if (assetEntry?.strategies && Array.isArray(assetEntry.strategies)) {
        for (const st of assetEntry.strategies) {
          if (st?.address) {
            strategyNames.set(st.address, st.name || '');
          }
        }
      }
    }
  }

  // Parse funds
  let totalAmount = 0n;
  let idleAmount = 0n;
  let investedAmount = 0n;
  const strategies: StrategyAllocation[] = [];

  if (Array.isArray(fundsRaw) && fundsRaw.length > 0) {
    const firstAssetFunds = fundsRaw[0];
    totalAmount = BigInt(firstAssetFunds?.total_amount ?? 0n);
    idleAmount = BigInt(firstAssetFunds?.idle_amount ?? 0n);
    investedAmount = BigInt(firstAssetFunds?.invested_amount ?? 0n);

    if (Array.isArray(firstAssetFunds?.strategy_allocations)) {
      for (const sa of firstAssetFunds.strategy_allocations) {
        const address = sa.strategy_address || '';
        const amount = BigInt(sa.amount ?? 0n);
        const paused = Boolean(sa.paused);
        const name =
          strategyNames.get(address) ||
          (address.startsWith('CDB2WMKQ')
            ? 'USDC Autocompound Blend Fixed'
            : address.startsWith('CCSRX5E4')
              ? 'USDC Autocompound Blend YieldBlox'
              : `Strategy ${address.slice(0, 6)}…`);

        const percentage =
          investedAmount > 0n
            ? Number((amount * 10000n) / investedAmount) / 100
            : 0;

        strategies.push({
          address,
          name,
          amount,
          paused,
          percentage,
        });
      }
    }
  }

  // Share price calculation (underlying units per share)
  let sharePrice = 1.0;
  if (totalSupply > 0n && totalAmount > 0n) {
    sharePrice = Number(totalAmount) / Number(totalSupply);
  }

  // Single strategy detection: if only 1 strategy has funds or only 1 strategy exists
  const activeStrategies = strategies.filter((s) => s.amount > 0n);
  let singleStrategyNotice: string | null = null;
  if (activeStrategies.length === 1) {
    const active = activeStrategies[0];
    const poolName = active.name.includes('Blend Fixed')
      ? 'Blend USDC Fixed pool'
      : active.name;
    singleStrategyNotice = `Single strategy: ${poolName}`;
  } else if (strategies.length === 1) {
    singleStrategyNotice = `Single strategy: ${strategies[0].name}`;
  }

  // Paused status: true if all strategies are paused or no strategies can accept funds
  const isPaused =
    strategies.length > 0 && strategies.every((s) => s.paused);

  // Emptied status
  const isEmptied = totalAmount === 0n && totalSupply === 0n;

  // Check strategy drift against previously saved strategies
  const currentStrategyAddresses = strategies.map((s) => s.address);
  const previousStrategies = (await getSavedStrategies(vaultAddress)) ?? undefined;
  const driftDetected = detectStrategyDrift(
    previousStrategies ?? [],
    currentStrategyAddresses,
  );

  return {
    vaultAddress,
    name: 'DeFindex USDC Vault',
    symbol: 'dfUSDC',
    manager,
    emergencyManager,
    rebalanceManager,
    vaultFeeBps,
    veilFeeBps: 0, // Veil protocol fee is 0 bps
    defindexProtocolFeeRate,
    totalSupply,
    totalAmount,
    idleAmount,
    investedAmount,
    sharePrice,
    strategies,
    singleStrategyNotice,
    isPaused,
    isEmptied,
    driftDetected,
    previousStrategies,
  };
}

/**
 * Loads the user's position in the DeFindex vault.
 */
export async function loadDefindexUserPosition(
  vaultAddressInput: string,
  userAddress: string,
  customRpcUrl?: string,
  customNetworkPassphrase?: string,
): Promise<DefindexUserPosition> {
  const vaultAddress = assertValidContractAddress(vaultAddressInput);
  const network = getNetwork();
  const rpcUrl = customRpcUrl || network.rpcUrl;
  const networkPassphrase = customNetworkPassphrase || network.networkPassphrase;
  const server = new SorobanRpc.Server(rpcUrl);
  const contract = new Contract(vaultAddress);

  const dummyAccount = new Account('GAYBFYMAQU7GSHSHNX7RBUE2KSSRQBME7XHP5BONAVKXI5BSUOQXTWPL', '0');

  // Query user share balance via SEP-41 balance(id: Address)
  const balanceTx = new TransactionBuilder(dummyAccount, {
    fee: BASE_FEE,
    networkPassphrase,
  })
    .addOperation(
      contract.call('balance', nativeToScVal(userAddress, { type: 'address' })),
    )
    .setTimeout(30)
    .build();

  const balanceSim = (await server.simulateTransaction(balanceTx)) as any;
  const sharesRaw = balanceSim.result ? scValToNative(balanceSim.result.retval) : 0n;
  const shares = BigInt(sharesRaw ?? 0n);

  if (shares <= 0n) {
    return {
      shares: 0n,
      sharesFormatted: '0.00',
      underlyingAmount: 0n,
      underlyingFormatted: '0.00',
      sharePrice: 1.0,
      vaultAddress,
      userAddress,
    };
  }

  // Query exact underlying asset amount via get_asset_amounts_per_shares(shares)
  let underlyingAmount = 0n;
  let sharePrice = 1.0;
  try {
    const valueTx = new TransactionBuilder(dummyAccount, {
      fee: BASE_FEE,
      networkPassphrase,
    })
      .addOperation(
        contract.call(
          'get_asset_amounts_per_shares',
          nativeToScVal(shares, { type: 'i128' }),
        ),
      )
      .setTimeout(30)
      .build();

    const valueSim = (await server.simulateTransaction(valueTx)) as any;
    if (valueSim.result) {
      const amounts = scValToNative(valueSim.result.retval);
      if (Array.isArray(amounts) && amounts.length > 0) {
        underlyingAmount = BigInt(amounts[0] ?? 0n);
        sharePrice = Number(underlyingAmount) / Number(shares);
      }
    }
  } catch {
    underlyingAmount = shares; // Fallback 1:1 if RPC fails
  }

  return {
    shares,
    sharesFormatted: formatStroops(shares),
    underlyingAmount,
    underlyingFormatted: formatStroops(underlyingAmount),
    sharePrice,
    vaultAddress,
    userAddress,
  };
}

/**
 * Builds an unsigned transaction XDR for depositing into the DeFindex vault.
 *
 * Calls `vault.deposit(amounts_desired: Vec<i128>, amounts_min: Vec<i128>, from: Address, invest: bool)`
 */
export async function buildDefindexDepositXdr(options: {
  vaultAddress: string;
  userAddress: string;
  amountStroops: bigint;
  minShares?: bigint;
  invest?: boolean;
}): Promise<string> {
  const vaultAddress = assertValidContractAddress(options.vaultAddress);
  const network = getNetwork();
  const server = new SorobanRpc.Server(network.rpcUrl);

  const feePayer = await getFeePayerAddress();
  if (!feePayer) throw new Error('No fee-payer key on this device.');
  const account = await server.getAccount(feePayer);

  const contract = new Contract(vaultAddress);
  const amountsDesired = xdr.ScVal.scvVec([
    nativeToScVal(options.amountStroops, { type: 'i128' }),
  ]);
  const amountsMin = xdr.ScVal.scvVec([
    nativeToScVal(options.minShares ?? 0n, { type: 'i128' }),
  ]);
  const from = nativeToScVal(options.userAddress, { type: 'address' });
  const invest = nativeToScVal(options.invest ?? true, { type: 'bool' });

  const unsigned = new TransactionBuilder(account, {
    fee: inclusionFee(),
    networkPassphrase: network.networkPassphrase,
  })
    .addOperation(contract.call('deposit', amountsDesired, amountsMin, from, invest))
    .setTimeout(60)
    .build();

  return unsigned.toXDR();
}

/**
 * Builds an unsigned transaction XDR for withdrawing from the DeFindex vault.
 *
 * Calls `vault.withdraw(withdraw_shares: i128, min_amounts_out: Vec<i128>, from: Address)`
 */
export async function buildDefindexWithdrawXdr(options: {
  vaultAddress: string;
  userAddress: string;
  shareAmountStroops: bigint;
  minAmountsOut?: bigint;
}): Promise<string> {
  const vaultAddress = assertValidContractAddress(options.vaultAddress);
  const network = getNetwork();
  const server = new SorobanRpc.Server(network.rpcUrl);

  const feePayer = await getFeePayerAddress();
  if (!feePayer) throw new Error('No fee-payer key on this device.');
  const account = await server.getAccount(feePayer);

  const contract = new Contract(vaultAddress);
  const withdrawShares = nativeToScVal(options.shareAmountStroops, { type: 'i128' });
  const minAmountsOut = xdr.ScVal.scvVec([
    nativeToScVal(options.minAmountsOut ?? 0n, { type: 'i128' }),
  ]);
  const from = nativeToScVal(options.userAddress, { type: 'address' });

  const unsigned = new TransactionBuilder(account, {
    fee: inclusionFee(),
    networkPassphrase: network.networkPassphrase,
  })
    .addOperation(contract.call('withdraw', withdrawShares, minAmountsOut, from))
    .setTimeout(60)
    .build();

  return unsigned.toXDR();
}

/**
 * Executes a DeFindex transaction through the existing signing path (`signXdrPayload`).
 *
 * Veil's __check_auth ceremony needs six non-obvious things together:
 * 1. Fee payer source account
 * 2. Inclusion fee & network passphrase
 * 3. Typed ScVal invocation
 * 4. Recording-mode simulate via Soroban RPC
 * 5. Preimage generation & passkey WebAuthn signature attached to Soroban address credentials
 * 6. Enforce-mode re-simulate & fee-payer signing & submission
 *
 * Sign through `signXdrPayload` in `frontend/mobile/lib/walletConnect.ts` to
 * ensure 100% adherence to Veil's signing pipeline.
 */
export async function submitDefindexTransaction(unsignedXdr: string): Promise<string> {
  const network = getNetwork();
  const server = new SorobanRpc.Server(network.rpcUrl);

  // Register passkey signer to answer Soroban address credential auth requests
  const unregister = registerPasskeySigner();
  try {
    const signedXdr = await signXdrPayload(unsignedXdr);
    const signedTx = TransactionBuilder.fromXDR(signedXdr, network.networkPassphrase);
    const sendResult = await server.sendTransaction(signedTx);
    if (sendResult.status === 'ERROR') {
      throw new Error(rejectionFromResult(sendResult.errorResult));
    }
    return await pollForResult(server, sendResult.hash);
  } finally {
    unregister();
  }
}
