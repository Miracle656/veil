import { inclusionFee } from './fees'
import {
  Keypair, rpc as SorobanRpc, Contract, Account,
  TransactionBuilder, BASE_FEE, Asset, nativeToScVal, scValToNative, xdr,
  Address, Operation,
} from '@stellar/stellar-sdk'
import type { WebAuthnSignature } from '@veil/sdk'

/**
 * Reads the wallet contract's stored nonce from instance storage.
 * Works regardless of whether get_nonce() is exposed as a public function —
 * older WASM versions had nonce checking but never exported the getter.
 * Returns 0n if the contract has no stored nonce (pre-nonce WASM).
 */
/**
 * Detect whether the deployed wallet WASM is the nonce-aware version and
 * return the current nonce. Returns `null` if the contract doesn't support
 * nonces (older 4-element __check_auth WASM). Probes via get_nonce() since
 * its presence is a reliable signal — when it exists, __check_auth requires
 * 5 elements; when it doesn't, __check_auth requires 4.
 */
async function getWalletNonce(
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
 * Extracts a human-readable failure reason from a failed Soroban transaction
 * by walking the resultMetaXdr.v3.sorobanMeta.diagnosticEvents looking for
 * `[Symbol("error"), ScError(...)]` topic pairs. Returns the raw status name
 * if no diagnostic events are present.
 */
function describeFailure(result: any): string {
  const status: string = result.status
  const debugInfo: Record<string, unknown> = { status }

  // Always dump raw XDR (base64) so the failure can be decoded externally
  try {
    if (result.resultXdr?.toXDR) debugInfo.resultXdr = result.resultXdr.toXDR('base64')
  } catch { /* ignore */ }
  try {
    if (result.resultMetaXdr?.toXDR) debugInfo.resultMetaXdr = result.resultMetaXdr.toXDR('base64')
  } catch { /* ignore */ }

  // Walk diagnostic events from whichever meta version applies (v3 or v4).
  // stellar-sdk 17 reads XDR unions as discriminated properties, so each arm is
  // a field rather than an accessor call.
  const errs: string[] = []
  try {
    const meta = result.resultMetaXdr
    const sorobanMeta =
      meta?.type === 'v4' ? meta.v4.sorobanMeta
      : meta?.type === 'v3' ? meta.v3.sorobanMeta
      : undefined

    for (const diag of sorobanMeta?.diagnosticEvents ?? []) {
      try {
        const body = diag.event?.body
        if (body?.type !== 'v0') continue
        const topics = body.v0.topics ?? []
        if (topics.length === 0) continue
        const first = topics[0]
        if (first.type !== 'scvSymbol' || first.sym.toString() !== 'error') continue
        const errVal = topics[1]
        if (!errVal || errVal.type !== 'scvError') continue
        const scErr = errVal.error
        const code = scErr.type === 'sceContract' ? scErr.contractCode : scErr.code?.name ?? '?'
        errs.push(`${scErr.type}=${code}`)
      } catch { /* skip event */ }
    }
  } catch { /* ignore */ }

  // Always log everything to the browser console for debugging
  // eslint-disable-next-line no-console
  console.error('[sweep] tx failed', debugInfo, 'parsed errors:', errs)

  if (errs.length > 0) return `${status} | ${errs.join(' / ')}`

  // Last-resort: include the resultXdr base64 in the thrown error so the user
  // sees something actionable even when diagnostic events can't be parsed
  if (typeof debugInfo.resultXdr === 'string') {
    return `${status} (resultXdr: ${(debugInfo.resultXdr as string).slice(0, 120)}…)`
  }
  return status
}

/**
 * Sweeps the full XLM balance from the C... contract's SAC account to the G... fee-payer.
 * The contract authorises the transfer via a WebAuthn passkey (triggers __check_auth).
 * Returns the submitted transaction hash on success.
 *
 * Throws if:
 *   - Contract SAC balance is zero (nothing to sweep)
 *   - Simulation fails
 *   - signAuthEntry returns null (user cancelled the passkey prompt)
 *   - Transaction is rejected or times out
 */
export async function sweepContractBalance(
  contractAddress: string,
  feePayerKeypair: Keypair,
  signAuthEntry: (payload: Uint8Array) => Promise<WebAuthnSignature | null>,
  rpcUrl: string,
  networkPassphrase: string,
): Promise<string> {
  const rpc   = new SorobanRpc.Server(rpcUrl)
  const sacId = Asset.native().contractId(networkPassphrase)
  const sac   = new Contract(sacId)

  // 1. Read C... SAC balance using a throw-away dummy account (simulation only)
  const dummyKp   = Keypair.random()
  const dummyAcct = new Account(dummyKp.publicKey(), '0')
  const balanceTx = new TransactionBuilder(dummyAcct, {
    fee: inclusionFee(),
    networkPassphrase,
  })
    .addOperation(sac.call('balance', nativeToScVal(contractAddress, { type: 'address' })))
    .setTimeout(30)
    .build()

  const balanceSim = await rpc.simulateTransaction(balanceTx)
  if (SorobanRpc.Api.isSimulationError(balanceSim)) {
    throw new Error(`Balance check failed: ${balanceSim.error}`)
  }

  const balResult = (balanceSim as SorobanRpc.Api.SimulateTransactionSuccessResponse).result
  if (!balResult) throw new Error('No balance result from simulation')

  const balanceStroops = scValToNative(balResult.retval) as bigint
  if (balanceStroops <= 0n) {
    throw new Error('Contract balance is zero — nothing to sweep')
  }

  // 1b. Probe whether this wallet WASM supports nonces. Returns the current
  //     nonce when it does, or null when the contract is the older 4-element
  //     version. We use this to choose between a 4- or 5-element sigVec below.
  const currentNonce = await getWalletNonce(rpc, contractAddress, networkPassphrase)

  // 2. Build SAC.transfer(C..., G..., fullBalance) using the real fee-payer account
  const feePayerAcct = await rpc.getAccount(feePayerKeypair.publicKey())
  const tx = new TransactionBuilder(feePayerAcct, {
    fee: inclusionFee(),
    networkPassphrase,
  })
    .addOperation(sac.call(
      'transfer',
      nativeToScVal(contractAddress,             { type: 'address' }),
      nativeToScVal(feePayerKeypair.publicKey(), { type: 'address' }),
      nativeToScVal(balanceStroops,              { type: 'i128' }),
    ))
    .setTimeout(30)
    .build()

  // 3. Simulate to discover auth entries and resource footprint. Small CPU
  //    leeway covers the host-function ECDSA verification (~10k instructions)
  //    that recording-mode simulation doesn't account for.
  const sim = await rpc.simulateTransaction(tx, { cpuInstructions: 5_000_000 } as any)
  if (SorobanRpc.Api.isSimulationError(sim)) {
    throw new Error(`Simulation failed: ${sim.error}`)
  }

  // 4. Sign Soroban auth entries. Recording-mode simulation returns auth
  //    entries with signatureExpirationLedger=0 — the SDK is expected to
  //    set a real future ledger before signing. The preimage we hash AND
  //    the credential we attach must use the same value, otherwise the
  //    host computes a different signature_payload and verification fails.
  const latestLedger = await rpc.getLatestLedger()
  const validUntilLedger = latestLedger.sequence + 100 // ~8 min of headroom on testnet

  const successSim  = sim as SorobanRpc.Api.SimulateTransactionSuccessResponse
  const authEntries = successSim.result?.auth
  if (authEntries) {
    const networkIdBytes = new Uint8Array(
      await crypto.subtle.digest('SHA-256', new TextEncoder().encode(networkPassphrase))
    )

    for (let i = 0; i < authEntries.length; i++) {
      const parsed = authEntries[i]
      const cred = parsed.credentials
      const isV2 = cred.type === 'sorobanCredentialsAddressV2'
      if (!isV2 && cred.type !== 'sorobanCredentialsAddress') {
        continue
      }

      const addrCred = isV2 ? cred.addressV2 : cred.address
      const shared = {
        networkId:                 new xdr.Hash(networkIdBytes),
        nonce:                     addrCred.nonce,
        invocation:                parsed.rootInvocation,
        signatureExpirationLedger: validUntilLedger,
      }
      // CAP-71 binds the authorising address into the payload, so an ADDRESS_V2
      // entry has to be signed over the WithAddress preimage — signing the legacy
      // one produces a signature the host rejects.
      const preimage = isV2
        ? xdr.HashIdPreimage.envelopeTypeSorobanAuthorizationWithAddress(
            new xdr.HashIdPreimageSorobanAuthorizationWithAddress({ ...shared, address: addrCred.address })
          )
        : xdr.HashIdPreimage.envelopeTypeSorobanAuthorization(
            new xdr.HashIdPreimageSorobanAuthorization(shared)
          )
      const payloadHash = new Uint8Array(
        await crypto.subtle.digest('SHA-256', preimage.toXDR().buffer as ArrayBuffer)
      )

      const webAuthnSig = (await signAuthEntry(payloadHash)) as any
      if (!webAuthnSig) throw new Error('WebAuthn signing was cancelled')

      const sigElements = [
        nativeToScVal(webAuthnSig.publicKey,      { type: 'bytes' }),
        nativeToScVal(webAuthnSig.authData,       { type: 'bytes' }),
        nativeToScVal(webAuthnSig.clientDataJSON, { type: 'bytes' }),
        nativeToScVal(webAuthnSig.signature,      { type: 'bytes' }),
      ]
      if (currentNonce !== null) {
        sigElements.push(nativeToScVal(currentNonce, { type: 'u64' }))
      }
      const sigVec = xdr.ScVal.scvVec(sigElements)

      const addressCredentials = new xdr.SorobanAddressCredentials({
        address:                   addrCred.address,
        nonce:                     addrCred.nonce,
        signatureExpirationLedger: validUntilLedger,
        signature:                 sigVec,
      })

      authEntries[i] = new xdr.SorobanAuthorizationEntry({
        credentials: isV2
          ? xdr.SorobanCredentials.sorobanCredentialsAddressV2(addressCredentials)
          : xdr.SorobanCredentials.sorobanCredentialsAddress(addressCredentials),
        rootInvocation: parsed.rootInvocation,
      })
    }
  }

  // 5. Re-build the tx with the signed auth entries embedded, then re-simulate.
  //    The first simulation ran in `recording` auth mode, which DOESN'T execute
  //    __check_auth — so its footprint doesn't include the wallet contract's
  //    instance storage that __check_auth reads (signers / rp_id / origin /
  //    nonce). Submitting with that footprint trips
  //    "trying to access contract instance outside of the footprint".
  //
  //    Re-simulating with signed credentials puts the simulator into `enforce`
  //    mode, which actually runs __check_auth and discovers all the storage
  //    reads → produces an accurate footprint and resource fee.
  const ihfOp = tx.operations[0] as Operation.InvokeHostFunction
  const feePayerAcct2 = await rpc.getAccount(feePayerKeypair.publicKey())
  const signedTx = new TransactionBuilder(feePayerAcct2, {
    fee: inclusionFee(),
    networkPassphrase,
  })
    .addOperation(Operation.invokeHostFunction({
      func:   ihfOp.func,
      auth:   authEntries ?? [],
      source: ihfOp.source,
    }))
    .setTimeout(30)
    .build()

  const sim2 = await rpc.simulateTransaction(signedTx)
  if (SorobanRpc.Api.isSimulationError(sim2)) {
    throw new Error(`Re-simulation (enforce mode) failed: ${sim2.error}`)
  }

  // 6. Assemble using sim2 (correct footprint + fees) and sign with fee-payer
  const assembled = SorobanRpc.assembleTransaction(signedTx, sim2).build()
  assembled.sign(feePayerKeypair)

  // 6. Submit to Soroban RPC and poll for confirmation
  const sendResult = await rpc.sendTransaction(assembled)
  if (sendResult.status === 'ERROR') {
    throw new Error(
      `Transaction rejected: ${sendResult.errorResult?.toXDR('base64') ?? 'unknown'}`
    )
  }

  for (let i = 0; i < 30; i++) {
    const result = await rpc.getTransaction(sendResult.hash)
    if (result.status !== SorobanRpc.Api.GetTransactionStatus.NOT_FOUND) {
      if (result.status !== SorobanRpc.Api.GetTransactionStatus.SUCCESS) {
        throw new Error(`Transaction failed: ${describeFailure(result)}`)
      }
      return sendResult.hash
    }
    await new Promise(r => setTimeout(r, 1_000))
  }

  throw new Error('Transaction timed out — check status manually')
}
