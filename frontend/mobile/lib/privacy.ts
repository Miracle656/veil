/**
 * Privacy layer — private balance store and transaction helpers.
 *
 * Architecture overview
 * ─────────────────────
 * The "private balance" is a shielded pool: XLM is locked into the
 * invisible-wallet contract's privacy vault via a shield transaction, and
 * can only be moved with a zero-knowledge proof generated on-device.
 *
 * This module owns:
 *   • An external store (same shape as theme.ts / hiddenAmounts.ts) for the
 *     cached private balance so every subscriber re-renders on change without
 *     a provider.
 *   • A feature-flag check (PRIVACY_FLAG_KEY) that gates the private UI.
 *   • Async helpers for shield, private-send, and unshield that drive the
 *     step-machine screens; they simulate ZK proof generation with a staged
 *     progress callback so the UI can show realistic proving progress while
 *     the real circuit integration (V142) is wired in.
 *   • AsyncStorage persistence for the private balance so the card paints
 *     instantly on reopen rather than flashing a spinner.
 *
 * When V142 lands, replace `simulateProving` with the real prover call and
 * pass its progress events into the same `onProgress` callback — the screens
 * need no changes.
 */

import AsyncStorage from '@react-native-async-storage/async-storage';

import { getNetwork } from './network';
import { getWalletAddress } from './walletStore';

// ── Storage keys ──────────────────────────────────────────────────────────────

/** Persisted private balance (XLM string). */
const PRIVATE_BALANCE_KEY = 'veil_private_balance';

/**
 * Feature flag — when `'1'` the private-balance card and privacy flows are
 * shown on the dashboard.  This mirrors the V131 hidden-amounts pattern:
 * set this to `'1'` to opt-in during development / testnet, and it will
 * eventually be driven by a remote config or a server-side flag once V143
 * ships to production.
 */
export const PRIVACY_FLAG_KEY = 'veil_privacy_enabled';

// ── External store — private balance ─────────────────────────────────────────

let privateBalance: string | null = null;
let balanceHydrated = false;
let privacyEnabled = false;
let flagHydrated = false;

const listeners = new Set<() => void>();

function notify(): void {
  for (const l of listeners) l();
}

