/**
 * Veil Connect (pilot): another app opens a Veil window to learn a user's
 * wallet address, ask for a payment, ask the user to approve a call to the
 * app's own contract, or let the user add money.
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
  /**
   * The contracts this app may ask a user to call, per network, written in
   * full. An app with no list cannot ask for a contract call at all. Adding a
   * contract here is an approval step like adding the app: read the contract
   * first, because the user will be asked to approve what it does.
   */
  contracts?: Partial<Record<ConnectNetwork, string[]>>
  /** Any contract may be asked for. Only ever set on the local demo app. */
  anyContract?: boolean
}

export type ConnectNetwork = 'mainnet' | 'testnet'

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
  anyContract: true,
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

/**
 * May this app ask a user to call this contract on this network?
 *
 * The list is the whole answer. Without it an approved app could ask a user
 * to approve a call to any contract on the network, including a token's own
 * `transfer`, and the only thing between the user and that would be how
 * carefully they read one screen.
 */
export function isAllowedContract(app: ConnectApp, network: ConnectNetwork, contract: string): boolean {
  if (app.anyContract === true) return true
  return (app.contracts?.[network] ?? []).includes(contract)
}

// ── Requests ────────────────────────────────────────────────────────────────

export type ConnectAsset = 'USDC' | 'XLM'

/** The kinds of value a contract call may carry. Lists and maps are not in the pilot. */
export const INVOKE_ARG_TYPES = [
  'address', 'bool', 'u32', 'i32', 'u64', 'i64', 'u128', 'i128', 'string', 'symbol', 'bytes',
] as const
export type InvokeArgType = (typeof INVOKE_ARG_TYPES)[number]

/** One argument. The value is always text, so a large number survives JSON unchanged. */
export type InvokeArg = { type: InvokeArgType; value: string }

export const MAX_INVOKE_ARGS = 12

export type ConnectRequest =
  | { type: 'connect'; id: string }
  | { type: 'fund'; id: string }
  // Opens the person's own cash-out to their own bank. It carries no amount
  // and no bank: an app never moves a person's money to a bank through Veil.
  | { type: 'cashout'; id: string }
  | { type: 'pay'; id: string; to: string; amount: string; asset: ConnectAsset; reference: string }
  // Ask the person to approve one call to one of the app's own contracts.
  // Veil builds the transaction itself from these three fields; an app never
  // hands Veil a ready-made transaction to sign.
  | { type: 'invoke'; id: string; contract: string; method: string; args: InvokeArg[] }

export type ParsedRequest =
  | { ok: true; request: ConnectRequest }
  | { ok: false; reason: string }

/** A Stellar account (G…) or contract (C…) address: 56 base32 characters. */
const ADDRESS = /^[GC][A-Z2-7]{55}$/
/** Up to seven decimals, which is all Stellar can carry. */
const AMOUNT = /^\d{1,12}(\.\d{1,7})?$/
const REFERENCE = /^[A-Za-z0-9_-]{1,64}$/
const REQUEST_ID = /^[A-Za-z0-9_-]{8,64}$/

const CONTRACT = /^C[A-Z2-7]{55}$/
/** A Soroban function name is a symbol: up to 32 of these characters. */
const METHOD = /^[A-Za-z_][A-Za-z0-9_]{0,31}$/
const SYMBOL = /^[A-Za-z0-9_]{1,32}$/
const WHOLE_NUMBER = /^-?\d{1,78}$/
const HEX = /^([0-9a-fA-F]{2}){0,1024}$/
const MAX_STRING = 256

const INT_BITS: Partial<Record<InvokeArgType, { bits: number; signed: boolean }>> = {
  u32: { bits: 32, signed: false },
  i32: { bits: 32, signed: true },
  u64: { bits: 64, signed: false },
  i64: { bits: 64, signed: true },
  u128: { bits: 128, signed: false },
  i128: { bits: 128, signed: true },
}

