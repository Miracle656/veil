'use client'

import { useState, useEffect } from 'react'
import { useRouter } from 'next/navigation'
import Link from 'next/link'
import {
  Keypair,
  Contract,
  TransactionBuilder,
  BASE_FEE,
  rpc as SorobanRpc,
  nativeToScVal,
} from '@stellar/stellar-sdk'
import { network, getNativeAssetContractId } from '@/lib/network'

type Step = 'form' | 'signing' | 'done' | 'error'

export default function SendPage() {
  const router = useRouter()

  const [step, setStep] = useState<Step>('form')
  const [recipient, setRecipient] = useState('')
  const [amount, setAmount] = useState('')
  const [txHash, setTxHash] = useState<string | null>(null)
  const [errorMsg, setErrorMsg] = useState<string | null>(null)

  useEffect(() => {
    if (!localStorage.getItem('invisible_wallet_address')) {
      router.replace('/')
    }
  }, [router])

  function isValidAddress(addr: string) {
    return (addr.startsWith('G') || addr.startsWith('C')) && addr.length === 56
  }

  async function handleSend() {
    setErrorMsg(null)
    setStep('signing')

    try {
      const feePayerSecret = localStorage.getItem('veil_fee_payer_secret')
      if (!feePayerSecret) throw new Error('Fee-payer key not found. Re-create your wallet.')
      const feePayerKp = Keypair.fromSecret(feePayerSecret)

      // ── Passkey assertion (proves the user controls the wallet) ──────────
      const keyId = localStorage.getItem('invisible_wallet_key_id')
      if (!keyId) throw new Error('No passkey found. Please register first.')

      const credIdBin = atob(keyId.replace(/-/g, '+').replace(/_/g, '/'))
      const credId = Uint8Array.from(credIdBin, c => c.charCodeAt(0))
      const challenge = crypto.getRandomValues(new Uint8Array(32))

      const assertion = await navigator.credentials.get({
        publicKey: {
          challenge,
          allowCredentials: [{ id: credId, type: 'public-key' }],
          userVerification: 'required',
        },
      })
      if (!assertion) throw new Error('Passkey verification was cancelled.')

      // ── Build and submit the SAC transfer ────────────────────────────────
      const rpcServer = new SorobanRpc.Server(network.rpcUrl)
      const feePayerAcct = await rpcServer.getAccount(feePayerKp.publicKey())
      const sacContract = new Contract(getNativeAssetContractId())
      const amountStroops = BigInt(Math.round(parseFloat(amount) * 10_000_000))

      const tx = new TransactionBuilder(feePayerAcct, {
        fee: BASE_FEE,
        networkPassphrase: network.networkPassphrase,
      })
        .addOperation(
          sacContract.call(
            'transfer',
            nativeToScVal(feePayerKp.publicKey(), { type: 'address' }),
            nativeToScVal(recipient, { type: 'address' }),
            nativeToScVal(amountStroops, { type: 'i128' })
          )
        )
        .setTimeout(30)
        .build()

      const sim = await rpcServer.simulateTransaction(tx)
      if (SorobanRpc.Api.isSimulationError(sim)) {
        throw new Error(`Simulation failed: ${sim.error}`)
      }

      const assembled = SorobanRpc.assembleTransaction(tx, sim).build()
      assembled.sign(feePayerKp)

      const sendResult = await rpcServer.sendTransaction(assembled)
      if (sendResult.status === 'ERROR') {
        throw new Error(
          `Transaction rejected: ${sendResult.errorResult?.toXDR('base64') ?? 'unknown'}`
        )
      }

      // Poll for confirmation
      for (let i = 0; i < 30; i++) {
        const result = await rpcServer.getTransaction(sendResult.hash)
        if (result.status !== SorobanRpc.Api.GetTransactionStatus.NOT_FOUND) {
          if (result.status !== SorobanRpc.Api.GetTransactionStatus.SUCCESS) {
            throw new Error(`Transaction failed with status: ${result.status}`)
          }
          break
        }
        await new Promise(r => setTimeout(r, 1_000))
      }

      setTxHash(sendResult.hash)
      setStep('done')
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err)
      setErrorMsg(
        msg.includes('NotAllowedError') || msg.includes('not allowed')
          ? 'Biometric verification was cancelled. Please try again.'
          : msg
      )
      setStep('error')
    }
  }

  const canSubmit =
    isValidAddress(recipient) &&
    !isNaN(parseFloat(amount)) &&
    parseFloat(amount) > 0

  return (
    <main className="flex min-h-screen flex-col items-center justify-center gap-6 p-6">
      <div className="w-full max-w-sm space-y-4">
        <div className="flex items-center gap-3">
          <Link href="/dashboard" className="text-sm text-gray-500 hover:text-gray-300">
            ← Back
          </Link>
          <h1 className="text-xl font-bold">Send XLM</h1>
        </div>

        {step === 'form' && (
          <div className="rounded-2xl border border-gray-800 bg-gray-900 p-5 space-y-4">
            <div className="space-y-1">
              <label className="text-xs text-gray-500 uppercase tracking-wider">
                Recipient address
              </label>
              <input
                type="text"
                placeholder="G… or C…"
                value={recipient}
                onChange={e => setRecipient(e.target.value.trim())}
                className="w-full rounded-lg border border-gray-700 bg-gray-800 px-3 py-2 font-mono text-sm placeholder-gray-600 focus:outline-none focus:ring-2 focus:ring-indigo-500"
              />
            </div>

            <div className="space-y-1">
              <label className="text-xs text-gray-500 uppercase tracking-wider">
                Amount (XLM)
              </label>
              <input
                type="number"
                placeholder="0.0"
                min="0"
                step="0.0000001"
                value={amount}
                onChange={e => setAmount(e.target.value)}
                className="w-full rounded-lg border border-gray-700 bg-gray-800 px-3 py-2 text-sm placeholder-gray-600 focus:outline-none focus:ring-2 focus:ring-indigo-500"
              />
            </div>

            <button
              onClick={handleSend}
              disabled={!canSubmit}
              className="w-full rounded-lg bg-indigo-600 px-4 py-2.5 text-sm font-semibold hover:bg-indigo-500 disabled:opacity-40 transition-colors"
            >
              Send — confirm with passkey
            </button>
          </div>
        )}

        {step === 'signing' && (
          <div className="rounded-2xl border border-gray-800 bg-gray-900 p-5 text-center space-y-2">
            <p className="text-sm text-gray-400 animate-pulse">
              Waiting for passkey confirmation…
            </p>
          </div>
        )}

        {step === 'done' && (
          <div className="rounded-2xl border border-green-800 bg-green-950 p-5 space-y-3">
            <p className="font-semibold text-green-300">Transaction confirmed ✓</p>
            {txHash && (
              <a
                href={`https://stellar.expert/explorer/testnet/tx/${txHash}`}
                target="_blank"
                rel="noopener noreferrer"
                className="block font-mono text-xs text-green-400 hover:underline break-all"
              >
                {txHash}
              </a>
            )}
            <Link
              href="/dashboard"
              className="block text-center text-sm text-gray-400 hover:text-gray-200"
            >
              Back to dashboard
            </Link>
          </div>
        )}

        {step === 'error' && (
          <div className="rounded-2xl border border-red-800 bg-red-950 p-5 space-y-3">
            <p className="text-sm text-red-300">{errorMsg}</p>
            <button
              onClick={() => { setStep('form'); setErrorMsg(null) }}
              className="text-sm text-gray-400 hover:text-gray-200"
            >
              Try again
            </button>
          </div>
        )}
      </div>
    </main>
  )
}
