/**
 * Naira → USDC in one go.
 *
 * The naira service can only deliver XLM. Someone who chose USDC used to get
 * XLM and a "Convert" button. Now they approve the conversion once, with their
 * passkey, when they place the order, and this module does the swap for them
 * as soon as the XLM lands.
 *
 * The swap is a classic path payment from the spending account back to itself,
 * the same transaction the Swap screen builds: add the USDC trustline if it is
 * missing, sell XLM for at least a stated amount of USDC, and carry the Veil
 * fee on the same terms as any other swap. If the price moves past the limit
 * the network refuses the whole transaction and the XLM stays where it is.
 *
 * The rules (how much to convert, the least USDC to accept, whether an order
 * was approved) are plain functions so they can be tested without a network.
 */
import { Asset, Horizon, Keypair, Operation, TransactionBuilder } from '@stellar/stellar-sdk'

import { inclusionFee } from './fees'
import { XLM_KEPT_BACK } from './nairaBuy'
import { getNetwork, getUsdcIssuer } from './network'
import { fetchPlatformFee } from './platformFee'
import { spendableNativeXlm, TRUSTLINE_RESERVE_COST_XLM, type HorizonAccountLike } from './reserves'
import { canAffordSdexSwapFee } from './sdexSwapFeeAttach'
import { walletLocal, walletSession } from './walletStorage'

/** 1%. Wide enough for a small order on a liquid pair, tight enough to refuse a bad fill. */
export const AUTO_CONVERT_SLIPPAGE_BPS = 100
/** XLM left spendable after the swap, for the fees of whatever the person does next. */
export const SWAP_FEE_HEADROOM_XLM = 0.1

const APPROVED_KEY = 'veil_ngn_autoconvert'

interface Approval { orderId: string; done?: string }

function readApproval(): Approval | null {
  try {
    const raw = window.localStorage.getItem(APPROVED_KEY)
    if (!raw) return null
    const parsed = JSON.parse(raw) as Approval
    return typeof parsed?.orderId === 'string' ? parsed : null
  } catch {
    return null
  }
}

/** Record that the person approved converting this order's XLM, with their passkey. */
export function approveAutoConvert(orderId: string): void {
  try { window.localStorage.setItem(APPROVED_KEY, JSON.stringify({ orderId })) } catch { /* private window */ }
}

/** True only for the order that was approved, and only until it has been converted once. */
export function shouldAutoConvert(orderId: string): boolean {
  const a = readApproval()
  return !!a && a.orderId === orderId && !a.done
}

/** Written before the result is shown, so a refresh cannot run the swap twice. */
export function markAutoConverted(orderId: string, hash: string): void {
  try { window.localStorage.setItem(APPROVED_KEY, JSON.stringify({ orderId, done: hash })) } catch { /* private window */ }
}

/**
 * How much XLM to swap, as a 7-decimal string, or null when there is nothing
 * worth swapping.
 *
 * Never more than what was delivered minus the amount kept back, and never
 * more than the account can spend once the USDC trustline's reserve (if it is
 * about to be added) and some fee headroom are set aside. So money that was
 * already in the account is left alone, and the swap cannot fail for reserve.
 */
export function planAutoConvert(input: {
  deliveredXlm: number
  spendableXlm: string | number
  hasUsdcTrustline: boolean
}): string | null {
  const delivered = Number(input.deliveredXlm)
  const spendable = Number(input.spendableXlm)
  if (!Number.isFinite(delivered) || !Number.isFinite(spendable)) return null
  const fromOrder = delivered - XLM_KEPT_BACK
  const fromAccount =
    spendable - (input.hasUsdcTrustline ? 0 : TRUSTLINE_RESERVE_COST_XLM) - SWAP_FEE_HEADROOM_XLM
  // Through whole stroops first, so 24.33 - 2 is 22.33 and not 22.3299999.
  const stroops = Math.round(Math.min(fromOrder, fromAccount) * 1e7)
  const amount = Math.floor(stroops / 1e5) / 100
  return amount > 0 ? amount.toFixed(7) : null
}

/** The least USDC the swap may deliver: the quote less the slippage allowance. */
export function minUsdcOut(quotedUsdc: string, slippageBps = AUTO_CONVERT_SLIPPAGE_BPS): string | null {
  const quoted = Number(quotedUsdc)
  if (!Number.isFinite(quoted) || !(quoted > 0)) return null
  // Whole stroops, rounded down: never ask for more than the allowance gives.
  const minStroops = Math.floor((Math.round(quoted * 1e7) * (10_000 - slippageBps)) / 10_000)
  return minStroops > 0 ? (minStroops / 1e7).toFixed(7) : null
}

export interface AutoConvertResult {
  hash: string
  soldXlm: string
  /** What the market quoted; the amount received is at least `minUsdc`. */
  quotedUsdc: string
  minUsdc: string
}

