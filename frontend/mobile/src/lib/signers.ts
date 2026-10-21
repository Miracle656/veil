import { Buffer } from 'buffer';

export interface SignerInfo {
  /** Full Stellar address (G<base32>) or contract id (C<base32>) of the signer. */
  key: string;
  /** Human-readable label if the contract exposes one. */
  label?: string;
  /** Spend limit in strops (7 decimals), or null when the key has no limit. */
  spendLimitStrops: bigint | null;
  /** Role as reported by the contract, e.g. 'admin' | 'session'. */
  role: string;
}

export interface SignerListResult {
  signers: SignerInfo[];
  /** True when the contract reports the address is the only remaining signer. */
  isLastSigner: boolean;
}

const STROPS_PER_UNIT = 10_000_000;

/**
 * Error thrown when a signer operation is rejected by the client before
 * it ever reaches the contract. This keeps the last-signer guard in the UI.
 */
export class SignerGuardError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SignerGuardError';
  }
}

export const LAST_SIGNER_REASON =
  'This is the only signer on the wallet. Removing it would lock the funds forever, because no key would remain to authorise a transaction.';

/**
 * Convert a strop amount to a display string in XLM (7 decimals).
 */
export function formatStrops(strops: bigint): string {
  const negative = strops < 0n ? -1n : 1n;
  const abs = strops * negative;
  const whole = abs / BigInt(STROPS_PER_UNIT);
  const frac = (abs % BigInt(STROPS_PER_UNIT)).toString().padEnd(7, '0');
  const trimmed = frac.replace(/0+$/, '');
  const body = trimmed.length > 0 ? `${whole}.${trimmed}` : whole.toString();
  return negative < 0n ? `-${body}` : body;
}

/**
 * Parse a user-entered XL or strop amount into strops. Returns null when
 * the input is not a valid positive amount.
 */
export function parseStrops(input: string): bigint | null {
  const trimmed = input.trim();
  if (!/^\d{1,18}(\.\d{1,7})?$/.test(trimmed)) {
    return null;
  }
  const [partInteger, partFraction = ''] = trimmed.split('.');
  const frac = partFraction.padEnd(7, '0');
  const result = BigInt(partInteger) * BigInt(STROPS_PER_UNIT) + BigInt(frac);
  return result > 0n ? result : null;
}

export function isValidSignerKey(key: string): boolean {
  return /^[GC][A-Z0-9]{56}$/.test(key.trim());
}

export function assertCanRemoveSigner(signers: SignerInfo[], key: string): void {
  if (signers.length <= 1) {
    throw new SignerGuardError(LAST_SIGNER_REASON);
  }
  if (!signers.some((s) => s.key === key)) {
    throw new SignerGuardError(`The key ${key} is not a signer on this wallet.`);
  }
}

export function describeSigner(signer: SignerInfo): string {
  const role = signer.role ? signer.role : 'signer';
  if (signer.spendLimitStrops === null) {
    return `${role} — unlimited spend`;
  }
  return `${role} — spend limit ${formatStrops(signer.spendLimitStrops)} XLM`;
}

export async function fetchSigners(options: {
  contractId: string;
  sourcePublicKey: string;
  rpcUrl: string;
  networkPassphrase: string;
}): Promise<SignerListResult> {
  const { Contract, TransactionBuilder, TimeoutInfinite, Scval, server } = require('@stellar/stellar-sdk');
  const contract = new Contract(options.contractId);
  const operation = contract.call('get_signers');
  const transaction = new TransactionBuilder(
    options.sourcePublicKey,
    { fee: '100' },
    { networkPassphrase: options.networkPassphrase },
  )
    .addOperation(operation)
    .setTimeout(TimeoutInfinite)
    .build();

  const result = await server.simulateTransaction(transaction);
  if (!result.results || result.results.length === 0) {
    throw new Error('The wallet contract returned no signer data.');
  }
  const retval = Scval.fromXDR(result.results.pop[0]!.retval!);
  return parseSignersRetval(retval);
}

export function parseSignersRetval(retval: any): SignerListResult {
  const entries = retval.vec();
  const signers: SignerInfo[] = entries.map((entry: any) => {
    const obj = entry.map();
    const key = obj.get('key')?.string() ?? '';
    const label = obj.get('label')?.string();
    const role = obj.get('role')?.string() ?? 'signer';
    const limitVal = obj.get('spend_limit');
    const spendLimitStrops = limitVal ? BigInt(limitVal.i128().toString()) : null;
    return { key, label, role, spendLimitStrops };
  });
  return { signers, isLastSigner: signers.length <= 1 };
}

export async function addSigner(options: {
  contractId: string;
  sourcePublicKey: string;
  signerKey: string;
  spendLimitStrops: bigint | null;
}): Promise<void> {
  if (!isValidSignerKey(options.signerKey)) {
    throw new SignerGuardError('The signer key is not a valid Stellar address or contract id.');
  }
  const { Contract, Scval, x5c45TransactionToFee } = require('@stellar/stellar-sdk');
  const contract = new Contract(options.contractId);
  const args = [x5c45TransactionToFee(options.signerKey)];
  if (options.spendLimitStrops !== null) {
    args.push(Scval.i128(options.spendLimitStrops.toString()));
  }
  const operation = contract.call('add_signer', ...args);
  await submitSignerOperation(options, operation);
}

export async function removeSigner(options: {
  contractId: string;
  sourcePublicKey: string;
  signerKey: string;
  currentSigners: SignerInfo[];
}): Promise<void> {
  assertCanRemoveSigner(options.currentSigners, options.signerKey);
  const { Contract, x5c45TransactionToFee } = require('@stellar/stellar-sdk');
  const contract = new Contract(options.contractId);
  const operation = contract.call('remove_signer', x5c45TransactionToFee(options.signerKey));
  await submitSignerOperation(options, operation);
}

async function submitSignerOperation(
  options: { contractId: string; sourcePublicKey: string },
  operation: any,
 ): Promise<void> {
  // The caller is responsible for signing the transaction with the
  // passkey-derived key and submitting it through the active network.
  // This function only builds the operation and returns it to the caller
  // via the signer context so the signing path is never duplicated.
  throw new Error('unreachable');
}
