/**
 * Moving an issued asset (USDC and the like) out of the wallet contract.
 *
 * The web Send, Swap and Pay screens all spend from the `G…` spending account.
 * The dashboard already offered to move XLM there from the `C…` wallet, but
 * nothing did the same for USDC, so USDC sent to the wallet address showed in
 * the total and could not be sent anywhere.
 *
 * The rules live here, apart from the page, so they can be tested without a
 * browser: which balances can be moved, and whether the spending account is
 * able to receive them yet.
 */
import { TRUSTLINE_RESERVE_COST_XLM } from './reserves'
import { hasTrustline, type HorizonBalanceLike } from './trustlines'
import type { WalletAsset } from './walletTypes'

export type IssuedWalletAsset = WalletAsset & { issuer: string }

/** XLM kept aside for the network fees of the trustline and the move itself. */
export const MOVE_FEE_HEADROOM_XLM = 0.1

/** The wallet contract's non-XLM balances that are worth offering to move. */
export function movableWalletAssets(contractAssets: WalletAsset[]): IssuedWalletAsset[] {
  return contractAssets.filter(
    (a): a is IssuedWalletAsset => !!a.issuer && Number(a.balance) > 0,
  )
}

/**
 * A `G…` account can only receive an issued asset it has a trustline for, and
 * a trustline locks 0.5 XLM. So the move is one of three things: ready, ready
 * after adding the trustline, or blocked until the account has more XLM.
 */
export type ReceiveReadiness = 'ready' | 'add-trustline' | 'need-xlm'

export function receiveReadiness(
  balances: HorizonBalanceLike[],
  spendableXlm: string,
  asset: { code: string; issuer: string },
): ReceiveReadiness {
  if (hasTrustline(balances, asset.code, asset.issuer)) return 'ready'
  const spendable = Number(spendableXlm)
  if (!Number.isFinite(spendable)) return 'need-xlm'
  return spendable >= TRUSTLINE_RESERVE_COST_XLM + MOVE_FEE_HEADROOM_XLM
    ? 'add-trustline'
    : 'need-xlm'
}

/**
 * On Send: the wallet's own balance of the asset being paid, when moving it
 * would help. That is when the spending account holds none of it, or less than
 * the amount typed. Null means there is nothing to offer.
 *
 * Matched on code AND issuer, like everything else that picks an asset.
 */
export function walletBalanceToOffer(
  selected: { code: string; issuer: string | null; balance: string } | null,
  walletHeld: IssuedWalletAsset[],
  amount: string,
): IssuedWalletAsset | null {
  if (!selected?.issuer) return null
  const held = walletHeld.find((a) => a.code === selected.code && a.issuer === selected.issuer)
  if (!held) return null
  const spending = Number(selected.balance)
  if (!Number.isFinite(spending) || spending <= 0) return held
  const wanted = Number(amount)
  return Number.isFinite(wanted) && wanted > spending ? held : null
}

export function needXlmMessage(code: string): string {
  return `Your spending wallet needs about 1 XLM free before it can hold ${code}. Add a little XLM, then try again.`
}
