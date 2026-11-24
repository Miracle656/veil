/**
 * Veil Connect (pilot): another app opens a Veil window to learn a user's
 * wallet address, ask for a payment, or let the user add money.
 *
 * How the two sides trust each other
 * ----------------------------------
 * The other app loads `/connect.js` and opens `/connect?app=<id>` as a new
 * window. Nothing that matters travels in the URL. The request arrives by
 * `postMessage`, and the browser tells us the sender's origin; we accept it
 * only when that origin is on the app's list below. The answer goes back with
 * `postMessage` to that same origin and to nobody else.
 *
 * So a link pasted in a chat cannot ask for a payment in an app's name: only
 * a page really served from the app's own origin can.
 *
 * What Veil does NOT promise the other app
 * ----------------------------------------
 * The result is a claim made in the user's browser. The app's server must
 * look the transaction hash up on the network and check the destination, the
 * asset and the amount before it credits anything. docs/VEIL_CONNECT.md says
 * how.
 *
 * This file is pure (no window, no SDK) so every rule in it can be tested.
 */

export type ConnectApp = {
  id: string
  /** Shown to the user. */
  name: string
  /** Exact origins allowed to send requests and receive results. */
  origins: string[]
}

/**
 * Apps allowed to use Veil Connect. Adding an app here is the approval step:
 * check who runs it first.
 */
export const CONNECT_APPS: Record<string, ConnectApp> = {
  stakesync: {
    id: 'stakesync',
    name: 'Stake-Sync',
    origins: ['https://usestakesync.xyz', 'https://www.usestakesync.xyz'],
  },
}

/**
 * Test entries for a partner who is still building. They answer to a page on
 * the partner developer's own machine, so they are kept apart from the real
 * list, carry "(test)" in the name the user sees, and are removed when the
 * partner goes live.
 */
export const CONNECT_TEST_APPS: Record<string, ConnectApp> = {
  'stakesync-test': {
    id: 'stakesync-test',
    name: 'Stake-Sync (test)',
    origins: ['http://localhost:3000'],
  },
}

/** A stand-in app for building against a local page. Never on in production. */
const DEMO_APP: ConnectApp = {
  id: 'demo',
  name: 'Demo app',
  origins: ['http://localhost:5500', 'http://127.0.0.1:5500', 'http://localhost:8080'],
}

export function getConnectApp(id: string | null | undefined, allowDemo = false): ConnectApp | null {
  if (!id) return null
  if (allowDemo && id === DEMO_APP.id) return DEMO_APP
  if (Object.prototype.hasOwnProperty.call(CONNECT_APPS, id)) return CONNECT_APPS[id]
  if (Object.prototype.hasOwnProperty.call(CONNECT_TEST_APPS, id)) return CONNECT_TEST_APPS[id]
  return null
}

export function isAllowedOrigin(app: ConnectApp, origin: string): boolean {
  return app.origins.includes(origin)
}

// ── Requests ────────────────────────────────────────────────────────────────

export type ConnectAsset = 'USDC' | 'XLM'

export type ConnectRequest =
  | { type: 'connect'; id: string }
  | { type: 'fund'; id: string }
  // Opens the person's own cash-out to their own bank. It carries no amount
  // and no bank: an app never moves a person's money to a bank through Veil.
  | { type: 'cashout'; id: string }
  | { type: 'pay'; id: string; to: string; amount: string; asset: ConnectAsset; reference: string }

export type ParsedRequest =
  | { ok: true; request: ConnectRequest }
  | { ok: false; reason: string }

/** A Stellar account (G…) or contract (C…) address: 56 base32 characters. */
const ADDRESS = /^[GC][A-Z2-7]{55}$/
/** Up to seven decimals, which is all Stellar can carry. */
const AMOUNT = /^\d{1,12}(\.\d{1,7})?$/
const REFERENCE = /^[A-Za-z0-9_-]{1,64}$/
const REQUEST_ID = /^[A-Za-z0-9_-]{8,64}$/

/** The most one request may ask for. A pilot limit, not a law of nature. */
export const MAX_PAY_AMOUNT = 1000

function refuse(reason: string): ParsedRequest {
  return { ok: false, reason }
}

/**
 * Check a request that arrived from another app. Everything in it is
 * untrusted: it is rebuilt field by field, and anything unexpected is dropped.
 */
