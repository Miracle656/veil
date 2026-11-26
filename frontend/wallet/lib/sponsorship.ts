/**
 * Sponsored trustlines — letting a user hold USDC with no XLM of their own.
 *
 * ## The problem
 *
 * A Stellar account cannot hold a non-native asset without a trustline, and a
 * trustline raises that account's minimum reserve by 0.5 XLM. Establishing one
 * is itself a transaction, which costs a fee. So a user with zero XLM cannot
 * receive USDC at all — the payment bounces — and they cannot fix it, because
 * fixing it needs the XLM they do not have.
 *
 * For a wallet whose product is "hold dollars", that is the first thing a real
 * user hits: a friend sends them USDC and it simply fails.
 *
 * ## Why the fee payer cannot solve it
 *
 * Veil derives each user's fee payer from their own WebAuthn credential
 * (`deriveFeePayer.ts`), so it belongs to that user. A user with no XLM has a
 * fee payer with no XLM. Sponsorship has to come from an account the *platform*
 * funds, and a platform key cannot ship inside the app — anyone could extract
 * it and drain the float. The sponsor's signature therefore has to be produced
 * server-side; this module holds the parts that decide *whether* to sponsor,
 * which both sides need to agree on.
 *
 * ## The mechanism
 *
 * CAP-33 sponsored reserves. The sponsor brackets the operation:
 *
 *   BeginSponsoringFutureReserves(sponsoredId: user)   — source: sponsor
 *   ChangeTrust(asset)                                 — source: user
 *   EndSponsoringFutureReserves                        — source: user
 *
 * The 0.5 XLM is locked against the *sponsor's* balance, not the user's, and is
 * released back to the sponsor if the trustline is ever removed. The user still
 * has to sign, because the trustline is being added to their account — nobody
 * can attach obligations to an account without its key.
 */

/** Assets the platform is willing to sponsor a trustline for. */
export const SPONSORABLE_ASSETS = ['USDC'] as const;

export type SponsorableAsset = (typeof SPONSORABLE_ASSETS)[number];

/** The base reserve a single trustline (one subentry) locks, in XLM. */
export const TRUSTLINE_RESERVE_XLM = 0.5;

/**
 * Sponsor a user only while their own balance is below this, in XLM.
 *
 * The point is to unblock someone who genuinely cannot proceed, not to pay for
 * users who can afford it themselves. The threshold sits above the bare
 * reserve so an account left with dust — enough for the reserve but not the
 * fee, or enough for one trustline and nothing after — still qualifies.
 */
export const SPONSORSHIP_BALANCE_CEILING_XLM = 1.5;

export type AccountSnapshot = {
  /** Whether the account exists on the ledger at all. */
  exists: boolean;
  /** Native XLM balance. Ignored when `exists` is false. */
  nativeBalance: number;
  /** Asset codes the account already trusts. */
  trustedAssets: string[];
};

export type SponsorshipDecision =
  | { sponsor: true; reason: 'account-missing' | 'below-ceiling' }
  | {
      sponsor: false;
      reason: 'asset-not-sponsorable' | 'already-trusted' | 'can-afford-it';
      /** Safe to show a user. */
      message: string;
    };

export function isSponsorableAsset(code: string): code is SponsorableAsset {
  return (SPONSORABLE_ASSETS as readonly string[]).includes(code.toUpperCase());
}

/**
 * Whether the platform should sponsor a trustline for this account and asset.
 *
 * Deliberately pure and shared: the client uses it to decide whether to bother
 * asking, and the server re-runs it before signing. The server's answer is the
 * one that counts — a client could always claim eligibility — so this must
 * never depend on anything only the client knows.
 */
export function decideSponsorship(
  assetCode: string,
  account: AccountSnapshot,
): SponsorshipDecision {
  const code = assetCode.toUpperCase();

  if (!isSponsorableAsset(code)) {
    return {
      sponsor: false,
      reason: 'asset-not-sponsorable',
      message: `${code} is not a sponsored asset. Only ${SPONSORABLE_ASSETS.join(', ')} can be opened for you.`,
    };
  }

  // An account that does not exist yet cannot hold anything, sponsored or
  // otherwise, so it needs creating in the same transaction.
  if (!account.exists) {
    return { sponsor: true, reason: 'account-missing' };
  }

  if (account.trustedAssets.some((a) => a.toUpperCase() === code)) {
    return {
      sponsor: false,
      reason: 'already-trusted',
      message: `Your account already accepts ${code}.`,
    };
  }

  if (account.nativeBalance > SPONSORSHIP_BALANCE_CEILING_XLM) {
    return {
      sponsor: false,
      reason: 'can-afford-it',
      message:
        `You have enough XLM to open a ${code} trustline yourself ` +
        `(${TRUSTLINE_RESERVE_XLM} XLM stays locked as reserve).`,
    };
  }

  return { sponsor: true, reason: 'below-ceiling' };
}

/**
 * What the sponsoring transaction has to contain.
 *
 * Returned as a plan rather than built operations so it can be asserted against
 * without a Stellar SDK in the test, and so the client can show the user what
 * is about to happen before anything is signed.
 */
export type SponsorshipPlan = {
  /** True when the account must be created as part of the same transaction. */
  createAccount: boolean;
  /** XLM the sponsor locks: the trustline reserve, plus the base reserve when creating. */
  reserveCostXlm: number;
  /** Operation names, in the order they must appear. */
  operations: string[];
};

/** The base reserve a new account itself locks (2 entries x 0.5 XLM). */
export const ACCOUNT_BASE_RESERVE_XLM = 1;

export function planSponsorship(account: AccountSnapshot): SponsorshipPlan {
  const createAccount = !account.exists;

  // Ordering is not stylistic. EndSponsoringFutureReserves must be the last
  // operation and must be sourced by the sponsored account, and everything
  // whose reserve is being sponsored has to sit inside the bracket — an
  // operation outside it is paid for by the user, which is the whole thing we
  // are avoiding.
  const operations = [
    'beginSponsoringFutureReserves',
    ...(createAccount ? ['createAccount'] : []),
    'changeTrust',
    'endSponsoringFutureReserves',
  ];

  return {
    createAccount,
    reserveCostXlm:
      TRUSTLINE_RESERVE_XLM + (createAccount ? ACCOUNT_BASE_RESERVE_XLM : 0),
    operations,
  };
}
