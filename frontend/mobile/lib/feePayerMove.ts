/**
 * Moving everything a spending account holds to another one, in one transaction.
 *
 * WHY THIS EXISTS
 * ---------------
 * The two repairs in `feePayerSweep.ts` moved native XLM and nothing else. A
 * spending account is where people are paid, so it holds USDC far more often
 * than it holds spare XLM, and both repairs left that behind:
 *
 * - the stranded-account sweep took the XLM and left the USDC on an account
 *   the app no longer showed;
 * - the move off a random key took the XLM and then replaced the stored secret
 *   with the passkey-derived one. The USDC stayed on the old account and the
 *   only copy of its key was overwritten. That is a permanent loss, caused by
 *   the repair.
 *
 * On 2026-11-14 a user lost 31.07 USDC on a random-key spending account when
 * they uninstalled the app. Nothing here could have helped after the fact; the
 * point is that the move must carry every asset while the key still exists.
 *
 * WHAT IT DOES
 * ------------
 * One transaction, sourced from the old account and signed by both keys:
 *
 *   1. XLM above the old account's reserve goes across (creating the new
 *      account if it does not exist yet);
 *   2. for each asset with a balance: the new account opens a trustline, the
 *      whole balance is paid across, and the old account closes its trustline;
 *   3. the reserve those closed trustlines were holding goes across too.
 *
 * It is atomic. If any step fails, the network applies none of it and the
 * caller must not switch keys.
 *
 * Closing the old trustlines is deliberate. An account that can no longer hold
 * USDC rejects a USDC payment, so a payer still using the old address gets
 * their money back instead of sending it somewhere nobody is watching.
 *
 * WHAT IT REFUSES
 * ---------------
 * Anything it cannot move completely is a reason to move nothing: a liquidity
 * pool share, an asset with open sell offers, a frozen trustline, an account
 * involved in sponsorship. A half-moved account followed by a key switch is
 * the loss this file exists to prevent. `planMove` names the reason.
 */
import { Asset, Horizon, Keypair, Operation, TransactionBuilder } from '@stellar/stellar-sdk';

/** One entry of Horizon's `balances` array, reduced to what the plan reads. */
export type MoveBalance = {
  asset_type: string;
  asset_code?: string;
  asset_issuer?: string;
  balance: string;
  selling_liabilities?: string;
  is_authorized?: boolean;
};

/** Horizon's account record, reduced to what the plan reads. */
export type MoveAccount = {
  balances: MoveBalance[];
  subentry_count: number;
  num_sponsoring?: number;
  num_sponsored?: number;
};

export type MoveRefusal =
  /** The account holds liquidity pool shares, which a payment cannot carry. */
  | 'pool-shares'
  /** An asset is committed to an open sell offer, so its balance cannot all move. */
  | 'open-offers'
  /** The issuer has frozen a trustline; a payment out of it would fail. */
  | 'frozen-asset'
  /** The account sponsors, or is sponsored for, ledger entries. */
  | 'sponsorship'
  /** More assets than one transaction can carry. */
  | 'too-many-assets'
  /** The XLM going across cannot cover the new account's own reserve. */
  | 'destination-reserve'
  /** Assets need a trustline on the new account and its key was not supplied. */
  | 'no-destination-key';

export type MoveAsset = {
  code: string;
  issuer: string;
  /** The whole balance, as a Stellar amount string. */
  amount: string;
  /** False when the new account already trusts this asset. */
  needsTrustline: boolean;
};

export type MovePlan =
  | {
      ok: true;
      /** The new account does not exist and is created by this transaction. */
      createsAccount: boolean;
      /** XLM sent first, in stroops. Zero means no native payment is made. */
      xlmStroops: bigint;
      assets: MoveAsset[];
      /** Reserve released by the closed trustlines, in stroops. */
      freedStroops: bigint;
    }
  | {
      ok: false;
      reason: MoveRefusal;
      /** How many stroops the destination is short of its reserve. */
      shortfallStroops?: bigint;
      /** Suggested top-up in whole XLM (rounded up with fee headroom). */
      shortfallXlm?: number;
    };

