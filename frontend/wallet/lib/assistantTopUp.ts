/**
 * Airtime top-ups the assistant pays for from its allowance.
 *
 * A top-up is paid in two moves, both by this browser's spending account:
 *
 *  1. Draw the exact USDC cost out of the wallet, under the allowance
 *     (lib/assistantAllowance.ts). This is the step the wallet contract
 *     limits: over the allowance, or after it ends, and it is refused.
 *  2. Pay the airtime order from the spending account, exactly as the
 *     Airtime screen does.
 *
 * No passkey is asked for. The allowance, granted earlier with the passkey, is
 * the approval, and it is the wallet contract that holds the line, not this
 * code.
 *
 * A plan is "this number, this much, every N days". Plans are kept in this
 * browser only. They run when the wallet is open here: nothing on a server
 * holds a key or acts while the wallet is closed.
 *
 * The rules (when a plan is due, what a plan may be) are pure and tested
 * without a network.
 */
import { Horizon } from '@stellar/stellar-sdk'

import { drawFromAllowance, readAssistantAllowance, unitsToUsdc, USDC_UNITS } from './assistantAllowance'
import { saveBillOrder } from './billOrders'
import { sendBillPayment } from './billSpend'
import { loadPayingAccount } from './horizonError'
import { needXlmMessage, receiveReadiness } from './moveFromWallet'
import { getNetwork, getUsdcIssuer } from './network'
import { getCustomerRef, getOnrampRate, isNairaVerified, payBill } from './ngn'
import { detectNetwork, MOBILE_NETWORKS } from './nigerianNetworks'
import { getFeePayerKeypair } from './passkeySigner'
import { spendableNativeXlm, type HorizonAccountLike } from './reserves'
import { buildChangeTrustTx, type HorizonBalanceLike } from './trustlines'
import { walletLocal, walletSession } from './walletStorage'

export const MIN_TOPUP_NGN = 50
export const MAX_TOPUP_NGN = 5_000
export const TOPUP_EVERY_DAYS = [1, 7, 30] as const
const DAY_MS = 86_400_000

export interface TopUpPlan {
  id: string
  /** The line to top up, as 11 digits. */
  phone: string
  /** MTN, AIRTEL, GLO or 9MOBILE. */
  network: string
  amountNgn: number
  everyDays: number
  /** When it next falls due, in milliseconds. */
  nextRunAt: number
  lastRunAt?: number
  lastOrderId?: string
  /** Why the last attempt did not go through, in words for the person. */
  lastProblem?: string
}

export interface PlanStore {
  getItem(key: string): string | null
  setItem(key: string, value: string): void
}

const key = (wallet: string) => `veil_topup_plans:${wallet}`

/** The 11 digits of a Nigerian mobile number, or null. */
export function normalisePhone(input: string): string | null {
  const digits = input.replace(/\D/g, '')
  return /^0\d{10}$/.test(digits) ? digits : null
}

/** Why this plan cannot be made, or null. */
export function planProblem(phone: string, network: string, amountNgn: number, everyDays: number): string | null {
  const digits = normalisePhone(phone)
  if (!digits) return 'Enter the phone number as 11 digits, starting with 0.'
  if (!MOBILE_NETWORKS.includes(network)) return 'Choose the network.'
  const detected = detectNetwork(digits)
  if (detected && detected !== network) return `That number looks like ${detected}, not ${network}.`
  if (!Number.isInteger(amountNgn) || amountNgn < MIN_TOPUP_NGN || amountNgn > MAX_TOPUP_NGN) {
    return `Choose an amount from ₦${MIN_TOPUP_NGN} to ₦${MAX_TOPUP_NGN.toLocaleString('en-US')}.`
  }
  if (!(TOPUP_EVERY_DAYS as readonly number[]).includes(everyDays)) return 'Choose how often.'
  return null
}

export function loadPlans(store: PlanStore, wallet: string): TopUpPlan[] {
  try {
    const parsed = JSON.parse(store.getItem(key(wallet)) ?? '[]')
    if (!Array.isArray(parsed)) return []
    // Read back through the same rules: a stored plan that no longer passes is dropped.
    return parsed.filter(
      (p): p is TopUpPlan =>
        typeof p?.id === 'string' &&
        typeof p?.nextRunAt === 'number' &&
        planProblem(String(p?.phone), String(p?.network), Number(p?.amountNgn), Number(p?.everyDays)) === null,
    )
  } catch {
    return []
  }
}

export function savePlans(store: PlanStore, wallet: string, plans: TopUpPlan[]): void {
  store.setItem(key(wallet), JSON.stringify(plans))
}

/** A new plan. The first top-up is due straight away. */
export function newPlan(
  phone: string,
  network: string,
  amountNgn: number,
  everyDays: number,
  now: number,
  id: string,
): TopUpPlan {
  const problem = planProblem(phone, network, amountNgn, everyDays)
  if (problem) throw new Error(problem)
  return { id, phone: normalisePhone(phone)!, network, amountNgn, everyDays, nextRunAt: now }
}

/** Plans whose time has come, oldest first. */
export function duePlans(plans: TopUpPlan[], now: number): TopUpPlan[] {
  return plans.filter((p) => p.nextRunAt <= now).sort((a, b) => a.nextRunAt - b.nextRunAt)
}

/**
 * The plan after a top-up went through. The next one is counted from now, not
 * from when it was due: a wallet opened after a month away tops up once, not
 * four times in a row.
 */