/** Why one argument cannot be used, or null when it is fine. */
function argProblem(type: InvokeArgType, value: string): string | null {
  const int = INT_BITS[type]
  if (int) {
    if (!WHOLE_NUMBER.test(value)) return 'is not a whole number'
    const n = BigInt(value)
    const min = int.signed ? -(1n << BigInt(int.bits - 1)) : 0n
    const max = int.signed ? (1n << BigInt(int.bits - 1)) - 1n : (1n << BigInt(int.bits)) - 1n
    return n < min || n > max ? `does not fit in ${type}` : null
  }
  if (type === 'address') return ADDRESS.test(value) ? null : 'is not a Stellar address'
  if (type === 'bool') return value === 'true' || value === 'false' ? null : 'is not true or false'
  if (type === 'symbol') return SYMBOL.test(value) ? null : 'is not a symbol'
  if (type === 'bytes') return HEX.test(value) ? null : 'is not hex'
  return value.length <= MAX_STRING ? null : `is longer than ${MAX_STRING} characters`
}

function parseInvokeArgs(raw: unknown): { ok: true; args: InvokeArg[] } | { ok: false; reason: string } {
  if (raw === undefined) return { ok: true, args: [] }
  if (!Array.isArray(raw)) return { ok: false, reason: 'The call arguments are not a list.' }
  if (raw.length > MAX_INVOKE_ARGS) {
    return { ok: false, reason: `A call can carry at most ${MAX_INVOKE_ARGS} arguments.` }
  }
  const args: InvokeArg[] = []
  for (let i = 0; i < raw.length; i++) {
    const a = raw[i] as Record<string, unknown> | null
    const type = a && typeof a === 'object' ? a.type : undefined
    const value = a && typeof a === 'object' ? a.value : undefined
    if (typeof type !== 'string' || !(INVOKE_ARG_TYPES as readonly string[]).includes(type)) {
      return { ok: false, reason: `Argument ${i + 1} has a type Veil does not carry.` }
    }
    if (typeof value !== 'string') {
      return { ok: false, reason: `Argument ${i + 1} must be given as text.` }
    }
    const problem = argProblem(type as InvokeArgType, value)
    if (problem) return { ok: false, reason: `Argument ${i + 1} ${problem}.` }
    args.push({ type: type as InvokeArgType, value })
  }
  return { ok: true, args }
}

/** A Stellar text memo holds 28 bytes. A reference is plain ASCII, so 28 characters. */
export const MEMO_TEXT_MAX = 28

/**
 * The text memo a payment carries for this reference, or null.
 *
 * The reference goes on chain unchanged or not at all. A longer one is never
 * cut to fit: a shortened reference matches nothing on the app's side and can
 * collide with another order. The app is told which happened (`memo` in the
 * result), so it never has to guess.
 */
export function referenceMemo(reference: string): string | null {
  return reference.length <= MEMO_TEXT_MAX ? reference : null
}

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
  if (r.type === 'invoke') {
    const { contract, method } = r
    if (typeof contract !== 'string' || !CONTRACT.test(contract)) {
      return refuse('The contract is not a Stellar contract address.')
    }
    if (typeof method !== 'string' || !METHOD.test(method)) {
      return refuse('The function name is not a valid contract function name.')
    }
    const parsed = parseInvokeArgs(r.args)
    if (!parsed.ok) return refuse(parsed.reason)
    return { ok: true, request: { type: 'invoke', id, contract, method, args: parsed.args } }
  }
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
  // `memo` is the text memo on the payment: the reference, or null when the
  // reference was too long to carry (see referenceMemo).
  | { ok: true; type: 'pay'; hash: string; reference: string; network: string; from: string; memo: string | null }
  // `signer` is the wallet address (C…) that approved the call, the one
  // `connect` shares. `from` is the spending account (G…) that carried the
  // transaction and paid its fee. `result` is what the contract returned, as
  // base64 XDR (an ScVal), or null when it returned nothing readable.
  | {
      ok: true
      type: 'invoke'
      hash: string
      network: string
      contract: string
      method: string
      signer: string
      from: string
      result: string | null
    }
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
  // The app's reference, written on the payment so its server can tell whose
  // payment a hash is without trusting the browser that reported it.
  const memo = referenceMemo(request.reference)
  if (memo) {
    q.set('memo', memo)
    q.set('memo_type', 'text')
  }
  return `/send?${q.toString()}`
}
