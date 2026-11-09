/**
 * Invoke a contract *as the Veil wallet*, authorised by its passkey.
 *
 * A Veil wallet is a `C…` contract account, so `require_auth()` on it runs
 * `__check_auth`, which verifies a WebAuthn assertion. Any contract call that
 * spends from the wallet — a SAC transfer, buying a name, anything — has to go
 * through the same seven steps, and several of them are only obvious once you
 * have got them wrong:
 *
 *  1. Probe the wallet's nonce, because the signature vector is four elements
 *     on pre-nonce WASM and five on nonce-aware WASM.
 *  2. Build the invocation against the fee-payer's `G…` account.
 *  3. Simulate in *recording* mode to discover the auth entries.
 *  4. Sign each auth entry's `HashIdPreimage` with the passkey.
 *  5. Rebuild with the signed entries and simulate **again**, in *enforce*
 *     mode. Recording mode never executes `__check_auth`, so its footprint
 *     omits the wallet's own instance storage and submitting it trips
 *     "trying to access contract instance outside of the footprint".
 *  6. Assemble from the *second* simulation, for the right footprint and fee.
 *  7. Submit and poll.
 *
 * This module is the single implementation of that sequence. It was extracted
 * from `sweepContractBalance.ts`, which now calls it: a second hand-written
 * copy of a passkey money path is a second place for the nonce handling or the
 * enforce-mode re-simulation to drift.
 */

import {
  Account,
  Contract,
  Keypair,
  Operation,
  TransactionBuilder,
  nativeToScVal,
  rpc as SorobanRpc,
  scValToNative,
  xdr,
} from '@stellar/stellar-sdk'
import type { WebAuthnSignature } from '@veil/sdk'

import { inclusionFee } from './fees'
import { walletContractErrorMessage } from './walletContractError'

/** Signs a 32-byte payload with the wallet's passkey, or null if cancelled. */
export type AuthEntrySigner = (payload: Uint8Array) => Promise<WebAuthnSignature | null>

/**
 * Detect whether the deployed wallet WASM is the nonce-aware version and
 * return the current nonce. Returns `null` if the contract doesn't support
 * nonces (older 4-element `__check_auth` WASM). Probes via `get_nonce()` since
 * its presence is a reliable signal — when it exists, `__check_auth` requires
 * 5 elements; when it doesn't, it requires 4.
 */
export async function getWalletNonce(
  rpc: SorobanRpc.Server,
  contractAddress: string,
  networkPassphrase: string,
): Promise<bigint | null> {
  try {
    const dummyKp = Keypair.random()
    const dummyAcct = new Account(dummyKp.publicKey(), '0')
    const probeTx = new TransactionBuilder(dummyAcct, {
      fee: inclusionFee(),
      networkPassphrase,
    })
      .addOperation(new Contract(contractAddress).call('get_nonce'))
      .setTimeout(30)
      .build()
    const sim = await rpc.simulateTransaction(probeTx)
    if (SorobanRpc.Api.isSimulationError(sim)) return null
    const result = (sim as SorobanRpc.Api.SimulateTransactionSuccessResponse).result
    if (!result?.retval) return null
    return scValToNative(result.retval) as bigint
  } catch {
    return null
  }
}

/**
 * Extract a human-readable failure reason from a failed Soroban transaction by
 * walking `resultMetaXdr`'s diagnostic events for `[Symbol("error"),
 * ScError(...)]` topic pairs. Falls back to the raw status name.
 */
