/**
 * Moving everything a spending account holds to another one, in one transaction.
 *
 * WHY THIS EXISTS
 * ---------------
 * A spending account is where people are paid, so it can hold USDC, empty
 * trustlines, recovery breadcrumbs (`veil:pk1`, `veil:pk2`, `veil:wallet`),
 * and XLM locked as reserve behind them. Leaving any of that behind when
 * switching keys strands the user's funds on an account the app stops showing,
 * or forces a top-up just to cover the new account's reserve.
 *
 * WHAT IT DOES
 * ------------
 * One atomic transaction, sourced from the old account and signed by both keys:
 *
 *   1. close empty trustlines on the old account (0.5 XLM freed each);
 *   2. carry any recovery breadcrumbs to the new account and delete them from
 *      the old one;
 *   3. move XLM (creating the new account if it does not exist yet);
 *   4. for each asset with a balance: open a trustline on the new account if
 *      needed, pay the full balance across, and close the old trustline;
 *   5. merge the old account into the new one once it has zero subentries left,
 *      bringing the entire remaining balance (including the 1 XLM base reserve)
 *      across.
 *
 * When the old account has enough free XLM up front, breadcrumbs are written to
 * the new account before being deleted from the old one. When the old account
 * can only afford `createAccount` by freeing its own breadcrumb reserve first,
 * the deletion happens earlier in the same atomic transaction and the write to
 * the new account happens right after `accountMerge` — either both succeed or
 * neither does.
 *
 * WHAT IT REFUSES
 * ---------------
 * Anything it cannot move completely is a reason to move nothing: a liquidity
 * pool share, an asset with open offers/liabilities, a frozen trustline, an
 * account involved in sponsorship. `planMove` names the reason.
 */
import { Asset, Horizon, Keypair, Operation, TransactionBuilder } from '@stellar/stellar-sdk';
import { Buffer } from 'buffer';

import { CRUMB_PK1, CRUMB_PK2, CRUMB_WALLET } from './walletBreadcrumbs';

/** One entry of Horizon's `balances` array, reduced to what the plan reads. */
export type MoveBalance = {
  asset_type: string;
  asset_code?: string;
  asset_issuer?: string;
  balance: string;
  selling_liabilities?: string;
  buying_liabilities?: string;
  is_authorized?: boolean;
};

/** Horizon's account record, reduced to what the plan reads. */
export type MoveAccount = {
  balances: MoveBalance[];
  subentry_count: number;
  num_sponsoring?: number;
  num_sponsored?: number;
  data_attr?: Record<string, string>;
};

export type MoveRefusal =
  /** The account holds liquidity pool shares, which a payment cannot carry. */
  | 'pool-shares'
  /** An asset is committed to an open offer, so its balance cannot all move. */
  | 'open-offers'
  /** The issuer has frozen a trustline; a payment out of it would fail. */
  | 'frozen-asset'
  /** The account sponsors, or is sponsored for, ledger entries. */
  | 'sponsorship'
  /** More assets/operations than one transaction can carry. */
  | 'too-many-assets'
  /** The XLM going across cannot cover the new account's own reserve. */
  | 'destination-reserve'
  /** Assets or breadcrumbs need to be written on the new account and its key was not supplied. */
  | 'no-destination-key';

export type MoveAsset = {
  code: string;
  issuer: string;
  /** The whole balance, as a Stellar amount string. */
  amount: string;
  /** False when the new account already trusts this asset. */
  needsTrustline: boolean;
};

export type MoveTrustlineClose = {
  code: string;
  issuer: string;
};

export type MoveBreadcrumb = {
  name: string;
  /** Base64-encoded value from Horizon's `data_attr`. */
  valueBase64: string;
};

export type MovePlan =
  | {
      ok: true;
      /** The new account does not exist and is created by this transaction. */
      createsAccount: boolean;
      /** XLM sent up front (via createAccount or payment), in stroops. */
      xlmStroops: bigint;
      assets: MoveAsset[];
      /** Empty trustlines closed on the old account. */
      emptyTrustlines: MoveTrustlineClose[];
      /** Recovery breadcrumbs written to the new account. */
      breadcrumbsToWrite: MoveBreadcrumb[];
      /** Recovery breadcrumb keys deleted from the old account. */
      breadcrumbsToDelete: string[];
      /** True when breadcrumbs are written on `to` before deleted from `from`. */
      writeBreadcrumbsBeforeDelete: boolean;
      /** True when all subentries on `from` are cleared so `accountMerge` runs. */
      mergesAccount: boolean;
      /** Reserve released by closed trustlines and deleted breadcrumbs, in stroops. */
      freedStroops: bigint;
    }
  | { ok: false; reason: MoveRefusal };

