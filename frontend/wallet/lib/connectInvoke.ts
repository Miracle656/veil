/**
 * Veil Connect: reading what a contract call asks the person to approve.
 *
 * An app asks for "call `method` on `contract`". What that call really does is
 * decided by the contract, not by the request, so Veil simulates it and reads
 * the authorisations the network says are needed. Each one is a tree: the call
 * the person approves and every call it is allowed to make in their name.
 *
 * This module turns those trees into lines a person can read, and refuses the
 * ones nobody should approve from another app's window:
 *
 *  - an approval by an address that is not theirs;
 *  - any call into their own wallet contract (adding a signer or a guardian
 *    is how a wallet is taken over);
 *  - `approve` on any token, which hands out a standing allowance that
 *    outlives this window;
 *  - deploying a contract;
 *  - sending more XLM or USDC than one Connect payment may carry.
 *
 * Everything the person does approve is shown: nothing in a tree is left out.
 *
 * Pure: no window, no network. The caller supplies the simulated entries.
 */
import { Address, hash, nativeToScVal, scValToNative, xdr } from '@stellar/stellar-sdk'

import { MAX_PAY_AMOUNT, type InvokeArg } from './connect'

/** Turn the request's text arguments into the values the contract receives. */
export function invokeArgsToScVals(args: InvokeArg[]): xdr.ScVal[] {
  return args.map(({ type, value }) => {
    if (type === 'address') return nativeToScVal(value, { type: 'address' })
    if (type === 'bool') return xdr.ScVal.scvBool(value === 'true')
    if (type === 'string') return nativeToScVal(value, { type: 'string' })
    if (type === 'symbol') return nativeToScVal(value, { type: 'symbol' })
    if (type === 'bytes') return nativeToScVal(Buffer.from(value, 'hex'), { type: 'bytes' })
    return nativeToScVal(BigInt(value), { type })
  })
}

/** A value as a person can read it. Addresses are always written in full. */
export function showScVal(value: xdr.ScVal): string {
  try {
    const kind = value.switch().name
    if (kind === 'scvAddress') return Address.fromScVal(value).toString()
    if (kind === 'scvBytes') return `0x${Buffer.from(value.bytes()).toString('hex')}`
    if (kind === 'scvVoid') return '(nothing)'
    const native = scValToNative(value)
    if (typeof native === 'bigint') return native.toString()
    if (typeof native === 'string' || typeof native === 'number' || typeof native === 'boolean') {
      return String(native)
    }
    return JSON.stringify(native, (_k, v) => (typeof v === 'bigint' ? v.toString() : v))
  } catch {
    return '(a value Veil cannot display)'
  }
}

/** Who is being asked to approve: the passkey wallet, or the spending account. */
export type ApprovalSigner = 'wallet' | 'spending'

export type ApprovedCall = {
  /** 0 for the call approved directly, 1 for a call it makes, and so on. */
  depth: number
  contract: string
  method: string
  args: string[]
}

/** Money leaving one of the person's own addresses. */
export type Movement = {
  /** The token contract, in full. */
  token: string
  /** 'XLM' or 'USDC' when the token is one Veil knows; null otherwise. */
  code: string | null
  from: ApprovalSigner
  /** Where it goes, in full; null when it is burned. */
  to: string | null
  /** The amount in the token's smallest unit. */
  raw: bigint
  /** The amount in whole units, for a token Veil knows; null otherwise. */
  amount: string | null
}

export type Approval = { signer: ApprovalSigner; calls: ApprovedCall[] }

export type AuthReading =
  | { ok: true; approvals: Approval[]; movements: Movement[]; digest: string }
  | { ok: false; reason: string }

export type AuthContext = {
  /** The person's wallet (C…). */
  wallet: string
  /** The person's spending account (G…), which carries the transaction. */
  spending: string
  /** Token contracts Veil can name, by contract id. Both use seven decimals. */
  knownTokens: Record<string, string>
}

const STROOPS = 10_000_000n

function wholeUnits(raw: bigint): string {
  const sign = raw < 0n ? '-' : ''
  const abs = raw < 0n ? -raw : raw
  const frac = (abs % STROOPS).toString().padStart(7, '0').replace(/0+$/, '')
  return `${sign}${abs / STROOPS}${frac ? `.${frac}` : ''}`
}

function refuse(reason: string): AuthReading {
  return { ok: false, reason }
}

function addressOf(value: xdr.ScVal | undefined): string | null {
  try {
    return value && value.switch().name === 'scvAddress' ? Address.fromScVal(value).toString() : null
  } catch {
    return null
  }
}

