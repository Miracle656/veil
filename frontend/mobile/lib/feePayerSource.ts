import AsyncStorage from '@react-native-async-storage/async-storage';
import { Horizon, Keypair } from '@stellar/stellar-sdk';
import { Buffer } from 'buffer';

import { deriveFeePayerKeypair } from './deriveFeePayer';
import { getNetwork, getNetworkName } from './network';
import { evaluatePrf } from './passkey';
import { getPasskeyId, getSignerSecret, getWalletAddress } from './walletStore';

/**
 * How this device's fee-payer (the classic G… account that signs and pays the
 * network fee for every smart-wallet transaction) came to be — the mobile
 * counterpart of the web wallet's fee-payer mode, shown on the fee-payer
 * settings screen (#829).
 *
 * The distinction matters most in one direction: a **random** fee-payer cannot
 * be re-derived from the passkey on another device, so a wallet recovered
 * elsewhere starts with a different, empty fee-payer and fails its first
 * transaction for want of gas. The screen has to say so plainly.
 */
export type FeePayerSource =
  /** Seeded from the passkey's WebAuthn PRF output — reproducible from the passkey. */
  | 'prf'
  /** A random keypair, used when the passkey gave no PRF output. Not reproducible. */
  | 'random'
  /** Derived from the (non-secret) passkey credential id — the pre-PRF scheme. */
  | 'credential-id'
  /** A keypair-mode testnet wallet: the fee-payer is the wallet account itself. */
  | 'keypair'
  /** Set up before the source was recorded, and not identifiable without a prompt. */
  | 'unknown';

/** Same PRF salt the fee-payer is derived with everywhere else (SDK constant). */
const FEE_PAYER_PRF_SALT = new Uint8Array(new TextEncoder().encode('invisible-wallet/prf/feepayer/v1'));

/**
 * AsyncStorage key for the record, namespaced per network like the rest of the
 * wallet identifiers. It holds a public key and a label — nothing secret.
 */
const SOURCE_KEY = 'veil_fee_payer_source';

type SourceRecord = { address: string; source: 'prf' | 'random' };

function storageKey(): string {
  return getNetworkName() === 'mainnet' ? `${SOURCE_KEY}_mainnet` : SOURCE_KEY;
}

/**
 * Remember how the fee-payer `address` was derived. Called wherever the app
 * sets the fee-payer secret. The record is keyed to the address, so a later
 * key change (a retried PRF binding, a reset) can never inherit a stale label.
 *
 * Best-effort: failing to write a display label must never fail the wallet
 * operation that called it.
 */
export async function recordFeePayerSource(address: string, source: 'prf' | 'random'): Promise<void> {
  const record: SourceRecord = { address, source };
  try {
    await AsyncStorage.setItem(storageKey(), JSON.stringify(record));
  } catch {
    // A missing label degrades the screen to "not recorded"; nothing else.
  }
}

async function readRecord(): Promise<SourceRecord | null> {
  try {
    const raw = await AsyncStorage.getItem(storageKey());
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<SourceRecord>;
    if (typeof parsed.address !== 'string') return null;
    if (parsed.source !== 'prf' && parsed.source !== 'random') return null;
    return { address: parsed.address, source: parsed.source };
  } catch {
    return null;
  }
}

export type FeePayerInfo = {
  /** The fee-payer's G… address. */
  address: string;
  source: FeePayerSource;
};

/**
 * The active fee-payer and how it was derived, or null when this network has
 * no wallet. Never prompts: a recorded source is used when it names the current
 * fee-payer, then the checks that need no passkey; anything left is `unknown`,
 * which {@link verifyFeePayerWithPasskey} can settle on request.
 */
