import { Address } from '@stellar/stellar-sdk';

const STROOPS_PER_XLM = 10_000_000n;

export interface VaultConfig {
  owner: string;
  token: string;
  delaySeconds: number;
}

export interface VaultWithdrawal {
  id: number;
  to: string;
  amountStroops: bigint;
  amountXlm: string;
  queuedAt: number;
  unlockAt: number;
  cancelled: boolean;
  executed: boolean;
}

export interface VaultDetails {
  contractId: string;
  config: VaultConfig;
  balanceStroops: bigint;
  balanceXlm: string;
  reservedStroops: bigint;
  reservedXlm: string;
  availableStroops: bigint;
  availableXlm: string;
  withdrawals: VaultWithdrawal[];
}

/** Result of a submitted vault transaction. */
export type VaultTxResult = {
  hash: string;
};

/**
 * Injected submitter for vault contract calls. Mobile has no passkey / session
 * signing infrastructure ported yet, so the screen supplies a stub today and a
 * real implementation (device key, WalletConnect, etc.) can be swapped in later
 * without touching this file.
 */
export type VaultSubmit = (call: {
  method: 'deploy' | 'deposit' | 'queue_withdrawal' | 'cancel_withdrawal' | 'execute_withdrawal';
  contractId?: string;
  params: Record<string, unknown>;
}) => Promise<VaultTxResult>;

/** Injected reader for vault contract state. The screen supplies a stub or a
 * real Soroban RPC-backed implementation. */
export type VaultFetch = (contractId: string) => Promise<VaultDetails>;

export function xlmToStroops(value: string): bigint {
  const amount = value.trim();
  if (!/^\d+(?:\.\d{0,7})?$/.test(amount)) {
    throw new Error('Enter a valid XLM amount with no more than 7 decimal places.');
  }

  const [whole, fraction = ''] = amount.split('.');
  const stroops = BigInt(whole) * STROOPS_PER_XLM + BigInt(fraction.padEnd(7, '0'));

  if (stroops <= 0n) {
    throw new Error('Amount must be greater than zero.');
  }
  return stroops;
}

export function stroopsToXlm(stroops: bigint): string {
  const negative = stroops < 0n;
  const absolute = negative ? -stroops : stroops;
  const whole = absolute / STROOPS_PER_XLM;
  const fraction = (absolute % STROOPS_PER_XLM)
    .toString()
    .padStart(7, '0')
    .replace(/0+$/, '');
  return `${negative ? '-' : ''}${whole}${fraction ? `.${fraction}` : ''}`;
}

export function validateStellarAddress(value: string): string {
  const address = value.trim();
  try {
    Address.fromString(address);
  } catch {
    throw new Error('Enter a valid Stellar G... or C... address.');
  }
  return address;
}

export function formatDelay(seconds: number): string {
  if (seconds % 86_400 === 0) {
    const days = seconds / 86_400;
    return `${days} day${days === 1 ? '' : 's'}`;
  }
  if (seconds % 3_600 === 0) {
    const hours = seconds / 3_600;
    return `${hours} hour${hours === 1 ? '' : 's'}`;
  }
  return `${seconds.toLocaleString()} seconds`;
}

export function formatTimestamp(timestamp: number): string {
  return new Date(timestamp * 1_000).toLocaleString();
}

export function formatCountdown(unlockAt: number, now: number): string {
  const remaining = Math.max(0, unlockAt - now);
  if (remaining === 0) return 'Ready to execute';

  const days = Math.floor(remaining / 86_400);
  const hours = Math.floor((remaining % 86_400) / 3_600);
  const minutes = Math.floor((remaining % 3_600) / 60);
  const seconds = remaining % 60;

  if (days > 0) return `${days}d ${hours}h ${minutes}m`;
  if (hours > 0) return `${hours}h ${minutes}m ${seconds}s`;
  return `${minutes}m ${seconds}s`;
}

export function withdrawalStatus(withdrawal: VaultWithdrawal, now: number): string {
  if (withdrawal.executed) return 'Executed';
  if (withdrawal.cancelled) return 'Cancelled';
  if (now >= withdrawal.unlockAt) return 'Ready';
  return 'Time-locked';
}

export function isWithdrawalPending(withdrawal: VaultWithdrawal): boolean {
  return !withdrawal.cancelled && !withdrawal.executed;
}

export function isWithdrawalReady(withdrawal: VaultWithdrawal, now: number): boolean {
  return isWithdrawalPending(withdrawal) && now >= withdrawal.unlockAt;
}

/** Validate and normalize a whole-number withdrawal delay expressed in a given unit. */
export function parseDelaySeconds(value: string, unit: 'hours' | 'days'): number {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new Error('Enter a positive whole-number withdrawal delay.');
  }
  const multiplier = unit === 'days' ? 86_400 : 3_600;
  return parsed * multiplier;
}

/**
 * Deploy and initialize a new vault. Actual contract deployment and signing is
 * delegated to `submit` (see `VaultSubmit`).
 */
export async function deployAndInitializeVault(
  params: { delaySeconds: number },
  submit: VaultSubmit,
): Promise<string> {
  if (!Number.isSafeInteger(params.delaySeconds) || params.delaySeconds <= 0) {
    throw new Error('Withdrawal delay must be a positive whole number of seconds.');
  }

  const result = await submit({
    method: 'deploy',
    params: { delaySeconds: params.delaySeconds },
  });
  return result.hash;
}

export async function depositToVault(
  params: { contractId: string; amountXlm: string },
  submit: VaultSubmit,
): Promise<VaultTxResult> {
  const contractId = validateStellarAddress(params.contractId);
  const amountStroops = xlmToStroops(params.amountXlm);

  return submit({
    method: 'deposit',
    contractId,
    params: { amountStroops },
  });
}

export async function queueVaultWithdrawal(
  params: { contractId: string; to: string; amountXlm: string },
  submit: VaultSubmit,
): Promise<VaultTxResult> {
  const contractId = validateStellarAddress(params.contractId);
  const to = validateStellarAddress(params.to);
  const amountStroops = xlmToStroops(params.amountXlm);

  return submit({
    method: 'queue_withdrawal',
    contractId,
    params: { to, amountStroops },
  });
}

export async function cancelVaultWithdrawal(
  params: { contractId: string; withdrawalId: number },
  submit: VaultSubmit,
): Promise<VaultTxResult> {
  const contractId = validateStellarAddress(params.contractId);

  return submit({
    method: 'cancel_withdrawal',
    contractId,
    params: { withdrawalId: params.withdrawalId },
  });
}

export async function executeVaultWithdrawal(
  params: { contractId: string; withdrawalId: number },
  submit: VaultSubmit,
): Promise<VaultTxResult> {
  const contractId = validateStellarAddress(params.contractId);

  return submit({
    method: 'execute_withdrawal',
    contractId,
    params: { withdrawalId: params.withdrawalId },
  });
}

/** Fetch vault details via the injected reader. Kept as a thin wrapper so the
 * screen has one call site regardless of whether `fetchDetails` talks to
 * Soroban RPC directly or goes through a backend proxy. */
export async function fetchVaultDetails(
  contractId: string,
  fetchDetails: VaultFetch,
): Promise<VaultDetails> {
  return fetchDetails(validateStellarAddress(contractId));
}
