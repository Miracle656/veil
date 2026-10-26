import {
  Account,
  Contract,
  Keypair,
  Operation,
  TransactionBuilder,
  nativeToScVal,
  scValToNative,
  rpc as SorobanRpc,
  xdr,
} from '@stellar/stellar-sdk'
import type { WebAuthnSignature } from '@veil/sdk'
import { inclusionFee } from './fees'
import { walletContractErrorMessage } from './walletContractError'

/**
 * Guardian recovery (#1174) — the on-chain mechanism the wallet contract has
 * carried since deploy and no client surfaced.
 *
 * The contract side (contracts/invisible_wallet/src/lib.rs):
 *   - `set_guardian(guardian)`   — wallet-authorised (passkey); stores one address
 *   - `initiate_recovery(pk)`    — GUARDIAN-authorised; starts a 3-day timelock
 *   - `complete_recovery()`      — permissionless once the timelock expires;
 *                                  replaces ALL signers with the new key
 *   - `cancel_recovery()`        — wallet-authorised; aborts a pending recovery
 *
 * This is a second, SEPARATE mechanism from the SEP-30 recovery-server path
 * (`set_recovery_key` / `request_recovery` / `finalize_recovery`), which has a
 * 7-day timelock. A UI that silently drives only one of them would mislead —
 * the screen must name both delays, which is why both constants live here.
 */

/** The guardian path's timelock — `RECOVERY_DELAY_SECONDS` in lib.rs. */
export const GUARDIAN_DELAY_SECONDS = 259_200 // 3 days

/** The recovery-server path's timelock — `RECOVERY_KEY_DELAY` in recovery.rs. */
export const RECOVERY_SERVER_DELAY_SECONDS = 604_800 // 7 days

/**
 * What nominating a guardian actually grants — in consequences, because a user
 * who does not understand the trust they are granting has not consented to it.
 * The settings screen renders exactly these lines, and the test pins them, so
 * the explanation cannot quietly drift from the contract's behaviour.
 */
export const GUARDIAN_CAN = [
  `Start replacing your wallet's keys with a key of their choosing, at any time, without asking you.`,
  `Finish that replacement after the 3-day waiting period — and whoever holds the new key then controls the wallet and everything in it.`,
] as const

export const GUARDIAN_CANNOT = [
  'Move money, change settings, or see anything extra while no recovery is pending.',
  'Skip or shorten the 3-day waiting period.',
  'Act invisibly: a pending recovery is public on-chain state, and this screen shows it.',
  'Survive your cancel: while you still hold your passkey, you can cancel any recovery during the waiting period.',
] as const

export type PendingGuardianRecovery = {
  /** Which system started it — the two have different delays and different actors. */
  source: 'guardian' | 'recovery-key'
  /** Hex of the 65-byte uncompressed P-256 key the recovery would install. */
  newPublicKeyHex: string
  /** Unix seconds after which the recovery can be completed. */
  unlockTime: number
}

// ── Reads ─────────────────────────────────────────────────────────────────────
// The contract exposes no getters for these; they are persistent storage
// entries (`DataKey::Guardian`, `DataKey::RecoveryPending`) read over RPC.

/** The wallet's current guardian address, or null when none is set. */
export async function readGuardian(
  walletAddress: string,
  rpcUrl: string,
): Promise<string | null> {
  const rpc = new SorobanRpc.Server(rpcUrl)
  try {
    const entry = await rpc.getContractData(
      walletAddress,
      xdr.ScVal.scvVec([xdr.ScVal.scvSymbol('Guardian')]),
      SorobanRpc.Durability.Persistent,
    )
    const value = scValToNative(entry.val.contractData().val())
    return typeof value === 'string' ? value : String(value)
  } catch {
    // Missing entry (no guardian) and an undeployed wallet both land here; the
    // screen treats either as "no guardian set".
    return null
  }
}

/**
 * The pending recovery, or null when none is in progress — read through the
 * contract's own `get_pending_recovery()` view, which reports BOTH recovery
 * systems (guardian and recovery-key) and which one holds the slot. The two
 * share one slot on-chain, so this is the complete answer, not one system's.
 */