function amountOf(value: xdr.ScVal | undefined): bigint | null {
  try {
    if (!value || value.switch().name !== 'scvI128') return null
    const n = scValToNative(value)
    return typeof n === 'bigint' ? n : null
  } catch {
    return null
  }
}

/**
 * If this call takes a token out of an address, say whose, where to and how
 * much. The four shapes are the token interface's: anything else is not read
 * as a movement and is simply shown as a call.
 */
function tokenMovement(
  method: string,
  args: xdr.ScVal[],
): { from: string; to: string | null; raw: bigint } | null {
  let from: string | null = null
  let to: string | null = null
  let raw: bigint | null = null
  if (method === 'transfer' && args.length === 3) {
    from = addressOf(args[0]); to = addressOf(args[1]); raw = amountOf(args[2])
    if (to === null) return null
  } else if (method === 'transfer_from' && args.length === 4) {
    from = addressOf(args[1]); to = addressOf(args[2]); raw = amountOf(args[3])
    if (to === null) return null
  } else if (method === 'burn' && args.length === 2) {
    from = addressOf(args[0]); raw = amountOf(args[1])
  } else if (method === 'burn_from' && args.length === 3) {
    from = addressOf(args[1]); raw = amountOf(args[2])
  } else {
    return null
  }
  return from !== null && raw !== null ? { from, to, raw } : null
}

/**
 * Read the authorisations a simulated call needs.
 *
 * `digest` identifies exactly what was read: who approves, and every call in
 * every tree. The same request is simulated again when the person agrees, and
 * if the digest differs they are shown nothing was sent and asked to look
 * again, rather than signing something they did not see.
 */
export function readAuthEntries(entries: xdr.SorobanAuthorizationEntry[], ctx: AuthContext): AuthReading {
  const approvals: Approval[] = []
  const movements: Movement[] = []
  const parts: string[] = []

  for (const entry of entries) {
    const cred = entry.credentials()
    let signer: ApprovalSigner
    if (cred.switch().value === xdr.SorobanCredentialsType.sorobanCredentialsAddress().value) {
      const who = Address.fromScAddress(cred.address().address()).toString()
      if (who !== ctx.wallet) {
        return refuse('This call needs approval from an address that is not your wallet, so Veil cannot make it.')
      }
      signer = 'wallet'
    } else {
      // The transaction's own source: the spending account. Its signature on
      // the transaction approves this tree, so it is shown like any other.
      signer = 'spending'
    }
    const owner = signer === 'wallet' ? ctx.wallet : ctx.spending

    const calls: ApprovedCall[] = []
    // Held in an object so the checks below still see it after the closure writes it.
    const stop: { reason: string | null } = { reason: null }
    const walk = (node: xdr.SorobanAuthorizedInvocation, depth: number) => {
      if (stop.reason) return
      const fn = node.function()
      if (fn.switch().value !== xdr.SorobanAuthorizedFunctionType.sorobanAuthorizedFunctionTypeContractFn().value) {
        stop.reason = 'This call would deploy a contract in your name. Veil does not approve that from another app.'
        return
      }
      const call = fn.contractFn()
      const contract = Address.fromScAddress(call.contractAddress()).toString()
      const method = call.functionName().toString()
      const args = call.args()

      if (contract === ctx.wallet) {
        stop.reason = 'This call would change your wallet itself (its signers or settings). Veil does not approve that from another app.'
        return
      }
      if (method === 'approve') {
        stop.reason = 'This call would let a contract keep spending from your wallet later. Veil does not approve that from another app.'
        return
      }

      const moved = tokenMovement(method, args)
      if (moved && moved.from === owner) {
        const code = ctx.knownTokens[contract] ?? null
        if (moved.raw < 0n) {
          stop.reason = 'This call moves a negative amount, which Veil does not approve.'
          return
        }
        if (code && moved.raw > BigInt(MAX_PAY_AMOUNT) * STROOPS) {
          stop.reason = `This call would send more than ${MAX_PAY_AMOUNT} ${code}, which is over the limit for one request.`
          return
        }
        movements.push({
          token: contract,
          code,
          from: signer,
          to: moved.to,
          raw: moved.raw,
          amount: code ? wholeUnits(moved.raw) : null,
        })
      }

      calls.push({ depth, contract, method, args: args.map(showScVal) })
      for (const sub of node.subInvocations()) walk(sub, depth + 1)
    }
    walk(entry.rootInvocation(), 0)
    if (stop.reason) return refuse(stop.reason)

    approvals.push({ signer, calls })
    parts.push(`${signer}:${entry.rootInvocation().toXDR('base64')}`)
  }

  parts.sort()
  return { ok: true, approvals, movements, digest: hash(Buffer.from(parts.join('|'))).toString('hex') }
}
