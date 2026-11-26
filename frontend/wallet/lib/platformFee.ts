/**
 * The Veil fee: what we charge, and where it goes.
 *
 * The mobile app has charged this since 2026-10-12; the web wallet did not, so
 * the same cash-out cost nothing here and 0.1 USDC there. This is the port, and
 * it is deliberately a copy of `frontend/mobile/lib/platformFee.ts` rather than
 * a shared module: the two read different environment variables and the shapes
 * they validate are the one thing that must not drift silently, so the
 * duplication is visible and the tests on both sides pin the same contract.
 *
 * ## Why it is collected on-chain and not by the backend
 *
 * Money never passes through wraith. On an onramp Linq delivers crypto straight
 * to the user's address; on a cash-out the user's wallet pays an address Linq
 * gave us. wraith is an API proxy that holds nothing, so there is nothing for it
 * to take a cut of. Linq confirmed on 2026-09-30 that they have no developer-fee
 * structure and suggested exactly this: charge the user and divert it to a
 * treasury wallet in the same transaction.
 *
 * Stellar does that natively. A classic transaction carries up to 100
 * operations and is signed once, so the fee rides alongside the payment it
 * belongs to and the two either both settle or neither does. No contract change,
 * which matters — no Veil contract is upgradeable, so anything needing new
 * on-chain logic would mean a new factory and new addresses for every user.
 *
 * ## Why the amount comes from the server
 *
 * A number compiled into a deployment can only be changed by rebuilding.
 * Waiving the fee, running a promotion or fixing a mistake is one environment
 * variable instead.
 *
 * ## Why every failure means no fee
 *
 * This is a payment the user did not ask for. If the fee cannot be read, or
 * arrives malformed, the transaction goes out without it. The alternative —
 * blocking a cash-out because our own fee endpoint was asleep on a free Render
 * dyno — would be holding someone's money hostage to our billing.
 */

const BASE_URL = process.env.NEXT_PUBLIC_WRAITH_URL?.replace(/\/+$/, '') ?? ''

/** Short, because the user is waiting on a transaction behind it. */
const TIMEOUT_MS = 4_000

export interface PlatformFee {
  /** Whole units, as a decimal string. */
  amount: string
  assetCode: string
  /** Null for native XLM, which has no issuer and needs no trustline. */
  assetIssuer: string | null
  destination: string
}

/** A classic `G…` account. A contract cannot be paid by a classic payment. */
function isClassicAddress(value: unknown): value is string {
  return typeof value === 'string' && /^G[A-Z2-7]{55}$/.test(value)
}

function parseFee(raw: unknown, destination: string): PlatformFee | null {
  if (!raw || typeof raw !== 'object') return null
  const data = raw as Record<string, unknown>

  const amount = typeof data['amount'] === 'string' ? data['amount'].trim() : ''
  const assetCode = typeof data['assetCode'] === 'string' ? data['assetCode'].trim() : ''
  const issuer = data['assetIssuer']

  // Checked here as well as on the server. The client builds the transaction,
  // so it is the last place that can refuse to send a payment it cannot
  // describe — and it should not have to assume the server got it right.
  if (!/^\d+(\.\d{1,7})?$/.test(amount) || Number(amount) <= 0) return null
  if (!assetCode || assetCode.length > 12) return null

  // XLM carries no issuer; everything else must have a real one.
  const assetIssuer = assetCode === 'XLM' ? null : issuer
  if (assetCode !== 'XLM' && !isClassicAddress(assetIssuer)) return null

  return { amount, assetCode, assetIssuer: assetIssuer as string | null, destination }
}

/**
 * The fee for one asset, or null for "do not charge".
 *
 * `assetCode` is the asset the user is about to send — the fee is always
 * denominated in it, so a sender who can afford the payment can afford the fee.
 * Pass 'XLM' for a native payment.
 *
 * Deliberately not cached: a fee held over from an earlier page load is one the
 * user was shown but never agreed to.
 */
/**
 * The fee for sending `amount` of `assetCode`, or null for "do not charge".
 *
 * `amount` is passed to the server so the fee can scale with it. A flat fee is
 * regressive and the numbers were stark: 0.1 USDC is 10% of a 1 USDC send and
 * 0.01% of a 1,000 one, so the people being onboarded with a thousand naira
 * paid the heaviest rate. The policy — flat, percent, floor, cap — lives
 * entirely on the server, so changing it again needs no new client.
 *
 * Omitting `amount` asks for the floor, which is what this did before it could
 * say what was being sent.
 */
export async function fetchPlatformFee(assetCode: string, amount?: number): Promise<PlatformFee | null> {
  if (!BASE_URL) return null

  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS)
  try {
    const query = amount !== undefined && Number.isFinite(amount) && amount > 0
      ? `?amount=${encodeURIComponent(String(amount))}`
      : ''
    const res = await fetch(`${BASE_URL}/fees${query}`, { signal: controller.signal })
    if (!res.ok) return null
    const data = (await res.json()) as Record<string, unknown>
    if (data['enabled'] !== true) return null

    const fees = data['fees']
    if (!fees || typeof fees !== 'object') return null

    const entry = (fees as Record<string, unknown>)[assetCode]
    if (!entry) return null

    const destination = (entry as Record<string, unknown>)['destination']
    if (!isClassicAddress(destination)) return null

    const fee = parseFee(entry, destination)
    // The asset we asked about must be the asset we were handed.
    return fee && fee.assetCode === assetCode ? fee : null
  } catch {
    // Unreachable, slow, or malformed: no fee. Never a blocked transaction.
    return null
  } finally {
    clearTimeout(timer)
  }
}