export async function readPendingRecovery(
  walletAddress: string,
  rpcUrl: string,
  networkPassphrase: string,
): Promise<PendingGuardianRecovery | null> {
  const rpc = new SorobanRpc.Server(rpcUrl)
  try {
    const dummy = new Account(Keypair.random().publicKey(), '0')
    const tx = new TransactionBuilder(dummy, { fee: inclusionFee(), networkPassphrase })
      .addOperation(new Contract(walletAddress).call('get_pending_recovery'))
      .setTimeout(30)
      .build()
    const sim = await rpc.simulateTransaction(tx)
    if (SorobanRpc.Api.isSimulationError(sim)) return null
    const retval = (sim as SorobanRpc.Api.SimulateTransactionSuccessResponse).result?.retval
    if (!retval) return null
    const value = scValToNative(retval) as {
      source: unknown
      new_public_key: Uint8Array | Buffer
      recovery_unlock_time: bigint | number
    } | null
    if (!value || !value.new_public_key) return null
    // A unit-variant contract enum decodes as its symbol (sometimes wrapped in
    // a one-element array, depending on the SDK version) — normalise both.
    const rawSource = Array.isArray(value.source) ? value.source[0] : value.source
    return {
      source: String(rawSource) === 'RecoveryKey' ? 'recovery-key' : 'guardian',
      newPublicKeyHex: Buffer.from(value.new_public_key).toString('hex'),
      unlockTime: Number(value.recovery_unlock_time),
    }
  } catch {
    return null
  }
}

/** Whether a pending recovery's timelock has elapsed. */
export function isGuardianRecoveryUnlocked(
  pending: PendingGuardianRecovery,
  nowSeconds: number = Date.now() / 1000,
): boolean {
  return nowSeconds >= pending.unlockTime
}

// ── Submission plumbing ───────────────────────────────────────────────────────

async function sendAndConfirm(
  rpc: SorobanRpc.Server,
  assembled: ReturnType<ReturnType<typeof SorobanRpc.assembleTransaction>['build']>,
): Promise<string> {
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
        throw new Error(`Transaction failed on-chain: ${result.status}`)
      }
      return sendResult.hash
    }
    await new Promise((r) => setTimeout(r, 1_000))
  }
  throw new Error('Transaction timed out — check the explorer before retrying.')
}

/** Map the wallet contract's recovery errors (WalletError in lib.rs) to plain words. */
function namedSimulationError(error: string): Error {
  if (error.includes('NoGuardianSet') || error.includes('Error(Contract, #12)')) {
    return new Error('This wallet has no guardian set.')
  }
  if (
    error.includes('RecoveryAlreadyPending') ||
    error.includes('GuardianRecoveryPending') ||
    error.includes('Error(Contract, #13)')
  ) {
    return new Error('A recovery is already pending for this wallet.')
  }
  if (error.includes('RecoveryNotPending') || error.includes('Error(Contract, #14)')) {
    return new Error('No recovery is pending for this wallet.')
  }
  if (error.includes('RecoveryTimelockActive') || error.includes('Error(Contract, #15)')) {
    return new Error('The 3-day waiting period has not elapsed yet.')
  }
  const named = walletContractErrorMessage(error)
  return new Error(named ?? `Simulation failed: ${error}`)
}

/**
 * As the GUARDIAN of someone's wallet: start the 3-day recovery that will
 * install `newPublicKey` as the wallet's only signer.
 *
 * The contract requires the guardian address's own authorisation, which a
 * classic G-account satisfies by being the transaction source and signing the
 * envelope — so `guardian` must be the keypair of the nominated address.
 */
export async function initiateRecoveryAsGuardian(params: {
  walletAddress: string
  guardian: Keypair
  newPublicKey: Uint8Array
  rpcUrl: string
  networkPassphrase: string
}): Promise<{ txHash: string }> {
  const { walletAddress, guardian, newPublicKey, rpcUrl, networkPassphrase } = params
  if (newPublicKey.length !== 65 || newPublicKey[0] !== 0x04) {
    throw new Error('The new key must be a 65-byte uncompressed P-256 public key (0x04-prefixed).')
  }

  const rpc = new SorobanRpc.Server(rpcUrl)
  const source = await rpc.getAccount(guardian.publicKey())
  const tx = new TransactionBuilder(source, { fee: inclusionFee(), networkPassphrase })
    .addOperation(
      new Contract(walletAddress).call(
        'initiate_recovery',
        nativeToScVal(newPublicKey, { type: 'bytes' }),
      ),
    )
    .setTimeout(60)
    .build()

  const sim = await rpc.simulateTransaction(tx)
  if (SorobanRpc.Api.isSimulationError(sim)) throw namedSimulationError(sim.error)

  const assembled = SorobanRpc.assembleTransaction(tx, sim).build()
  assembled.sign(guardian)
  const txHash = await sendAndConfirm(rpc, assembled)
  return { txHash }
}

