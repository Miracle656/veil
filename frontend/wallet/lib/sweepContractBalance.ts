import {
  Keypair, rpc as SorobanRpc, Contract, Account,
  TransactionBuilder, BASE_FEE, Asset, nativeToScVal, scValToNative, xdr,
} from '@stellar/stellar-sdk'
import type { WebAuthnSignature } from '@veil/sdk'

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
    fee: BASE_FEE,
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

  // 2. Build SAC.transfer(C..., G..., fullBalance) using the real fee-payer account
  const feePayerAcct = await rpc.getAccount(feePayerKeypair.publicKey())
  const tx = new TransactionBuilder(feePayerAcct, {
    fee: BASE_FEE,
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

  // 3. Simulate to discover auth entries and resource footprint
  const sim = await rpc.simulateTransaction(tx)
  if (SorobanRpc.Api.isSimulationError(sim)) {
    throw new Error(`Simulation failed: ${sim.error}`)
  }

  const assembled = SorobanRpc.assembleTransaction(tx, sim).build()

  // 4. Sign Soroban auth entries that require the C... contract's WebAuthn passkey.
  //    The entry hash is the SHA-256 of the invocation XDR — this is the challenge
  //    passed to navigator.credentials.get, which triggers __check_auth on the contract.
  const successSim  = sim as SorobanRpc.Api.SimulateTransactionSuccessResponse
  const authEntries = successSim.result?.auth
  if (authEntries) {
    for (const parsed of authEntries) {
      const cred = parsed.credentials()
      if (cred.switch().value !== xdr.SorobanCredentialsType.sorobanCredentialsAddress().value) {
        continue
      }

      const invocationXdr = parsed.rootInvocation().toXDR()
      const payloadHash   = new Uint8Array(
        await crypto.subtle.digest('SHA-256', new Uint8Array(invocationXdr))
      )

      const webAuthnSig = await signAuthEntry(payloadHash)
      if (!webAuthnSig) throw new Error('WebAuthn signing was cancelled')

      const sigVec = xdr.ScVal.scvVec([
        nativeToScVal(webAuthnSig.publicKey,      { type: 'bytes' }),
        nativeToScVal(webAuthnSig.authData,       { type: 'bytes' }),
        nativeToScVal(webAuthnSig.clientDataJSON, { type: 'bytes' }),
        nativeToScVal(webAuthnSig.signature,      { type: 'bytes' }),
      ])

      const addrCred = cred.address()
      parsed.credentials(
        xdr.SorobanCredentials.sorobanCredentialsAddress(
          new xdr.SorobanAddressCredentials({
            address:                   addrCred.address(),
            nonce:                     addrCred.nonce(),
            signatureExpirationLedger: addrCred.signatureExpirationLedger(),
            signature:                 sigVec,
          })
        )
      )
    }
  }

  // 5. Sign the assembled transaction with the fee-payer keypair (pays fees)
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
        throw new Error(`Transaction failed: ${result.status}`)
      }
      return sendResult.hash
    }
    await new Promise(r => setTimeout(r, 1_000))
  }

  throw new Error('Transaction timed out — check status manually')
}