export function parseConnectRequest(raw: unknown): ParsedRequest {
  if (typeof raw !== 'object' || raw === null) return refuse('The request is not readable.')
  const r = raw as Record<string, unknown>

  const id = r.id
  if (typeof id !== 'string' || !REQUEST_ID.test(id)) return refuse('The request has no valid id.')

  if (r.type === 'connect') return { ok: true, request: { type: 'connect', id } }
  if (r.type === 'fund') return { ok: true, request: { type: 'fund', id } }
  if (r.type === 'cashout') return { ok: true, request: { type: 'cashout', id } }
  if (r.type !== 'pay') return refuse('The request asks for something Veil does not do.')

  const { to, amount, reference } = r
  const asset = r.asset ?? 'USDC'

  if (typeof to !== 'string' || !ADDRESS.test(to)) {
    return refuse('The payment address is not a Stellar address.')
  }
  if (asset !== 'USDC' && asset !== 'XLM') {
    return refuse('Only USDC and XLM can be paid this way.')
  }
  if (typeof amount !== 'string' || !AMOUNT.test(amount)) {
    return refuse('The amount is not a plain number with at most seven decimals.')
  }
  const value = Number(amount)
  if (!(value > 0)) return refuse('The amount must be more than zero.')
  if (value > MAX_PAY_AMOUNT) {
    return refuse(`The amount is over the limit of ${MAX_PAY_AMOUNT} for one payment.`)
  }
  if (typeof reference !== 'string' || !REFERENCE.test(reference)) {
    return refuse('The payment reference must be 1 to 64 letters, digits, "-" or "_".')
  }

  return { ok: true, request: { type: 'pay', id, to, amount, asset, reference } }
}

// ── Messages ────────────────────────────────────────────────────────────────

/** Every message either side sends carries this, so strays are ignored. */
export const CONNECT_CHANNEL = 'veil-connect'
export const CONNECT_VERSION = 1

export type ConnectResult =
  | { ok: true; type: 'connect'; address: string; network: string }
  // `from` is the address the money left. It is the wallet's spending account
  // (G…), not the wallet address `connect` shares (C…), so an app that expects
  // the payment to come from the connected address will not find it.
  | { ok: true; type: 'pay'; hash: string; reference: string; network: string; from: string }
  | { ok: true; type: 'fund' }
  | { ok: true; type: 'cashout' }
  | { ok: false; error: 'cancelled' | 'refused'; reason?: string }

export function readyMessage() {
  return { channel: CONNECT_CHANNEL, v: CONNECT_VERSION, kind: 'ready' as const }
}

export function resultMessage(requestId: string, result: ConnectResult) {
  return { channel: CONNECT_CHANNEL, v: CONNECT_VERSION, kind: 'result' as const, id: requestId, result }
}

/** The request inside an incoming message, or null when it is not ours. */
export function requestFromMessage(data: unknown): unknown | null {
  if (typeof data !== 'object' || data === null) return null
  const d = data as Record<string, unknown>
  if (d.channel !== CONNECT_CHANNEL || d.kind !== 'request') return null
  return d.request ?? null
}

// ── What the Veil window remembers while the user signs in or pays ──────────

export type PendingConnect = {
  appId: string
  /** The origin the request really came from. Results go here only. */
  origin: string
  request: ConnectRequest
}

export const PENDING_KEY = 'veil_connect_pending'

export function encodePending(pending: PendingConnect): string {
  return JSON.stringify(pending)
}

/**
 * Read back what was stored. Re-checked in full: session storage is ours, but
 * a value that no longer passes the rules is dropped, not trusted.
 */
export function decodePending(raw: string | null, allowDemo = false): PendingConnect | null {
  if (!raw) return null
  let parsed: unknown
  try { parsed = JSON.parse(raw) } catch { return null }
  if (typeof parsed !== 'object' || parsed === null) return null
  const p = parsed as Record<string, unknown>
  const app = getConnectApp(typeof p.appId === 'string' ? p.appId : null, allowDemo)
  if (!app || typeof p.origin !== 'string' || !isAllowedOrigin(app, p.origin)) return null
  const request = parseConnectRequest(p.request)
  if (!request.ok) return null
  return { appId: app.id, origin: p.origin, request: request.request }
}

/** The send-page link for a payment request. The issuer comes from Veil, never from the app. */
export function sendPathFor(
  request: Extract<ConnectRequest, { type: 'pay' }>,
  usdcIssuer: string,
): string {
  const q = new URLSearchParams({ to: request.to, amount: request.amount })
  if (request.asset === 'USDC') {
    q.set('asset', 'USDC')
    q.set('issuer', usdcIssuer)
    q.set('lock', 'asset')
  }
  return `/send?${q.toString()}`
}