const STROOPS_PER_XLM = 10_000_000n;
/** Stellar's base reserve: 0.5 XLM. An account holds two, plus one per subentry. */
const BASE_RESERVE = 5_000_000n;
/** Three operations per asset plus two native payments, under the 100 limit. */
const MAX_ASSETS = 32;

/** Parse a Stellar amount string (up to 7 decimals) into stroops. */
export function toStroops(amount: string): bigint {
  const match = /^(\d+)(?:\.(\d{0,7}))?$/.exec(amount.trim());
  if (!match) throw new Error(`Not a Stellar amount: ${amount}`);
  const whole = BigInt(match[1]!);
  const fraction = BigInt((match[2] ?? '').padEnd(7, '0'));
  return whole * STROOPS_PER_XLM + fraction;
}

/** Format stroops as a Stellar amount string with seven decimals. */
export function fromStroops(stroops: bigint): string {
  const whole = stroops / STROOPS_PER_XLM;
  const fraction = (stroops % STROOPS_PER_XLM).toString().padStart(7, '0');
  return `${whole}.${fraction}`;
}

function isCredit(balance: MoveBalance): boolean {
  return balance.asset_type === 'credit_alphanum4' || balance.asset_type === 'credit_alphanum12';
}

/** Whether the account holds anything other than XLM. */
export function holdsOtherAssets(account: Pick<MoveAccount, 'balances'>): boolean {
  return account.balances.some((b) => b.asset_type !== 'native' && toStroops(b.balance) > 0n);
}

/**
 * Decide what one transaction would move, or why nothing may move.
 *
 * `xlmStroops` is how much XLM the caller wants across. The callers already
 * work out what the old account must keep (`retainedForSweep`), so this does
 * not second-guess it; it only checks the new account can afford to hold what
 * arrives.
 */
export function planMove(input: {
  from: MoveAccount;
  /** The new account, or null when it does not exist on the network yet. */
  to: MoveAccount | null;
  xlmStroops: bigint;
  /** Whether the caller can sign for the new account. */
  hasDestinationKey: boolean;
}): MovePlan {
  const { from, to } = input;
  if ((from.num_sponsoring ?? 0) > 0 || (from.num_sponsored ?? 0) > 0) {
    return { ok: false, reason: 'sponsorship' };
  }

  const assets: MoveAsset[] = [];
  for (const balance of from.balances) {
    if (balance.asset_type === 'native') continue;
    const held = toStroops(balance.balance);
    if (held === 0n) continue;
    if (!isCredit(balance) || !balance.asset_code || !balance.asset_issuer) {
      return { ok: false, reason: 'pool-shares' };
    }
    if (toStroops(balance.selling_liabilities ?? '0') > 0n) return { ok: false, reason: 'open-offers' };
    if (balance.is_authorized === false) return { ok: false, reason: 'frozen-asset' };
    const alreadyTrusted = !!to?.balances.some(
      (b) => b.asset_code === balance.asset_code && b.asset_issuer === balance.asset_issuer,
    );
    assets.push({
      code: balance.asset_code,
      issuer: balance.asset_issuer,
      amount: balance.balance,
      needsTrustline: !alreadyTrusted,
    });
  }
  if (assets.length > MAX_ASSETS) return { ok: false, reason: 'too-many-assets' };

  const newTrustlines = BigInt(assets.filter((a) => a.needsTrustline).length);
  if (newTrustlines > 0n && !input.hasDestinationKey) return { ok: false, reason: 'no-destination-key' };

  // The new account must be able to hold what arrives: two base reserves for
  // itself and one for every trustline, old and new.
  const xlm = input.xlmStroops > 0n ? input.xlmStroops : 0n;
  let needed: bigint;
  let have: bigint;
  if (to === null) {
    needed = (2n + newTrustlines) * BASE_RESERVE;
    have = xlm;
  } else {
    const native = to.balances.find((b) => b.asset_type === 'native');
    have = toStroops(native?.balance ?? '0') + xlm;
    needed = (2n + BigInt(to.subentry_count) + newTrustlines) * BASE_RESERVE;
  }
  if (have < needed) {
    const shortfallStroops = needed - have;
    // Work out the shortfall from the same numbers planMove already has: what
    // the new account needs, minus the XLM that can go across. Round up to a
    // number a person would actually send, and add a small margin for the fee.
    const shortfallXlmRaw = Number(shortfallStroops) / Number(STROOPS_PER_XLM);
    const shortfallXlm = Math.max(1, Math.ceil(shortfallXlmRaw + 0.05));
    return {
      ok: false,
      reason: 'destination-reserve',
      shortfallStroops,
      shortfallXlm,
    };
  }

  return {
    ok: true,
    createsAccount: to === null,
    xlmStroops: xlm,
    assets,
    freedStroops: BigInt(assets.length) * BASE_RESERVE,
  };
}

