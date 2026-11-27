/**
 * Spending from an allowance the wallet granted.
 *
 * A Veil wallet can `approve(spender, token, amount, expiry)`: from then on the
 * spender may move up to that much of that one token out of the wallet without
 * the passkey, and the wallet contract counts every transfer down and refuses
 * anything beyond what is left, or after the expiry. That cap is enforced on
 * chain, by the wallet itself. Nothing in this file can exceed it.
 *
 * How a spend is authorised is not obvious, and a simulation does not reveal
 * it. It was worked out and proven with real transactions on the exact wallet
 * code that runs on mainnet (docs/ALLOWANCE_SPEND.md has the hashes):
 *
 *  1. The call is the token's `transfer(from = wallet, to, amount)`.
 *  2. The wallet's authorisation entry is NOT signed. In place of a signature
 *     it carries the spender's address. The wallet's `__check_auth` reads that
 *     as "an allowance spend by this address" and calls
 *     `spender.require_auth()`.
 *  3. That inner `require_auth` is satisfied only by a second entry whose root
 *     is the wallet's `__check_auth` call itself, with the exact arguments the
 *     network passes: the payload hash, the spender, and the list of calls
 *     being authorised.
 *  4. When the spender is the transaction's own source account, that second
 *     entry needs no signature of its own: signing the transaction covers it.
 *
 * Here the spender is the wallet's spending account, which also pays the fee,
 * so step 4 applies.
 *
 * The parts that build the entries are pure, so they are tested without a
 * network. `spendFromAllowance` adds the simulate / sign / submit around them.
 */
import {
  Address,
  Contract,
  Keypair,
  Operation,
  TransactionBuilder,
  hash,
  nativeToScVal,
  rpc as SorobanRpc,
  xdr,
} from '@stellar/stellar-sdk'

import { inclusionFee } from './fees'
import { describeFailure } from './walletInvoke'

/** The wallet contract's own refusals on this path (contracts/invisible_wallet, WalletError). */
export const ALLOWANCE_ERRORS: Record<number, string> = {
  3: 'The wallet refused: an allowance can only be used to send that one token out of the wallet.',
  17: 'That is more than the allowance has left.',
  18: 'The allowance has expired.',
  27: 'The amount cannot be negative.',
}

/** A refusal with a sentence a person can act on. Nothing was sent. */
export class AllowanceSpendRefused extends Error {
  constructor(message: string, readonly code: number | null = null) {
    super(message)
    this.name = 'AllowanceSpendRefused'
  }
}

export interface AllowanceSpendInput {
  /** The wallet (C…) the money leaves. */
  wallet: string
  /** The address the allowance was granted to (G…). */
  spender: string
  /** The token contract (C…). The allowance is for this token only. */
  token: string
  /** Where the money goes. */
  to: string
  /** Amount in the token's smallest unit. */
  amount: bigint
}

export interface AllowanceSpendAuth {
  /** `token.transfer(wallet, to, amount)` arguments, in order. */
  transferArgs: xdr.ScVal[]
  /** The wallet's entry: unsigned, carrying the spender's address. */
  walletEntry: xdr.SorobanAuthorizationEntry
  /** The spender's entry, rooted at the wallet's `__check_auth`. */
  spenderEntry: xdr.SorobanAuthorizationEntry
  /** The 32-byte hash the wallet is asked to approve. */
  payload: Buffer
}

/** A fresh nonce for the wallet's entry. The network refuses a reused one. */
export function randomAuthNonce(): xdr.Int64 {
  const bytes = new Uint8Array(8)
  crypto.getRandomValues(bytes)
  let n = 0n
  for (const b of bytes) n = (n << 8n) | BigInt(b)
  // A positive signed 64-bit value.
  return xdr.Int64.fromString((n & 0x7fffffffffffffffn).toString())
}

/**
 * Build the two authorisation entries for one allowance spend.
 *
 * Nobody signs the wallet's entry, so its nonce and expiry ledger are simply
 * chosen here. The spender's approval covers `payload`, which binds the
 * network, that nonce, that expiry and this exact transfer: changing any of
 * them changes the hash and the network refuses the transaction.
 */
