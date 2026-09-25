/**
 * Privacy engine surface — PREVIEW ONLY, no live engine.
 *
 * There is no Stellar Private Payments (SPP) client in this app yet: neither
 * mobile nor the web wallet talks to the SPP contracts. `lib/privacy/config.ts`
 * (#780) is the single source of truth for the feature — `isPrivacyEnabled()`
 * (build-time flag, and unconditionally off on mainnet) and `getSppConfig()`
 * (the testnet contract addresses a real client will use).
 *
 * Until the on-device prover (V142) and a pool scanner land, this module
 * fabricates NOTHING: no balance, no proof progress, no transaction hash. The
 * shield / send / unshield screens are UI previews gated behind
 * `isPrivacyEnabled()`; attempting an actual transfer surfaces
 * {@link ENGINE_PENDING_MESSAGE} rather than pretending to succeed.
 *
 * When V142 ships, replace the three `*Pending` bodies below with the real SPP
 * client calls (they will take an amount, a recipient for sends, a signer, and a
 * progress callback) and the screens need no structural changes.
 */

/** Honest copy shown when the user tries to move funds with no engine wired in. */
export const ENGINE_PENDING_MESSAGE =
  'Private payments are not live in this build yet. Shielding, private sends and unshielding need the on-device SPP prover and a pool scanner, which are not integrated here.';

export class PrivacyError extends Error {
  constructor(message: string = ENGINE_PENDING_MESSAGE) {
    super(message);
    this.name = 'PrivacyError';
  }
}

/** Mirrors the web wallet's `PrivateBalanceCard` props (#751). */
export type PrivateSyncState = 'syncing' | 'up-to-date' | 'needs-history';

export interface PrivateBalance {
  code: string;
  amount: string;
}

/**
 * No pool scanner runs yet, so the shielded balance is never known. Mirrors the
 * web wallet, which keeps the card in a permanent non-`up-to-date` state with
 * empty balances rather than inventing a confident zero — a "0.00" in a privacy
 * balance reads as "you have no money" when it really means "we haven't looked".
 */
export function getPrivateSyncState(): PrivateSyncState {
  return 'syncing';
}

export function getPrivateBalances(): PrivateBalance[] {
  return [];
}

// ── Integration seam (V142) ───────────────────────────────────────────────────
// Each throws until the real SPP client is wired in. Kept parameterless on
// purpose: passing an amount to a function that only throws would be theatre.

/** Shield — move XLM from the public wallet into the private pool. */
export async function shieldXlm(): Promise<never> {
  throw new PrivacyError();
}

/** Private send — move XLM from the private pool to a recipient. */
export async function sendPrivate(): Promise<never> {
  throw new PrivacyError();
}

/** Unshield — withdraw XLM from the private pool back to the public wallet. */
export async function unshieldXlm(): Promise<never> {
  throw new PrivacyError();
}