export class AutoConvertError extends Error {}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

type PathAsset = { asset_type: string; asset_code?: string; asset_issuer?: string }
const toAsset = (a: PathAsset) =>
  a.asset_type === 'native' ? Asset.native() : new Asset(a.asset_code!, a.asset_issuer!)

/**
 * Wait for the delivered XLM to arrive, then swap it to USDC.
 *
 * Throws AutoConvertError with a sentence the person can act on. Nothing is
 * signed until a quote is in hand, and a failure leaves the XLM untouched.
 */
export async function autoConvertToUsdc(
  deliveredXlm: number,
  opts: { waitMs?: number; pollMs?: number } = {},
): Promise<AutoConvertResult> {
  const network = getNetwork()
  const secret = walletSession.getItem('veil_signer_secret') || walletLocal.getItem('veil_signer_secret')
  if (!secret) throw new AutoConvertError('Your wallet is locked. Unlock it, then convert from the Swap screen.')
  const signer = Keypair.fromSecret(secret)
  const server = new Horizon.Server(network.horizonUrl)
  const usdc = new Asset('USDC', getUsdcIssuer())

  // The payout is on its way when the order settles, not yet in the account.
  // Poll until the account can cover the swap, then take whatever it can.
  const deadline = Date.now() + (opts.waitMs ?? 120_000)
  const wanted = planAutoConvert({ deliveredXlm, spendableXlm: Number.MAX_SAFE_INTEGER, hasUsdcTrustline: true })
  if (!wanted) throw new AutoConvertError('Too little arrived to convert. Your XLM is in your wallet.')

  let account: Awaited<ReturnType<typeof server.loadAccount>> | null = null
  let sendAmount: string | null = null
  let hasTrustline = false
  for (;;) {
    try {
      account = await server.loadAccount(signer.publicKey())
      hasTrustline = account.balances.some(
        (b) => 'asset_code' in b && b.asset_code === 'USDC' && 'asset_issuer' in b && b.asset_issuer === usdc.getIssuer(),
      )
      sendAmount = planAutoConvert({
        deliveredXlm,
        spendableXlm: spendableNativeXlm(account as unknown as HorizonAccountLike),
        hasUsdcTrustline: hasTrustline,
      })
      // Arrived in full: go. Otherwise keep waiting for the payout.
      if (sendAmount && Number(sendAmount) >= Number(wanted) - 0.01) break
    } catch {
      account = null // not funded yet, or Horizon briefly unreachable
    }
    if (Date.now() >= deadline) break
    await sleep(opts.pollMs ?? 4_000)
  }
  if (!account || !sendAmount) {
    throw new AutoConvertError('Your XLM has not arrived yet. When it does, convert it from the Swap screen.')
  }

  const paths = await server.strictSendPaths(Asset.native(), sendAmount, [usdc]).call()
  const best = [...paths.records].sort((a, b) => Number(b.destination_amount) - Number(a.destination_amount))[0]
  const destMin = best ? minUsdcOut(best.destination_amount) : null
  if (!best || !destMin) {
    throw new AutoConvertError('No price for XLM to USDC right now. Your XLM is safe. Try the Swap screen in a moment.')
  }

  const builder = new TransactionBuilder(account, {
    fee: inclusionFee(),
    networkPassphrase: network.networkPassphrase,
  }).setTimeout(60)
  const addsTrustline = !hasTrustline
  if (addsTrustline) builder.addOperation(Operation.changeTrust({ asset: usdc }))
  builder.addOperation(
    Operation.pathPaymentStrictSend({
      sendAsset: Asset.native(),
      sendAmount,
      destination: signer.publicKey(),
      destAsset: usdc,
      destMin,
      path: (best.path as PathAsset[]).map(toAsset),
    }),
  )

  // The Veil fee, on exactly the Swap screen's terms: only if the account can
  // carry it, and never the reason the swap fails. The operation count is
  // stated, not read from a build(): build() moves the sequence number on, and
  // building twice is what sent every swap back as tx_bad_seq.
  const fee = await fetchPlatformFee('XLM', Number(sendAmount))
  if (
    fee &&
    canAffordSdexSwapFee({
      spendableXlm: spendableNativeXlm(account as unknown as HorizonAccountLike),
      nativeAmountIn: sendAmount,
      feeAmount: fee.amount,
      perOpBidStroops: Number(inclusionFee()),
      opsWithoutFee: addsTrustline ? 2 : 1,
      addsTrustline,
    })
  ) {
    builder.addOperation(Operation.payment({ destination: fee.destination, asset: Asset.native(), amount: fee.amount }))
  }

  const tx = builder.build()
  tx.sign(signer)
  const result = await server.submitTransaction(tx)
  return { hash: result.hash, soldXlm: sendAmount, quotedUsdc: best.destination_amount, minUsdc: destMin }
}
