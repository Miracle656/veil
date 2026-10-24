import { useEffect, useRef, useState } from 'react'
import { Asset, BASE_FEE, Contract, Horizon, Memo, Operation, TransactionBuilder, nativeToScVal, rpc as SorobanRpc } from '@stellar/stellar-sdk'
import { appConfig } from '../lib/config'
import { useElectronWallet } from '../lib/wallet'
import { deriveFeePayerKeypair, requirePasskeyAssertion } from '../lib/webauthn'
import { readCredentialId, readSignerSecret, readWalletAddress } from '../lib/storage'

const HorizonServer = Horizon.Server

/**
 * The mid-action disconnect state for a money action.
 *
 * Once the passkey ceremony has completed, the transaction may have
 * reached the network and the user may already have been charged. We
 * therefore cannot report "failed" — we report "unconfirmed" and resolve
 * it on reconnect.
 */
type Unconfirmed = {
  kind: 'horizon' | 'soroban'
  // Horizon: the signed transaction XDR we attempted to submit.
  transactionXdr?: string
  // Soroban: the hash we got back from sendTransaction, if any.
  hash?: string
  // Soroban: the signed transaction XDR to re-submit if the first
  // submission never made it out.
  signedXdr?: string
  // Soroban: the network passphrase the transaction was built for.
  networkPassphrase?: string
}

function isNetworkError(err: unknown): boolean {
  if (!err || typeof err !== 'object') {
    return false
  }
  const anyErr = err as { message?: unknown; name?: unknown; code?: unknown }
  const message = typeof anyErr.message === 'string' ? anyErr.message : ''
  const name = typeof anyErr.name === 'string' ? anyErr.name : ''
  const code = typeof anyErr.code === 'string' ? anyErr.code : ''
  return (
    // fetch / node / browser network failures
    /failed to fetch|network request failed|err_network|econnection reset|socket hang up|timeout|etimedout|ec.onnection|enotfound/i.test(message)
    || /networkerror|timeouterror|aborterror/i.test(name)
    || /^(ECONNRESET|ETIMEDOUT|ENOTFOUND|ENETNUNREACH|EH_OSTUNREACH)$/.test(code)
  )
}