export function subscribeToPrivacy(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function getPrivateBalance(): string | null {
  return privateBalance;
}

export function isPrivateBalanceHydrated(): boolean {
  return balanceHydrated;
}

export function getPrivacyEnabled(): boolean {
  return privacyEnabled;
}

export function isPrivacyFlagHydrated(): boolean {
  return flagHydrated;
}

// Single shared hydration promise so concurrent callers don't double-read.
let hydrationPromise: Promise<void> | null = null;

/**
 * Read both the cached private balance and the privacy feature flag from
 * AsyncStorage.  Called at module import time so data is usually ready by
 * first paint.
 */
export function hydratePrivacy(): Promise<void> {
  hydrationPromise ??= (async () => {
    try {
      const [bal, flag] = await Promise.all([
        AsyncStorage.getItem(PRIVATE_BALANCE_KEY),
        AsyncStorage.getItem(PRIVACY_FLAG_KEY),
      ]);
      privateBalance = bal ?? null;
      privacyEnabled = flag === '1';
    } catch {
      // storage unavailable — keep defaults
    } finally {
      balanceHydrated = true;
      flagHydrated = true;
      notify();
    }
  })();
  return hydrationPromise;
}

// Hydrate immediately on import.
void hydratePrivacy();

/** Update the cached private balance and persist it. */
export async function setPrivateBalance(balance: string | null): Promise<void> {
  privateBalance = balance;
  balanceHydrated = true;
  notify();
  try {
    if (balance === null) {
      await AsyncStorage.removeItem(PRIVATE_BALANCE_KEY);
    } else {
      await AsyncStorage.setItem(PRIVATE_BALANCE_KEY, balance);
    }
  } catch {
    // best-effort
  }
}

/** Enable or disable the privacy UI feature flag. */
export async function setPrivacyEnabled(enabled: boolean): Promise<void> {
  privacyEnabled = enabled;
  flagHydrated = true;
  notify();
  try {
    await AsyncStorage.setItem(PRIVACY_FLAG_KEY, enabled ? '1' : '0');
  } catch {
    // best-effort
  }
}

// ── Proving simulation ────────────────────────────────────────────────────────

/**
 * Simulates the ZK proving stage of a privacy transaction with realistic
 * multi-phase progress.
 *
 * Replace the body of this function with the actual V142 circuit call when
 * it is available.  The `onProgress` callback contract (0–100 number) is the
 * integration surface: the screens don't need to change.
 *
 * @param onProgress  Callback fired with a 0–100 progress value.
 * @param signal      Optional AbortSignal to cancel a proof in flight.
 */
export async function simulateProving(
  onProgress: (pct: number) => void,
  signal?: AbortSignal,
): Promise<void> {
  // Phases mimic real prover stages: witness gen → R1CS → SNARK → verify.
  const phases: Array<{ label: string; durationMs: number; endPct: number }> = [
    { label: 'Building witness',        durationMs: 800,  endPct: 20 },
    { label: 'Generating constraints',  durationMs: 1200, endPct: 45 },
    { label: 'Computing proof',         durationMs: 2200, endPct: 85 },
    { label: 'Verifying proof',         durationMs: 600,  endPct: 100 },
  ];

  let current = 0;

  for (const phase of phases) {
    if (signal?.aborted) throw new DOMException('Proving cancelled', 'AbortError');

    const steps = 10;
    const stepMs = phase.durationMs / steps;
    const stepPct = (phase.endPct - current) / steps;

    for (let i = 0; i < steps; i++) {
      if (signal?.aborted) throw new DOMException('Proving cancelled', 'AbortError');
      await sleep(stepMs);
      current = Math.min(100, current + stepPct);
      onProgress(Math.round(current));
    }
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ── Privacy transaction helpers ───────────────────────────────────────────────

export interface PrivacyTxResult {
  /** Transaction hash on Stellar. */
  hash: string;
}

export class PrivacyError extends Error {
  constructor(message: string, public readonly cause?: unknown) {
    super(message);
    this.name = 'PrivacyError';
  }
}

/**
 * Shield — moves `amount` XLM from the public wallet into the private pool.
 *
 * Flow: passkey authorises the Soroban call → the contract moves funds into
 * the privacy vault → we update the local private balance cache.
 *
 * When V142 circuit integration lands, the `proveShield()` call goes here
 * before the Soroban invocation.
 *
 * @param amount    Decimal XLM string, e.g. `"10.5"`.
 * @param signer    Passkey-derived signer from `requireSigner()`.
 * @param onProgress  Proving progress callback (0–100).
 * @param signal    Cancellation signal.
 */
export async function shieldXlm(
  amount: string,
  signer: { publicKey: string; sign(tx: unknown): void },
  onProgress: (pct: number) => void,
  signal?: AbortSignal,
): Promise<PrivacyTxResult> {
  if (signal?.aborted) throw new DOMException('Cancelled', 'AbortError');

  // ZK proving phase (V142 stub).
  await simulateProving(onProgress, signal);

  if (signal?.aborted) throw new DOMException('Cancelled', 'AbortError');

  // ── Soroban invocation stub ────────────────────────────────────────────────
  // TODO(V142): Replace the stub below with the real privacy-vault contract
  // call once the compiled circuit artefacts land.
  //
  //   const rpc = new SorobanRpc.Server(getNetwork().rpcUrl);
  //   const contractId = getNetwork().privacyVaultContractId;
  //   const contract = new Contract(contractId);
  //   const tx = await buildPrivacyTx(rpc, contract, 'shield', amount, signer);
  //   const result = await submitAndPoll(rpc, tx);
  //   const hash = result.hash;

  const hash = await mockPrivacyTx('shield', amount);

  // Update local private balance cache.
  const prev = Number(privateBalance ?? '0');
  const next = (prev + Number(amount)).toFixed(7);
  await setPrivateBalance(next);

  return { hash };
}

/**
 * Private send — transfers `amount` XLM from the private pool to `recipient`
 * without revealing the sender's identity on-chain.
 */
export async function sendPrivate(
  amount: string,
  recipient: string,
  signer: { publicKey: string; sign(tx: unknown): void },
  onProgress: (pct: number) => void,
  signal?: AbortSignal,
): Promise<PrivacyTxResult> {
  if (signal?.aborted) throw new DOMException('Cancelled', 'AbortError');

  await simulateProving(onProgress, signal);

  if (signal?.aborted) throw new DOMException('Cancelled', 'AbortError');

  void recipient; // will be used in the real invocation
  const hash = await mockPrivacyTx('send', amount);

  const prev = Number(privateBalance ?? '0');
  const next = Math.max(0, prev - Number(amount)).toFixed(7);
  await setPrivateBalance(next);

  return { hash };
}

/**
 * Unshield — withdraws `amount` XLM from the private pool back to the
 * caller's public wallet address.
 */
export async function unshieldXlm(
  amount: string,
  signer: { publicKey: string; sign(tx: unknown): void },
  onProgress: (pct: number) => void,
  signal?: AbortSignal,
): Promise<PrivacyTxResult> {
  if (signal?.aborted) throw new DOMException('Cancelled', 'AbortError');

  await simulateProving(onProgress, signal);

  if (signal?.aborted) throw new DOMException('Cancelled', 'AbortError');

  void signer; // will be used in the real invocation
  const hash = await mockPrivacyTx('unshield', amount);

  const prev = Number(privateBalance ?? '0');
  const next = Math.max(0, prev - Number(amount)).toFixed(7);
  await setPrivateBalance(next);

  return { hash };
}

// ── Internals ─────────────────────────────────────────────────────────────────

/** Produces a plausible-looking mock transaction hash for testnet stubs. */
async function mockPrivacyTx(action: string, amount: string): Promise<string> {
  // Tiny delay mimics network round-trip.
  await sleep(400);
  const ts = Date.now().toString(16).toUpperCase();
  const tag = action.slice(0, 2).toUpperCase();
  const amt = amount.replace('.', '').slice(0, 4).padStart(4, '0');
  return `${tag}${amt}${ts}AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA`.slice(0, 64);
}

/** Fetch the on-chain private balance for the wallet (V142 stub). */
export async function fetchPrivateBalance(_walletAddress: string): Promise<string> {
  // TODO(V142): Query the privacy vault contract for the note commitment
  // matching this wallet's viewing key.
  //
  // For now, return the locally cached value so the card always has data.
  return privateBalance ?? '0';
}

/** Refresh the cached private balance from the chain (best-effort). */
export async function refreshPrivateBalance(): Promise<void> {
  try {
    const addr = await getWalletAddress();
    if (!addr) return;
    const balance = await fetchPrivateBalance(addr);
    await setPrivateBalance(balance);
  } catch {
    // Keep the cached value.
  }
}