export function describeFailure(result: any, label = 'soroban'): string {
  const status: string = result.status
  const debugInfo: Record<string, unknown> = { status }

  try {
    if (result.resultXdr?.toXDR) debugInfo.resultXdr = result.resultXdr.toXDR('base64')
  } catch { /* ignore */ }
  try {
    if (result.resultMetaXdr?.toXDR) debugInfo.resultMetaXdr = result.resultMetaXdr.toXDR('base64')
  } catch { /* ignore */ }

  const errs: string[] = []
  try {
    const meta = result.resultMetaXdr
    let sorobanMeta: any = null
    try {
      const sw = meta?.switch?.()?.name
      if (sw === 'transactionMetaV3') sorobanMeta = meta.v3?.()?.sorobanMeta?.()
      else if (sw === 'transactionMetaV4') sorobanMeta = meta.v4?.()?.sorobanMeta?.()
      else sorobanMeta = meta?.v3?.()?.sorobanMeta?.() ?? meta?.v4?.()?.sorobanMeta?.()
    } catch { /* fall through */ }

    const events = sorobanMeta?.diagnosticEvents?.() ?? []
    for (const diag of events) {
      try {
        const body = diag.event().body().v0?.()
        if (!body) continue
        const topics = body.topics() ?? []
        if (topics.length === 0) continue
        const first = topics[0]
        if (first.switch().name !== 'scvSymbol' || first.sym().toString() !== 'error') continue
        const errVal = topics[1]
        if (!errVal || errVal.switch().name !== 'scvError') continue
        const scErr = errVal.error()
        const t = scErr.switch().name
        let code: string | number = '?'
        if (t === 'sceContract') code = scErr.contractCode()
        else { try { code = scErr.code()?.name ?? '?' } catch { /* */ } }
        errs.push(`${t}=${code}`)
      } catch { /* skip event */ }
    }
  } catch { /* ignore */ }

  // eslint-disable-next-line no-console
  console.error(`[${label}] tx failed`, debugInfo, 'parsed errors:', errs)

  if (errs.length > 0) return `${status} | ${errs.join(' / ')}`
  if (typeof debugInfo.resultXdr === 'string') {
    return `${status} (resultXdr: ${(debugInfo.resultXdr as string).slice(0, 120)}…)`
  }
  return status
}

export interface InvokeAsWalletParams {
  /** Contract being called. */
  contractId: string
  /** Method name on that contract. */
  method: string
  /** Already-converted arguments, in order. */
  args: xdr.ScVal[]
  /** The `C…` wallet that authorises, used only to read its nonce. */
  walletAddress: string
  /** Pays the network fee and is the transaction source. */
  feePayerKeypair: Keypair
  /** Produces the WebAuthn assertion over each auth entry. */
  signAuthEntry: AuthEntrySigner
  rpcUrl: string
  networkPassphrase: string
  /**
   * Extra CPU leeway for the recording simulation. Recording mode does not run
   * `__check_auth`, so it under-counts by roughly the cost of the host
   * function's ECDSA verification.
   */
  cpuInstructions?: number
  /** Prefix for diagnostic logs, so a failure says which flow produced it. */
  label?: string
}

/**
 * Run `method(...args)` on `contractId`, authorised by the wallet's passkey.
 *
 * Resolves with the submitted transaction hash.
 *
 * Throws if simulation fails, if the user cancels the passkey prompt, or if the
 * transaction is rejected or never confirms.
 */