export function SendPage() {
  const wallet = useElectronWallet()
  const [recipient, setRecipient] = useState('')
  const [amount, setAmount] = useState('1')
  const [memo, setMemo] = useState('')
  const [txHash, setTxHash] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)
  const [unconfirmed, setUnconfirmed] = useState<Unconfirmed | null>(null)
  const [resolving, setResolving] = useState(false)
  const [online, setOnline] = useState(typeof navigator === 'undefined' ? true : navigator.onLine)
  const unconfirmedRef = useRef<Unconfirmed | null>(null)

  unconfirmedRef.current = unconfirmed

  useEffect(() => {
    const handleOnline = () => setOnline(true)
    const handleOffline = () => setOnline(false)
    window.addEventListener('online', handleOnline)
    window.addEventListener('offline', handleOffline)
    return () => {
      window.removeEventListener('online', handleOnline)
      window.removeEventListener('offline', handleOffline)
    }
  }, [])

  const resolveUnconfirmed = async () => {
    const pending = unconfirmedRef.current
    if (!pending || resolving) {
      return
    }
    setResolving(true)
    try {
      if (pending.kind === 'horizon' && pending.transactionXdr) {
        const horizon = new HorizonServer(appConfig.horizonUrl)
        const tx = TransactionBuilder.fromXDR(pending.transactionXdr, appConfig.networkPassphrase)
        try {
          const result = await horizon.submitTransaction(tx)
          setTxHash(result.hash)
          setUnconfirmed(null)
          return
        } catch (err) {
          // If the network still isn't reachable, keep the unconfirmed
          // state and try again on the next reconnect.
          if (isNetworkError(err)) {
            return
          }
          // Horizon returns tx_bad_seq if the transaction already landed.
          // In that case the payment did happen and we can confirm it.
          const message = err instanceof Error ? err.message : String(err)
          if (/tx_bad_seq|tx_too_late|tx_insufficient_fee/i.test(message)) {
            const hash = tx.hash().toString('hex')
            setTxHash(hash)
            setUnconfirmed(null)
            return
          }
          // Any other definitive rejection means the payment did not land.
          setUnconfirmed(null)
          setError(message)
          return
        }
      }

      if (pending.kind === 'soroban') {
        const rpc = new SorobanRpc.Server(appConfig.rpcUrl)
        let hash = pending.hash

        if (!hash && pending.signedXdr) {
          // The first submission never made it out. Re-submit the exact
          // signed transaction so the user is not charged twice.
          const tx = TransactionBuilder.fromXDR(
            pending.signedXdr,
            pending.networkPassphrase ?? appConfig.networkPassphrase,
          )
          const submission = await rpc.sendTransaction(tx)
          if (submission.status === 'ERROR') {
            setUnconfirmed(null)
            setError(submission.errorResult?.toXDR('base64') ?? 'Transaction rejected')
            return
          }
          hash = submission.hash
        }

        if (!hash) {
          // Nothing to poll yet; keep the state for the next reconnect.
          return
        }

        for (let attempt = 0; attempt < 30; attempt += 1) {
          const result = await rpc.getTransaction(hash)
          if (result.status === SorobanRpc.Api.GetTransactionStatus.SUCCESS) {
            setTxHash(hash)
            setUnconfirmed(null)
            return
          }
          if (result.status !== SorobanRpc.Api.GetTransactionStatus.NOT_FOUND) {
            // Definitive failure from the network.
            setUnconfirmed(null)
            setError(`Transaction failed: ${result.status}`)
            return
          }
          await new Promise(resolve => setTimeout(resolve, 1000))
        }
        // Still not found after polling: leave it unconfirmed and let the
        // next reconnect resolve it.
        setUnconfirmed(prev => prev ? { ...prev, hash } : prev)
        return
      }
    } catch (err) {
      // Network dropped again during resolution. Keep the unconfirmed
      // state so the next reconnect retries.
      if (!isNetworkError(err)) {
        setUnconfirmed(null)
        setError(err instanceof Error ? err.message : String(err))
      }
    } finally {
      setResolving(false)
    }
  }

  useEffect(() => {
    if (online && unconfirmed && !resolving) {
      void resolveUnconfirmed()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [online, unconfirmed])

  const handleSend = async () => {
    setError(null)
    setTxHash('')

    const walletAddress = readWalletAddress()
    const signerSecret = readSignerSecret()
    const credentialId = readCredentialId()

    if (!walletAddress) {
      setError('Create a wallet first.')
      return
    }
    if (!signerSecret) {
      setError('Fee-payer secret not found. Return to Register and redeploy the wallet.')
      return
    }
    if (!credentialId) {
      setError('Passkey credential not found. Register the wallet first.')
      return
    }
    if (!recipient || (!recipient.startsWith('G') && !recipient.startsWith('C'))) {
      setError('Enter a valid Stellar address starting with G or C.')
      return
    }

    const parsedAmount = Number(amount)
    if (!Number.isFinite(parsedAmount) || parsedAmount <= 0) {
      setError('Enter a positive amount.')
      return
    }

    setLoading(true)
    try {
      const feePayer = await deriveFeePayerKeypair(credentialId)
      const challenge = crypto.getRandomValues(new Uint8Array(32))
      await requirePasskeyAssertion(credentialId, challenge)

      // From here on the user may already have been charged. Any failure
      // that is not a definitive network rejection is unconfirmed, not
      // a failure.
      if (recipient.startsWith('G')) {
        const horizon = new HorizonServer(appConfig.horizonUrl)
        const account = await horizon.loadAccount(feePayer.publicKey())
        const txBuilder = new TransactionBuilder(account, {
          fee: BASE_FEE,
          networkPassphrase: appConfig.networkPassphrase,
        })
          .addOperation(Operation.payment({
            destination: recipient,
            asset: Asset.native(),
            amount,
          }))

        if (memo) {
          txBuilder.addMemo(Memo.text(memo))
        }

        const tx = txBuilder.setTimeout(30).build()

        tx.sign(feePayer)
        const signedXdr = tx.toXDR()
        try {
          const result = await horizon.submitTransaction(tx)
          setTxHash(result.hash)
          return
        } catch (err) {
          if (isNetworkError(err)) {
            // The submission may or may not have reached the network.
            // Report unconfirmed and resolve on reconnect.
            setUnconfirmed({
              kind: 'horizon',
              transactionXdr: signedXdr,
            })
            return
          }
          throw err
        }
      }

      const rpc = new SorobanRpc.Server(appConfig.rpcUrl)
      const account = await rpc.getAccount(feePayer.publicKey())
      const contract = new Contract(Asset.native().contractId(appConfig.networkPassphrase))
      const amountStroops = BigInt(Math.round(parsedAmount * 10_000_000))

      const tx = new TransactionBuilder(account, {
        fee: BASE_FEE,
        networkPassphrase: appConfig.networkPassphrase,
      })
        .addOperation(contract.call(
          'transfer',
          nativeToScVal(feePayer.publicKey(), { type: 'address' }),
          nativeToScVal(recipient, { type: 'address' }),
          nativeToScVal(amountStroops, { type: 'i128' }),
        ))
        .setTimeout(30)
        .build()

      const simulation = await rpc.simulateTransaction(tx)
      if (SorobanRpc.Api.isSimulationError(simulation)) {
        throw new Error(simulation.error)
      }

      const assembled = SorobanRpc.assembleTransaction(tx, simulation).build()
      assembled.sign(feePayer)
      const signedXdr = assembled.toXDR()

      let submission: SorobanRpc.Api.SendTransactionResponse
      try {
        submission = await rpc.sendTransaction(assembled)
      } catch (err) {
        if (isNetworkError(err)) {
          // We never got a hash back. Keep the signed transaction so the
          // reconnect can re-submit it exactly once.
          setUnconfirmed({
            kind: 'soroban',
            signedXdr,
            networkPassphrase: appConfig.networkPassphrase,
          })
          return
        }
        throw err
      }

      if (submission.status === 'ERROR') {
        throw new Error(submission.errorResult?.toXDR('base64') ?? 'Transaction rejected')
      }

      const hash = submission.hash
      for (let attempt = 0; attempt < 30; attempt += 1) {
        let result: SorobanRpc.Api.GetTransactionResponse
        try {
          result = await rpc.getTransaction(hash)
        } catch (err) {
          if (isNetworkError(err)) {
            // The transaction is in flight; we just can't watch it
            // right now. Resolve on reconnect.
            setUnconfirmed({
              kind: 'soroban',
              hash,
            })
            return
          }
          throw err
        }
        if (result.status === SorobanRpc.Api.GetTransactionStatus.SUCCESS) {
          setTxHash(hash)
          return
        }
        if (result.status !== SorobanRpc.Api.GetTransactionStatus.NOT_FOUND) {
          throw new Error(`Transaction failed: ${result.status}`)
        }
        await new Promise(resolve => setTimeout(resolve, 1000))
      }

      // Timed out waiting for confirmation. The transaction may still
      // land; do not claim failure.
      setUnconfirmed({ kind: 'soroban', hash })
    } catch (err) {
      if (isNetworkError(err)) {
        // The ceremony completed and the network dropped
      }
    } finally {
      setLoading(false)
    }
  }

  return null
}