export function buildAllowanceSpendAuth(
  input: AllowanceSpendInput,
  opts: { networkPassphrase: string; nonce: xdr.Int64; validUntilLedger: number },
): AllowanceSpendAuth {
  const { wallet, spender, token, to, amount } = input
  if (amount <= 0n) throw new AllowanceSpendRefused('The amount must be more than zero.')

  const transferArgs = [
    new Address(wallet).toScVal(),
    new Address(to).toScVal(),
    nativeToScVal(amount, { type: 'i128' }),
  ]

  const rootInvocation = new xdr.SorobanAuthorizedInvocation({
    function: xdr.SorobanAuthorizedFunction.sorobanAuthorizedFunctionTypeContractFn(
      new xdr.InvokeContractArgs({
        contractAddress: new Address(token).toScAddress(),
        functionName: 'transfer',
        args: transferArgs,
      }),
    ),
    subInvocations: [],
  })

  const walletEntry = new xdr.SorobanAuthorizationEntry({
    credentials: xdr.SorobanCredentials.sorobanCredentialsAddress(
      new xdr.SorobanAddressCredentials({
        address: new Address(wallet).toScAddress(),
        nonce: opts.nonce,
        signatureExpirationLedger: opts.validUntilLedger,
        // Not a signature: the spender's address. This is what selects the
        // allowance path in the wallet's __check_auth.
        signature: new Address(spender).toScVal(),
      }),
    ),
    rootInvocation,
  })

  const preimage = xdr.HashIdPreimage.envelopeTypeSorobanAuthorization(
    new xdr.HashIdPreimageSorobanAuthorization({
      networkId: hash(Buffer.from(opts.networkPassphrase)),
      nonce: opts.nonce,
      invocation: rootInvocation,
      signatureExpirationLedger: opts.validUntilLedger,
    }),
  )
  const payload = hash(preimage.toXDR())

  // The one call being authorised, as the network describes it to
  // __check_auth: Context::Contract(ContractContext { args, contract, fn_name }).
  // The map's keys must be in this (sorted) order.
  const context = xdr.ScVal.scvVec([
    xdr.ScVal.scvSymbol('Contract'),
    xdr.ScVal.scvMap([
      new xdr.ScMapEntry({ key: xdr.ScVal.scvSymbol('args'), val: xdr.ScVal.scvVec(transferArgs) }),
      new xdr.ScMapEntry({ key: xdr.ScVal.scvSymbol('contract'), val: new Address(token).toScVal() }),
      new xdr.ScMapEntry({ key: xdr.ScVal.scvSymbol('fn_name'), val: xdr.ScVal.scvSymbol('transfer') }),
    ]),
  ])

  const spenderEntry = new xdr.SorobanAuthorizationEntry({
    // The spender is the transaction's source account, so the transaction's
    // own signature is its approval.
    credentials: xdr.SorobanCredentials.sorobanCredentialsSourceAccount(),
    rootInvocation: new xdr.SorobanAuthorizedInvocation({
      function: xdr.SorobanAuthorizedFunction.sorobanAuthorizedFunctionTypeContractFn(
        new xdr.InvokeContractArgs({
          contractAddress: new Address(wallet).toScAddress(),
          functionName: '__check_auth',
          args: [xdr.ScVal.scvBytes(payload), new Address(spender).toScVal(), xdr.ScVal.scvVec([context])],
        }),
      ),
      subInvocations: [],
    }),
  })

  return { transferArgs, walletEntry, spenderEntry, payload }
}

/**
 * The wallet contract's error code inside a refused simulation, or null.
 *
 * The error text only ever says `Error(Auth, InvalidAction)`. The wallet's own
 * reason (over the allowance, expired) is in the diagnostic events, as an
 * `Error(Contract, #N)` value. Read from the last event backwards: the wallet's
 * refusal is what caused the rest.
 */