export function afterSuccess(plan: TopUpPlan, now: number, orderId: string): TopUpPlan {
  return {
    id: plan.id,
    phone: plan.phone,
    network: plan.network,
    amountNgn: plan.amountNgn,
    everyDays: plan.everyDays,
    nextRunAt: now + plan.everyDays * DAY_MS,
    lastRunAt: now,
    lastOrderId: orderId,
  }
}

/**
 * The plan after an attempt that did not go through. It is not retried on its
 * own until the next day, so a plan that cannot be paid (the allowance has
 * run out) does not try on every page load.
 */
export function afterProblem(plan: TopUpPlan, now: number, problem: string): TopUpPlan {
  return { ...plan, nextRunAt: now + DAY_MS, lastProblem: problem }
}

/**
 * The USDC cost of a naira amount at a rate, in USDC's smallest unit. Rounded
 * to seven decimals exactly as the Airtime screen does, so the order and the
 * payment carry the same figure.
 */
export function costUnits(amountNgn: number, ngnPerUsdc: number): bigint {
  if (!(ngnPerUsdc > 0)) throw new Error('No price is available for USDC right now.')
  return BigInt(Math.round(Number((amountNgn / ngnPerUsdc).toFixed(7)) * Number(USDC_UNITS)))
}

export interface TopUpResult {
  orderId: string
  /** USDC spent from the allowance, as a decimal string. */
  spentUsdc: string
  /** The transaction that drew the USDC out of the wallet. */
  drawHash: string
  /** The transaction that paid the order. */
  payHash: string
}

/**
 * Pay one top-up from the allowance. Throws with a sentence the person can
 * act on. Until the draw succeeds, nothing has left the wallet.
 */
export async function payTopUp(wallet: string, plan: Pick<TopUpPlan, 'phone' | 'network' | 'amountNgn'>): Promise<TopUpResult> {
  const customerRef = getCustomerRef()
  if (!isNairaVerified() || !customerRef) {
    throw new Error('Airtime needs your identity check first. Open Airtime once to complete it.')
  }
  const signerSecret = walletSession.getItem('veil_signer_secret') || walletLocal.getItem('veil_signer_secret')
  if (!signerSecret) throw new Error('Your wallet is locked. Unlock it, then try again.')

  const rate = await getOnrampRate('usdc')
  const units = costUnits(plan.amountNgn, rate)
  const amountUsdc = Number(unitsToUsdc(units))

  // Asked before any order is placed, so a top-up the allowance cannot cover
  // creates nothing. The wallet contract would refuse it anyway.
  const allowance = await readAssistantAllowance(wallet)
  if (!allowance) throw new Error('The assistant has no allowance yet. Give it one first.')
  if (allowance.status === 'expired') throw new Error('The assistant’s allowance has ended. Give it a new one.')
  if (allowance.remaining < units) {
    throw new Error(
      `This top-up costs ${unitsToUsdc(units)} USDC and the allowance has ${unitsToUsdc(allowance.remaining)} USDC left.`,
    )
  }

  // The spending account must be able to hold USDC before any is drawn to it.
  const network = getNetwork()
  const spender = getFeePayerKeypair()
  const horizon = new Horizon.Server(network.horizonUrl)
  const account = await loadPayingAccount(() => horizon.loadAccount(spender.publicKey()))
  const usdc = { code: 'USDC', issuer: getUsdcIssuer() }
  const readiness = receiveReadiness(
    account.balances as unknown as HorizonBalanceLike[],
    spendableNativeXlm(account as unknown as HorizonAccountLike),
    usdc,
  )
  if (readiness === 'need-xlm') throw new Error(needXlmMessage('USDC'))
  if (readiness === 'add-trustline') {
    const trustTx = buildChangeTrustTx({ account, networkPassphrase: network.networkPassphrase, ...usdc })
    trustTx.sign(spender)
    await horizon.submitTransaction(trustTx)
  }

  const order = await payBill({
    customerRef,
    billCategory: 'airtime',
    provider: plan.network,
    customerId: plan.phone,
    amountNgn: plan.amountNgn,
    amountStableCoin: amountUsdc,
    rate,
    coin: 'usdc',
    refundAddress: spender.publicKey(),
  })
  try {
    saveBillOrder({
      orderId: order.id,
      customerRef,
      category: 'airtime',
      provider: plan.network,
      identifier: plan.phone,
      amount: plan.amountNgn,
      amountCrypto: amountUsdc,
      asset: 'usdc',
      status: 'pending',
      time: Date.now(),
    })
  } catch {
    /* a full or blocked store must not stop the payment */
  }

  // The step the wallet contract limits.
  const drawHash = await drawFromAllowance(wallet, units)

  // From here the USDC is in the spending account. If paying the order fails
  // it stays there, in the person's own account, and the message says so.
  let payHash: string
  try {
    payHash = await sendBillPayment({
      destination: order.wallet,
      amount: amountUsdc,
      coin: 'usdc',
      signerSecret,
      skipPasskey: true,
    })
  } catch (err) {
    const why = err instanceof Error ? err.message : String(err)
    throw new Error(
      `${unitsToUsdc(units)} USDC was taken from the allowance into your spending account, but paying for the airtime failed, so the USDC is still there. (${why})`,
    )
  }

  return { orderId: order.id, spentUsdc: unitsToUsdc(units), drawHash, payHash }
}