export async function invokeAsWallet(params: InvokeAsWalletParams): Promise<string> {
  const {
    contractId,
    method,
    args,
    walletAddress,
    feePayerKeypair,
    signAuthEntry,
    rpcUrl,
    networkPassphrase,
    cpuInstructions = 5_000_000,
    label = 'soroban',
  } = params

  const rpc = new SorobanRpc.Server(rpcUrl)
  const contract = new Contract(contractId)

  // 1. Four- or five-element signature vector?
  const currentNonce = await getWalletNonce(rpc, walletAddress, networkPassphrase)

  // 2. Build against the fee-payer's real account.
  const feePayerAcct = await rpc.getAccount(feePayerKeypair.publicKey())
  const tx = new TransactionBuilder(feePayerAcct, {
    fee: inclusionFee(),
    networkPassphrase,
  })
    .addOperation(contract.call(method, ...args))
    .setTimeout(30)
    .build()

  // 3. Recording-mode simulation discovers the auth entries.
  const sim = await rpc.simulateTransaction(tx, { cpuInstructions } as any)
  if (SorobanRpc.Api.isSimulationError(sim)) {
    const named = walletContractErrorMessage(sim.error)
    throw new Error(named ?? `Simulation failed: ${sim.error}`)
  }

  // 4. Sign each auth entry. Recording mode returns
  //    signatureExpirationLedger=0; the preimage we hash and the credential we
  //    attach must carry the *same* future ledger or the host computes a
  //    different signature_payload and verification fails.
  const latestLedger = await rpc.getLatestLedger()
  const validUntilLedger = latestLedger.sequence + 100

  const successSim = sim as SorobanRpc.Api.SimulateTransactionSuccessResponse
  const authEntries = successSim.result?.auth
  if (authEntries) {
    const networkIdBytes = new Uint8Array(
      await crypto.subtle.digest('SHA-256', new TextEncoder().encode(networkPassphrase)),
    )

    for (const parsed of authEntries) {
      const cred = parsed.credentials()
      if (cred.switch().value !== xdr.SorobanCredentialsType.sorobanCredentialsAddress().value) {
        continue
      }

      const addrCred = cred.address()
      const preimage = xdr.HashIdPreimage.envelopeTypeSorobanAuthorization(
        new xdr.HashIdPreimageSorobanAuthorization({
          networkId: Buffer.from(networkIdBytes),
          nonce: addrCred.nonce(),
          invocation: parsed.rootInvocation(),
          signatureExpirationLedger: validUntilLedger,
        }),
      )
      const payloadHash = new Uint8Array(
        await crypto.subtle.digest('SHA-256', new Uint8Array(preimage.toXDR())),
      )

      const webAuthnSig = (await signAuthEntry(payloadHash)) as any
      if (!webAuthnSig) throw new Error('WebAuthn signing was cancelled')

      const sigElements = [
        nativeToScVal(webAuthnSig.publicKey, { type: 'bytes' }),
        nativeToScVal(webAuthnSig.authData, { type: 'bytes' }),
        nativeToScVal(webAuthnSig.clientDataJSON, { type: 'bytes' }),
        nativeToScVal(webAuthnSig.signature, { type: 'bytes' }),
      ]
      if (currentNonce !== null) {
        sigElements.push(nativeToScVal(currentNonce, { type: 'u64' }))
      }

      parsed.credentials(
        xdr.SorobanCredentials.sorobanCredentialsAddress(
          new xdr.SorobanAddressCredentials({
            address: addrCred.address(),
            nonce: addrCred.nonce(),
            signatureExpirationLedger: validUntilLedger,
            signature: xdr.ScVal.scvVec(sigElements),
          }),
        ),
      )
    }
  }

  // 5. Enforce-mode re-simulation. This is the step whose absence produces
  //    "trying to access contract instance outside of the footprint": only
  //    here does the simulator actually run __check_auth and discover the
  //    wallet's instance storage reads (signers / rp_id / origin / nonce).
  const ihfOp = tx.operations[0] as Operation.InvokeHostFunction
  const feePayerAcct2 = await rpc.getAccount(feePayerKeypair.publicKey())
  const signedTx = new TransactionBuilder(feePayerAcct2, {
    fee: inclusionFee(),
    networkPassphrase,
  })
    .addOperation(
      Operation.invokeHostFunction({
        func: ihfOp.func,
        auth: authEntries ?? [],
        source: ihfOp.source,
      }),
    )
    .setTimeout(30)
    .build()

  const sim2 = await rpc.simulateTransaction(signedTx)
  if (SorobanRpc.Api.isSimulationError(sim2)) {
    // Name the contract failure when we can. A raw HostError is two thousand
    // characters of diagnostic log with `Error(Contract, #N)` buried in it,
    // and some codes mean "retrying will never work" — the opposite of what a
    // generic auth message implies.
    const named = walletContractErrorMessage(sim2.error)
    if (named) {
      // eslint-disable-next-line no-console
      console.warn(`[${label}] re-simulation failed:`, sim2.error)
      throw new Error(named)
    }
    throw new Error(`Re-simulation (enforce mode) failed: ${sim2.error}`)
  }

  // 6. Assemble from sim2 — the accurate footprint and resource fee.
  const assembled = SorobanRpc.assembleTransaction(signedTx, sim2).build()
  assembled.sign(feePayerKeypair)

  // 7. Submit and poll.
  const sendResult = await rpc.sendTransaction(assembled)
  if (sendResult.status === 'ERROR') {
    throw new Error(
      `Transaction rejected: ${sendResult.errorResult?.toXDR('base64') ?? 'unknown'}`,
    )
  }

  for (let i = 0; i < 30; i++) {
    const result = await rpc.getTransaction(sendResult.hash)
    if (result.status !== SorobanRpc.Api.GetTransactionStatus.NOT_FOUND) {
      if (result.status !== SorobanRpc.Api.GetTransactionStatus.SUCCESS) {
        throw new Error(`Transaction failed: ${describeFailure(result, label)}`)
      }
      return sendResult.hash
    }
    await new Promise((r) => setTimeout(r, 1_000))
  }

  throw new Error('Transaction timed out — check status manually')
}