const STROOPS_PER_XLM = 10_000_000n;
/** Stellar's base reserve: 0.5 XLM. An account holds two, plus one per subentry. */
const BASE_RESERVE = 5_000_000n;
/** Keep total operation count safely under Stellar's 100-op transaction limit. */
const MAX_ASSETS = 30;

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
 * Accounts for reserve freed by closing empty trustlines, deleting recovery
 * breadcrumbs (after or atomically alongside writing them to `to`), and
 * merging the old account into the new one.
 */
export function planMove(input: {
  from: MoveAccount;
  /** The new account, or null when it does not exist on the network yet. */
  to: MoveAccount | null;
  /** Minimum XLM to send up front if not merging (e.g. from legacy callers). */
  xlmStroops: bigint;
  /** Whether the caller can sign for the new account. */
  hasDestinationKey: boolean;
  /** Transaction fee in stroops (deducted from `from`). */
  feeStroops?: bigint;
}): MovePlan {
  const { from, to } = input;
  const feeStroops = input.feeStroops ?? 0n;

  if ((from.num_sponsoring ?? 0) > 0 || (from.num_sponsored ?? 0) > 0) {
    return { ok: false, reason: 'sponsorship' };
  }

  const assets: MoveAsset[] = [];
  const emptyTrustlines: MoveTrustlineClose[] = [];

  for (const balance of from.balances) {
    if (balance.asset_type === 'native') continue;
    const held = toStroops(balance.balance);
    if (!isCredit(balance) || !balance.asset_code || !balance.asset_issuer) {
      return { ok: false, reason: 'pool-shares' };
    }
    if (
      toStroops(balance.selling_liabilities ?? '0') > 0n ||
      toStroops(balance.buying_liabilities ?? '0') > 0n
    ) {
      return { ok: false, reason: 'open-offers' };
    }
    if (held === 0n) {
      emptyTrustlines.push({ code: balance.asset_code, issuer: balance.asset_issuer });
      continue;
    }
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
  if (assets.length + emptyTrustlines.length > MAX_ASSETS) {
    return { ok: false, reason: 'too-many-assets' };
  }

  // Extract recovery breadcrumbs from `from.data_attr`.
  const fromData = from.data_attr ?? {};
  const pk1 = fromData[CRUMB_PK1];
  const pk2 = fromData[CRUMB_PK2];
  const walletCrumb = fromData[CRUMB_WALLET];

  const breadcrumbsToWrite: MoveBreadcrumb[] = [];
  const breadcrumbsToDelete: string[] = [];

  if (typeof pk1 === 'string' && pk1.length > 0 && typeof pk2 === 'string' && pk2.length > 0) {
    breadcrumbsToWrite.push({ name: CRUMB_PK1, valueBase64: pk1 }, { name: CRUMB_PK2, valueBase64: pk2 });
    breadcrumbsToDelete.push(CRUMB_PK1, CRUMB_PK2);
    if (typeof walletCrumb === 'string' && walletCrumb.length > 0) {
      breadcrumbsToDelete.push(CRUMB_WALLET);
    }
  } else {
    if (typeof pk1 === 'string' && pk1.length > 0) {
      breadcrumbsToWrite.push({ name: CRUMB_PK1, valueBase64: pk1 });
      breadcrumbsToDelete.push(CRUMB_PK1);
    }
    if (typeof pk2 === 'string' && pk2.length > 0) {
      breadcrumbsToWrite.push({ name: CRUMB_PK2, valueBase64: pk2 });
      breadcrumbsToDelete.push(CRUMB_PK2);
    }
    if (typeof walletCrumb === 'string' && walletCrumb.length > 0) {
      breadcrumbsToWrite.push({ name: CRUMB_WALLET, valueBase64: walletCrumb });
      breadcrumbsToDelete.push(CRUMB_WALLET);
    }
  }

  const newTrustlines = BigInt(assets.filter((a) => a.needsTrustline).length);
  const toData = to?.data_attr ?? {};
  const newBreadcrumbs = BigInt(breadcrumbsToWrite.filter((b) => !(b.name in toData)).length);

  if ((newTrustlines > 0n || breadcrumbsToWrite.length > 0) && !input.hasDestinationKey) {
    return { ok: false, reason: 'no-destination-key' };
  }

  const fromNative = from.balances.find((b) => b.asset_type === 'native');
  const fromBalance = toStroops(fromNative?.balance ?? '0');

  const removedSubentries = assets.length + emptyTrustlines.length + breadcrumbsToDelete.length;
  const remainingSubentries = Math.max(0, from.subentry_count - removedSubentries);
  const mergesAccount = remainingSubentries === 0 && fromBalance > feeStroops;

  const freedSubentryStroops =
    BigInt(assets.length + emptyTrustlines.length + breadcrumbsToDelete.length) * BASE_RESERVE;

  // How much XLM `to` needs in total once the transaction completes.
  const toExisting =
    to === null ? 0n : toStroops(to.balances.find((b) => b.asset_type === 'native')?.balance ?? '0');
  const toFinalNeeded = (2n + BigInt(to?.subentry_count ?? 0) + newTrustlines + newBreadcrumbs) * BASE_RESERVE;

  const requestedXlm = input.xlmStroops > 0n ? input.xlmStroops : 0n;
  const totalXlmArriving = mergesAccount
    ? fromBalance > feeStroops
      ? fromBalance - feeStroops
      : 0n
    : requestedXlm;

  if (toExisting + totalXlmArriving < toFinalNeeded) {
    return { ok: false, reason: 'destination-reserve' };
  }

  // Determine up-front XLM transfer (used for `createAccount` or initial payment)
  // and whether breadcrumbs on `to` can be written before deleting from `from`.
  let upFrontXlm = requestedXlm;
  let writeBreadcrumbsBeforeDelete = true;

  if (to === null) {
    // `to` must exist with at least 2 base reserves + 1 per trustline it opens
    // before assets can move across.
    const minCreateForTrustlines = (2n + newTrustlines) * BASE_RESERVE;
    const minCreateWithBreadcrumbs = (2n + newTrustlines + newBreadcrumbs) * BASE_RESERVE;

    // Max `from` can send up-front if breadcrumbs stay on `from` until after `to` writes them:
    const fromReserveWithBreadcrumbs =
      (2n + BigInt(assets.length + breadcrumbsToDelete.length + remainingSubentries)) * BASE_RESERVE;
    const freeWithBreadcrumbs = fromBalance - feeStroops - fromReserveWithBreadcrumbs;

    if (freeWithBreadcrumbs >= minCreateWithBreadcrumbs) {
      // Enough free XLM to fund `to` (including its breadcrumbs) before deleting `from`'s crumbs.
      upFrontXlm = upFrontXlm > minCreateWithBreadcrumbs ? upFrontXlm : minCreateWithBreadcrumbs;
      if (upFrontXlm > freeWithBreadcrumbs) upFrontXlm = freeWithBreadcrumbs;
      writeBreadcrumbsBeforeDelete = true;
    } else if (mergesAccount) {
      // Tight balance (e.g. build 29's 2.66 XLM): delete `from`'s empty trustlines
      // and breadcrumbs first so `from` can fund `createAccount`, then `accountMerge`
      // brings the rest to `to` before `to` writes its breadcrumbs.
      const fromReserveAfterCrumbs =
        (2n + BigInt(assets.length + remainingSubentries)) * BASE_RESERVE;
      const freeAfterCrumbs = fromBalance - feeStroops - fromReserveAfterCrumbs;
      if (freeAfterCrumbs < minCreateForTrustlines) {
        return { ok: false, reason: 'destination-reserve' };
      }
      upFrontXlm = minCreateForTrustlines;
      writeBreadcrumbsBeforeDelete = false;
    } else {
      return { ok: false, reason: 'destination-reserve' };
    }
  } else if (mergesAccount && breadcrumbsToWrite.length > 0) {
    // `to` already exists: check if `to` can afford its new trustlines + breadcrumbs
    // before `accountMerge` sends the remaining balance.
    const toReserveNeededBeforeMerge =
      (2n + BigInt(to.subentry_count) + newTrustlines + newBreadcrumbs) * BASE_RESERVE;
    const fromReserveWithBreadcrumbs =
      (2n + BigInt(assets.length + breadcrumbsToDelete.length + remainingSubentries)) * BASE_RESERVE;
    const freeWithBreadcrumbs = fromBalance - feeStroops - fromReserveWithBreadcrumbs;
    const shortfallOnTo =
      toReserveNeededBeforeMerge > toExisting ? toReserveNeededBeforeMerge - toExisting : 0n;

    if (shortfallOnTo > freeWithBreadcrumbs) {
      writeBreadcrumbsBeforeDelete = false;
      upFrontXlm = 0n;
    } else if (shortfallOnTo > upFrontXlm) {
      upFrontXlm = shortfallOnTo;
    }
  }

  return {
    ok: true,
    createsAccount: to === null,
    xlmStroops: upFrontXlm,
    assets,
    emptyTrustlines,
    breadcrumbsToWrite,
    breadcrumbsToDelete,
    writeBreadcrumbsBeforeDelete,
    mergesAccount,
    freedStroops: mergesAccount ? 0n : freedSubentryStroops,
  };
}

/** What a refusal means, for a log line or an error message. */
export class MoveRefusedError extends Error {
  constructor(public readonly reason: MoveRefusal) {
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
  /** Needed whenever the new account has to open a trustline or write breadcrumbs. */
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
  if (!plan.ok) throw new MoveRefusedError(plan.reason);

  const builder = new TransactionBuilder(fromAccount, {
    fee: params.fee,
    networkPassphrase: params.net.networkPassphrase,
  });

  // 1. Close empty trustlines first to free 0.5 XLM reserve each.
  for (const empty of plan.emptyTrustlines) {
    builder.addOperation(
      Operation.changeTrust({ asset: new Asset(empty.code, empty.issuer), limit: '0' }),
    );
  }

  // 2. If `from` needs its breadcrumb reserve freed to fund `createAccount`,
  //    delete them before `createAccount` (same atomic transaction).
  if (!plan.writeBreadcrumbsBeforeDelete) {
    for (const name of plan.breadcrumbsToDelete) {
      builder.addOperation(Operation.manageData({ name, value: null }));
    }
  }

  // 3. Create or fund `to`.
  if (plan.createsAccount) {
    builder.addOperation(
      Operation.createAccount({ destination: params.to, startingBalance: fromStroops(plan.xlmStroops) }),
    );
  } else if (plan.xlmStroops > 0n) {
    builder.addOperation(
      Operation.payment({
        destination: params.to,
        asset: Asset.native(),
        amount: fromStroops(plan.xlmStroops),
      }),
    );
  }

  // 4. Move non-zero assets and close their trustlines on `from`.
  for (const item of plan.assets) {
    const asset = new Asset(item.code, item.issuer);
    if (item.needsTrustline) builder.addOperation(Operation.changeTrust({ asset, source: params.to }));
    builder.addOperation(Operation.payment({ destination: params.to, asset, amount: item.amount }));
    // Limit 0 removes the trustline. The network refuses it unless the balance
    // is exactly zero, which the payment above has just made true.
    builder.addOperation(Operation.changeTrust({ asset, limit: '0' }));
  }

  // 5. Carry breadcrumbs before deleting when `to` can already afford them.
  if (plan.writeBreadcrumbsBeforeDelete) {
    for (const crumb of plan.breadcrumbsToWrite) {
      builder.addOperation(
        Operation.manageData({
          name: crumb.name,
          value: Buffer.from(crumb.valueBase64, 'base64'),
          source: params.to,
        }),
      );
    }
    for (const name of plan.breadcrumbsToDelete) {
      builder.addOperation(Operation.manageData({ name, value: null }));
    }
  }

  // 6. Merge `from` into `to` (sends all remaining XLM including base reserve),
  //    or fall back to sending freed reserve if unknown subentries remain.
  if (plan.mergesAccount) {
    builder.addOperation(Operation.accountMerge({ destination: params.to }));
  } else if (plan.freedStroops > 0n) {
    builder.addOperation(
      Operation.payment({
        destination: params.to,
        asset: Asset.native(),
        amount: fromStroops(plan.freedStroops),
      }),
    );
  }

  // 7. In the tight-reserve path, write breadcrumbs on `to` after `accountMerge`
  //    has delivered the remaining XLM.
  if (!plan.writeBreadcrumbsBeforeDelete) {
    for (const crumb of plan.breadcrumbsToWrite) {
      builder.addOperation(
        Operation.manageData({
          name: crumb.name,
          value: Buffer.from(crumb.valueBase64, 'base64'),
          source: params.to,
        }),
      );
    }
  }

  const tx = builder.setTimeout(60).build();
  tx.sign(fromKey);
  const needsToSig =
    plan.assets.some((a) => a.needsTrustline) || plan.breadcrumbsToWrite.length > 0;
  if (toKey && needsToSig) tx.sign(toKey);
  const result = await server.submitTransaction(tx);
  return (result as { hash: string }).hash;
}
