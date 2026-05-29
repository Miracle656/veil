import { useState } from 'react'
import { Asset, BASE_FEE, Contract, Horizon, Memo, Operation, TransactionBuilder, nativeToScVal, rpc as SorobanRpc } from '@stellar/stellar-sdk'
import { appConfig } from '../lib/config'
import { useViteWallet } from '../lib/wallet'
import { deriveFeePayerKeypair, requirePasskeyAssertion } from '../lib/webauthn'
import { readCredentialId, readSignerSecret, readWalletAddress } from '../lib/storage'

const HorizonServer = Horizon.Server

export function SendPage() {
  const wallet = useViteWallet()
  const [recipient, setRecipient] = useState('')
  const [amount, setAmount] = useState('1')
  const [memo, setMemo] = useState('')
  const [txHash, setTxHash] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)

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
        const result = await horizon.submitTransaction(tx)
        setTxHash(result.hash)
        return
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
      const submission = await rpc.sendTransaction(assembled)
      if (submission.status === 'ERROR') {
        throw new Error(submission.errorResult?.toXDR('base64') ?? 'Transaction rejected')
      }

      for (let attempt = 0; attempt < 30; attempt += 1) {
        const result = await rpc.getTransaction(submission.hash)
        if (result.status === SorobanRpc.Api.GetTransactionStatus.SUCCESS) {
          setTxHash(submission.hash)
          return
        }
        if (result.status !== SorobanRpc.Api.GetTransactionStatus.NOT_FOUND) {
          throw new Error(`Transaction failed: ${result.status}`)
        }
        await new Promise(resolve => setTimeout(resolve, 1000))
      }

      throw new Error('Transaction timed out.')
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setLoading(false)
    }
  }

  return (
    <section className="panel">
      <p className="eyebrow">Send</p>
      <h1>Transfer XLM</h1>
      <p className="lede">The starter supports classic G→G payments and G→C native SAC transfers, matching the Next.js example flow.</p>

      <div className="stack">
        <label className="field">
          <span>Recipient address</span>
          <input value={recipient} onChange={event => setRecipient(event.target.value)} placeholder="G... or C..." />
        </label>

        <label className="field">
          <span>Amount</span>
          <input value={amount} onChange={event => setAmount(event.target.value)} inputMode="decimal" placeholder="1.0" />
        </label>

        <label className="field">
          <span>Memo</span>
          <input value={memo} onChange={event => setMemo(event.target.value)} placeholder="Optional memo" />
        </label>

        <button className="primary" onClick={handleSend} disabled={loading || wallet.isPending}>
          {loading ? 'Sending...' : 'Send'}
        </button>

        {error ? <div className="notice error">{error}</div> : null}
        {txHash ? (
          <div className="notice success">
            Submitted successfully: <span className="mono break">{txHash}</span>
          </div>
        ) : null}
      </div>
    </section>
  )
}