/** What a refusal means, for a log line or an error message. */
export class MoveRefusedError extends Error {
  constructor(
    public readonly reason: MoveRefusal,
    public readonly shortfallXlm?: number,
  ) {
    super(`move-refused:${reason}`);
    this.name = 'MoveRefusedError';
  }
}

/**
 * Build, sign and submit the move. Returns the transaction hash.
 *
 * Throws {@link MoveRefusedError} when the plan refuses, and whatever Horizon
 * throws when the network rejects the transaction. Either way nothing has
 * moved, and the caller must leave the stored key as it is.
 */
export async function submitMove(params: {
  fromSecret: string;
  to: string;
  /** Needed whenever the new account has to open a trustline. */
  toSecret: string | null;
  /** XLM to move, as a Stellar amount string. May be zero. */
  xlmAmount: string;
  net: { horizonUrl: string; networkPassphrase: string };
  fee: string;
}): Promise<string> {
  const server = new Horizon.Server(params.net.horizonUrl);
  const fromKey = Keypair.fromSecret(params.fromSecret);
  // A destination key that does not derive the destination address would open
  // trustlines on some other account and then fail the payments. Drop it.
  let toKey: Keypair | null = null;
  if (params.toSecret) {
    const candidate = Keypair.fromSecret(params.toSecret);
    if (candidate.publicKey() === params.to) toKey = candidate;
  }

  const fromAccount = await server.loadAccount(fromKey.publicKey());
  let toAccount: MoveAccount | null;
  try {
    toAccount = (await server.loadAccount(params.to)) as unknown as MoveAccount;
  } catch (error) {
    const status = (error as { response?: { status?: number } })?.response?.status;
    const missing = status === 404 || (error instanceof Error && error.name === 'NotFoundError');
    // Only "this account does not exist" may be read as null. Any other
    // failure is unknown, and guessing would create an account that exists.
    if (!missing) throw error;
    toAccount = null;
  }

  const plan = planMove({
    from: fromAccount as unknown as MoveAccount,
    to: toAccount,
    xlmStroops: toStroops(params.xlmAmount),
    hasDestinationKey: toKey !== null,
  });
  if (!plan.ok) throw new MoveRefusedError(plan.reason, plan.shortfallXlm);

  const builder = new TransactionBuilder(fromAccount, {
    fee: params.fee,
    networkPassphrase: params.net.networkPassphrase,
  });
  if (plan.createsAccount) {
    builder.addOperation(
      Operation.createAccount({ destination: params.to, startingBalance: fromStroops(plan.xlmStroops) }),
    );
  } else if (plan.xlmStroops > 0n) {
    builder.addOperation(
      Operation.payment({ destination: params.to, asset: Asset.native(), amount: fromStroops(plan.xlmStroops) }),
    );
  }
  for (const item of plan.assets) {
    const asset = new Asset(item.code, item.issuer);
    if (item.needsTrustline) builder.addOperation(Operation.changeTrust({ asset, source: params.to }));
    builder.addOperation(Operation.payment({ destination: params.to, asset, amount: item.amount }));
    // Limit 0 removes the trustline. The network refuses it unless the balance
    // is exactly zero, which the payment above has just made true.
    builder.addOperation(Operation.changeTrust({ asset, limit: '0' }));
  }
  if (plan.freedStroops > 0n) {
    builder.addOperation(
      Operation.payment({ destination: params.to, asset: Asset.native(), amount: fromStroops(plan.freedStroops) }),
    );
  }

  const tx = builder.setTimeout(60).build();
  tx.sign(fromKey);
  if (toKey && plan.assets.some((a) => a.needsTrustline)) tx.sign(toKey);
  const result = await server.submitTransaction(tx);
  return (result as { hash: string }).hash;
}