export function contractErrorCode(events: readonly xdr.DiagnosticEvent[] | undefined): number | null {
  if (!events) return null
  for (let i = events.length - 1; i >= 0; i--) {
    try {
      const body = events[i].event().body().v0()
      for (const val of [...body.topics(), body.data()]) {
        const found = errorCodeIn(val)
        if (found !== null) return found
      }
    } catch {
      /* not an event we can read */
    }
  }
  return null
}

function errorCodeIn(val: xdr.ScVal): number | null {
  const kind = val.switch().name
  if (kind === 'scvError') {
    const err = val.error()
    return err.switch().name === 'sceContract' ? Number(err.contractCode()) : null
  }
  if (kind === 'scvVec') {
    for (const item of val.vec() ?? []) {
      const found = errorCodeIn(item)
      if (found !== null) return found
    }
  }
  return null
}

/** The sentence for a refused simulation. */
export function refusalFor(code: number | null, raw: string): AllowanceSpendRefused {
  if (code !== null && ALLOWANCE_ERRORS[code]) return new AllowanceSpendRefused(ALLOWANCE_ERRORS[code], code)
  const first = String(raw).split('\n')[0].slice(0, 160)
  return new AllowanceSpendRefused(`The wallet refused this payment, so nothing was sent. (${first})`, code)
}

/**
 * Move `amount` of `token` out of the wallet, under the allowance granted to
 * the spender. No passkey is asked for: the allowance is the approval, and the
 * wallet contract enforces its limit.
 *
 * Resolves with the transaction hash. Throws AllowanceSpendRefused, having
 * sent nothing, when the wallet would refuse.
 */
export async function spendFromAllowance(
  input: Omit<AllowanceSpendInput, 'spender'>,
  spenderKeypair: Keypair,
  net: { rpcUrl: string; networkPassphrase: string },
): Promise<string> {
  const spender = spenderKeypair.publicKey()
  const rpc = new SorobanRpc.Server(net.rpcUrl)

  const [account, latest] = await Promise.all([rpc.getAccount(spender), rpc.getLatestLedger()])
  const auth = buildAllowanceSpendAuth(
    { ...input, spender },
    { networkPassphrase: net.networkPassphrase, nonce: randomAuthNonce(), validUntilLedger: latest.sequence + 100 },
  )

  const call = new Contract(input.token).call('transfer', ...auth.transferArgs)
  const tx = new TransactionBuilder(account, { fee: inclusionFee(), networkPassphrase: net.networkPassphrase })
    .addOperation(
      Operation.invokeHostFunction({
        func: (call.body().invokeHostFunctionOp().hostFunction()),
        auth: [auth.walletEntry, auth.spenderEntry],
      }),
    )
    .setTimeout(60)
    .build()

  // The entries are present, so this simulation enforces them: the wallet's
  // __check_auth really runs, and a spend it would refuse is refused here.
  const sim = await rpc.simulateTransaction(tx)
  if (SorobanRpc.Api.isSimulationError(sim)) {
    throw refusalFor(contractErrorCode(sim.events), sim.error)
  }

  const assembled = SorobanRpc.assembleTransaction(tx, sim).build()
  assembled.sign(spenderKeypair)

  const sent = await rpc.sendTransaction(assembled)
  if (sent.status === 'ERROR') {
    throw new Error(`The network did not accept the payment: ${sent.errorResult?.toXDR('base64') ?? 'unknown'}`)
  }
  for (let i = 0; i < 30; i++) {
    const result = await rpc.getTransaction(sent.hash)
    if (result.status !== SorobanRpc.Api.GetTransactionStatus.NOT_FOUND) {
      if (result.status !== SorobanRpc.Api.GetTransactionStatus.SUCCESS) {
        throw new Error(`The payment failed: ${describeFailure(result, 'allowance-spend')}`)
      }
      return sent.hash
    }
    await new Promise((r) => setTimeout(r, 1_000))
  }
  throw new Error('The payment timed out. Check your activity before trying again, so it is not sent twice.')
}