/**
 * Finish a recovery whose timelock has elapsed. Permissionless on the
 * contract — `payer` only pays the fee; it does not need to be the guardian.
 */
export async function completeRecoveryPermissionless(params: {
  walletAddress: string
  payer: Keypair
  rpcUrl: string
  networkPassphrase: string
}): Promise<{ txHash: string }> {
  const { walletAddress, payer, rpcUrl, networkPassphrase } = params
  const rpc = new SorobanRpc.Server(rpcUrl)
  const source = await rpc.getAccount(payer.publicKey())
  const tx = new TransactionBuilder(source, { fee: inclusionFee(), networkPassphrase })
    .addOperation(new Contract(walletAddress).call('complete_recovery'))
    .setTimeout(60)
    .build()

  const sim = await rpc.simulateTransaction(tx)
  if (SorobanRpc.Api.isSimulationError(sim)) throw namedSimulationError(sim.error)

  const assembled = SorobanRpc.assembleTransaction(tx, sim).build()
  assembled.sign(payer)
  const txHash = await sendAndConfirm(rpc, assembled)
  return { txHash }
}

/**
 * As the OWNER: cancel a pending recovery. `cancel_recovery` is
 * wallet-authorised (`env.current_contract_address().require_auth()`), so this
 * walks the same passkey auth sequence as lib/sweepContractBalance.ts: sign
 * the simulation's auth entries with the passkey (via the SDK-exposed
 * `signAuthEntry`), then re-simulate in enforce mode so the footprint covers
 * everything `__check_auth` reads.
 */
export async function cancelPendingRecovery(params: {
  walletAddress: string
  feePayer: Keypair
  signAuthEntry: (payload: Uint8Array) => Promise<WebAuthnSignature | null>
  rpcUrl: string
  networkPassphrase: string
}): Promise<{ txHash: string }> {
  const { walletAddress, feePayer, signAuthEntry, rpcUrl, networkPassphrase } = params
  const rpc = new SorobanRpc.Server(rpcUrl)

  // Nonce probe — see sweepContractBalance: older wallet WASM verifies a
  // 4-element signature vector, nonce-aware WASM requires 5.
  let currentNonce: bigint | null = null
  try {
    const dummy = new Account(Keypair.random().publicKey(), '0')
    const probe = new TransactionBuilder(dummy, { fee: inclusionFee(), networkPassphrase })
      .addOperation(new Contract(walletAddress).call('get_nonce'))
      .setTimeout(30)
      .build()
    const probeSim = await rpc.simulateTransaction(probe)
    if (!SorobanRpc.Api.isSimulationError(probeSim)) {
      const retval = (probeSim as SorobanRpc.Api.SimulateTransactionSuccessResponse).result?.retval
      if (retval) currentNonce = scValToNative(retval) as bigint
    }
  } catch {
    currentNonce = null
  }

  const source = await rpc.getAccount(feePayer.publicKey())
  const tx = new TransactionBuilder(source, { fee: inclusionFee(), networkPassphrase })
    .addOperation(new Contract(walletAddress).call('cancel_recovery'))
    .setTimeout(60)
    .build()

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const sim = await rpc.simulateTransaction(tx, { cpuInstructions: 5_000_000 } as any)
  if (SorobanRpc.Api.isSimulationError(sim)) throw namedSimulationError(sim.error)

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

      const webAuthnSig = await signAuthEntry(payloadHash)
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

  // Re-simulate with signed credentials (enforce mode) so the footprint covers
  // the storage __check_auth reads; recording mode's footprint does not.
  const ihfOp = tx.operations[0] as Operation.InvokeHostFunction
  const source2 = await rpc.getAccount(feePayer.publicKey())
  const signedTx = new TransactionBuilder(source2, { fee: inclusionFee(), networkPassphrase })
    .addOperation(
      Operation.invokeHostFunction({
        func: ihfOp.func,
        auth: authEntries ?? [],
        source: ihfOp.source,
      }),
    )
    .setTimeout(60)
    .build()

  const sim2 = await rpc.simulateTransaction(signedTx)
  if (SorobanRpc.Api.isSimulationError(sim2)) throw namedSimulationError(sim2.error)

  const assembled = SorobanRpc.assembleTransaction(signedTx, sim2).build()
  assembled.sign(feePayer)
  const txHash = await sendAndConfirm(rpc, assembled)
  return { txHash }
}
