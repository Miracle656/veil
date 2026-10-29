/**
 * Recovering a fee-payer stranded by the move from credential-id to PRF.
 *
 * Wallets created before the PRF scheme derived their fee-payer from the
 * passkey's **credential id** (`deriveFeePayer.ts`). Current builds derive it
 * from the passkey's **PRF output**. Those are different keys, so a wallet
 * created under the old scheme and signed into on a current build adopts a
 * brand-new, empty classic account — and the funded one it has been using goes
 * invisible. The dashboard then reports the contract balance alone, because
 * `loadHoldings` has no fee-payer it can find.
 *
 * This happened to a real user on mainnet: wallet funded on 18 October,
 * reinstalled, and the app afterwards showed an address that has never existed
 * on the network while 6.865 XLM sat in the account it had abandoned.
 *
 * ## Why this sweeps rather than simply switching back
 *
 * The obvious repair — notice the legacy account is the funded one and keep
 * using it — reinstates a key that is **not passkey-bound**. The credential id
 * is not a secret: it is stored in plain AsyncStorage and returned in every
 * assertion, so anyone who reads it reconstructs that keypair with no biometric
 * prompt (see `docs/NON_PRF_FEE_PAYER_EXPOSURE.md`). Keeping it in service
 * trades a visible problem for an invisible one.
 *
 * So the funds move to the PRF account, which is passkey-bound, and the legacy
 * key stops being used.
 *
 * ## What is proved before anything moves
 *
 * A funded classic account is not evidence on its own — the derivation could
 * collide, or a user could hand over an address that is not theirs. The proof
 * is the breadcrumbs: the legacy account must carry `veil:pk1`/`veil:pk2`
 * matching the **contract's own signer**, which only the holder of that passkey
 * could have written. Nothing is swept without that match.
 */

/** Stellar's base reserve, in XLM. */
export const BASE_RESERVE_XLM = 0.5;

/**
 * Reserve held against the account itself, before subentries: two base
 * reserves, which is 1 XLM at the current protocol setting.
 */
export const ACCOUNT_RESERVE_XLM = 2 * BASE_RESERVE_XLM;

/**
 * Left behind on top of the reserve so the account can still pay a fee.
 *
 * A sweep that leaves exactly the reserve produces an account that cannot
 * submit anything, which matters because the breadcrumbs live here and a later
 * build may want to write to them.
 */
export const SWEEP_FEE_HEADROOM_XLM = 0.1;

export type RecoveryInputs = {
  /** The PRF-derived fee-payer this build would use. */
  prfAddress: string;
  /** Its XLM balance, or null when the account does not exist on the network. */
  prfBalanceXlm: number | null;
  /** The credential-id-derived account, or null when there is no credential id. */
  legacyAddress: string | null;
  /** Its XLM balance, or null when the account does not exist. */
  legacyBalanceXlm: number | null;
  /** Subentries on the legacy account — trustlines, data entries, signers. */
  legacySubentryCount: number;
  /** The signer key recorded in the legacy account's breadcrumbs, if any. */
  legacyCrumbSigner: Uint8Array | null;
  /** The signer the wallet contract actually holds. */
  walletSigner: Uint8Array | null;
};

export type RecoveryPlan =
  | {
      action: 'sweep';
      from: string;
      to: string;
      /** XLM to move, as a Stellar amount string (7 dp). */
      amount: string;
      /** What stays behind: reserve plus fee headroom. */
      retainedXlm: number;
    }
  | {
      action: 'none';
      reason:
        /** The PRF account already holds something; nothing is stranded. */
        | 'prf-funded'
        /** No credential id, so there is no legacy account to look at. */
        | 'no-legacy-candidate'
        /** Both derivations agree — there is nothing to move. */
        | 'same-account'
        /** The legacy account does not exist or holds nothing. */
        | 'legacy-empty'
        /** No breadcrumbs, or they name a different signer. Not ours to touch. */
        | 'unproven'
        /** Funded, ours, but entirely consumed by its own reserve. */
        | 'below-reserve';
    };

/** Constant-time-ish equality for two byte arrays. Length first. */
function sameBytes(a: Uint8Array | null, b: Uint8Array | null): boolean {
  if (!a || !b || a.length !== b.length || a.length === 0) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i]! ^ b[i]!;
  return diff === 0;
}

/**
 * What the account must keep: its own reserve, 0.5 per subentry, and enough
 * to pay a fee afterwards.
 */
export function retainedForSweep(subentryCount: number): number {
  const subentries = Math.max(0, Math.floor(subentryCount));
  return ACCOUNT_RESERVE_XLM + subentries * BASE_RESERVE_XLM + SWEEP_FEE_HEADROOM_XLM;
}

/**
 * Decide whether a stranded fee-payer should be swept, and for how much.
 *
 * Pure: every network answer is an input, so each refusal can be tested on its
 * own. The order of the checks is the order of cheapness and of certainty —
 * nothing is proved until it has to be.
 */
export function planFeePayerRecovery(input: RecoveryInputs): RecoveryPlan {
  // Something already works. Leave it alone: a sweep here would move money for
  // no reason and could race a transaction in flight.
  if (input.prfBalanceXlm !== null && input.prfBalanceXlm > 0) {
    return { action: 'none', reason: 'prf-funded' };
  }
  if (!input.legacyAddress) return { action: 'none', reason: 'no-legacy-candidate' };
  if (input.legacyAddress === input.prfAddress) return { action: 'none', reason: 'same-account' };
  if (input.legacyBalanceXlm === null || input.legacyBalanceXlm <= 0) {
    return { action: 'none', reason: 'legacy-empty' };
  }

  // The proof. A funded account the derivation happens to produce is not
  // evidence it is ours; breadcrumbs naming the contract's own signer are,
  // because only that passkey's holder could have written them.
  if (!sameBytes(input.legacyCrumbSigner, input.walletSigner)) {
    return { action: 'none', reason: 'unproven' };
  }

  const retained = retainedForSweep(input.legacySubentryCount);
  const movable = input.legacyBalanceXlm - retained;
  // Dust is not worth a transaction: the fee would eat most of it and the user
  // gets a confusing entry in their activity for nothing.
  if (movable < 0.01) return { action: 'none', reason: 'below-reserve' };

  return {
    action: 'sweep',
    from: input.legacyAddress,
    to: input.prfAddress,
    amount: movable.toFixed(7),
    retainedXlm: retained,
  };
}