export async function getFeePayerInfo(): Promise<FeePayerInfo | null> {
  const secret = await getSignerSecret().catch(() => null);
  if (!secret) return null;
  let address: string;
  try {
    address = Keypair.fromSecret(secret).publicKey();
  } catch {
    return null;
  }

  const record = await readRecord();
  if (record && record.address === address) return { address, source: record.source };

  const [walletAddress, keyId] = await Promise.all([
    getWalletAddress().catch(() => null),
    getPasskeyId().catch(() => null),
  ]);
  if (walletAddress === address) return { address, source: 'keypair' };
  if (keyId) {
    try {
      if (deriveFeePayerKeypair(keyId).publicKey() === address) return { address, source: 'credential-id' };
    } catch {
      // A malformed credential id simply is not a match.
    }
  }
  return { address, source: 'unknown' };
}

export type PasskeyVerification =
  | { ok: true; source: 'prf' | 'random' }
  | { ok: false; reason: 'no-passkey' | 'no-prf' };

/**
 * Settle an `unknown` source with one passkey prompt: evaluate the PRF and
 * compare the key it derives with the fee-payer in use. A match is `prf`; a
 * PRF output that derives some other key means the fee-payer is not the
 * passkey's, i.e. a random fallback. The result is recorded for next time.
 * Nothing is signed and no key is changed.
 */
export async function verifyFeePayerWithPasskey(): Promise<PasskeyVerification> {
  const [info, keyId] = await Promise.all([getFeePayerInfo(), getPasskeyId().catch(() => null)]);
  if (!info || !keyId) return { ok: false, reason: 'no-passkey' };

  const result = await evaluatePrf(keyId, FEE_PAYER_PRF_SALT);
  if (result.outcome !== 'ok' || !result.output || result.output.length < 32) {
    return { ok: false, reason: 'no-prf' };
  }
  const derived = Keypair.fromRawEd25519Seed(Buffer.from(result.output.subarray(0, 32))).publicKey();
  const source = derived === info.address ? 'prf' : 'random';
  await recordFeePayerSource(info.address, source);
  return { ok: true, source };
}

export type FeePayerBalance =
  | { state: 'funded'; xlm: string }
  /** Horizon answered 404: the account has never been funded on this network. */
  | { state: 'unfunded' }
  /** Anything else — reported as unknown, never as an empty balance. */
  | { state: 'error' };

/** The fee-payer's native XLM balance, keeping "not funded" apart from "could not check". */
export async function fetchFeePayerBalance(address: string): Promise<FeePayerBalance> {
  try {
    const account = await new Horizon.Server(getNetwork().horizonUrl).loadAccount(address);
    const native = (account.balances as { asset_type: string; balance: string }[]).find(
      (b) => b.asset_type === 'native',
    );
    return { state: 'funded', xlm: native?.balance ?? '0' };
  } catch (err) {
    const status = (err as { response?: { status?: number } })?.response?.status;
    if (status === 404 || (err instanceof Error && err.name === 'NotFoundError')) return { state: 'unfunded' };
    return { state: 'error' };
  }
}

/** What the screen says about each source. */
export function describeFeePayerSource(source: FeePayerSource): { label: string; description: string } {
  switch (source) {
    case 'prf':
      return {
        label: 'Passkey (PRF)',
        description:
          'Derived from your passkey’s WebAuthn PRF output, so the same passkey reproduces this fee payer on any PRF-capable device.',
      };
    case 'random':
      return {
        label: 'Random fallback',
        description:
          'Generated at random because your passkey gave no PRF output. It exists only on this device and cannot be re-derived from your passkey.',
      };
    case 'credential-id':
      return {
        label: 'Legacy (credential ID)',
        description:
          'Derived from the passkey’s non-secret credential ID — the scheme used before PRF support. Anyone who learns the credential ID can rebuild this key, so keep only fee money on it.',
      };
    case 'keypair':
      return {
        label: 'Wallet keypair',
        description: 'A keypair-mode testnet wallet: the wallet account pays its own fees.',
      };
    case 'unknown':
      return {
        label: 'Not recorded',
        description:
          'This wallet was set up before the app recorded how its fee payer was derived. Check with your passkey to find out whether it can be re-derived.',
      };
  }
}
