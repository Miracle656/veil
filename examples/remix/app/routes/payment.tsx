import { useState } from 'react'
import type { ActionFunctionArgs } from '@remix-run/node'
import { Link, useFetcher } from '@remix-run/react'
import {
  Keypair,
  Contract,
  TransactionBuilder,
  BASE_FEE,
  rpc as SorobanRpc,
  nativeToScVal,
} from '@stellar/stellar-sdk'
import { getPublicEnv } from '~/lib/config.server'
import { resolveNetwork, clientEnv } from '~/lib/network'

/**
 * Server-side action — the "payment.action" of this example.
 *
 * The browser signs the transaction (the passkey lives there), then POSTs the
 * signed XDR here. This action broadcasts it to the network from the server and
 * polls for confirmation, so no RPC submission happens in the browser. It
 * returns the transaction hash (or an error) back to the calling fetcher.
 */
export async function action({ request }: ActionFunctionArgs) {
  const form = await request.formData()
  const xdr = String(form.get('xdr') || '')
  if (!xdr) return { error: 'Missing signed transaction.' }

  const net = resolveNetwork(getPublicEnv())
  try {
    const server = new SorobanRpc.Server(net.rpcUrl)
    const tx = TransactionBuilder.fromXDR(xdr, net.networkPassphrase)

    const sent = await server.sendTransaction(tx)
    if (sent.status === 'ERROR') {
      return { error: `Transaction rejected: ${sent.errorResult?.toXDR('base64') ?? 'unknown'}` }
    }

    // Poll for confirmation.
    for (let i = 0; i < 30; i++) {
      const result = await server.getTransaction(sent.hash)
      if (result.status !== SorobanRpc.Api.GetTransactionStatus.NOT_FOUND) {
        if (result.status !== SorobanRpc.Api.GetTransactionStatus.SUCCESS) {
          return { error: `Transaction failed with status: ${result.status}` }
        }
        break
      }
      await new Promise((r) => setTimeout(r, 1_000))
    }

    return { hash: sent.hash }
  } catch (err) {
    return { error: err instanceof Error ? err.message : String(err) }
  }
}

type ActionData = { hash?: string; error?: string }

export default function Payment() {
  const fetcher = useFetcher<ActionData>()
  const [recipient, setRecipient] = useState('')
  const [amount, setAmount] = useState('')
  const [signing, setSigning] = useState(false)
  const [clientError, setClientError] = useState<string | null>(null)

  const submitting = signing || fetcher.state !== 'idle'
  const result = fetcher.data

  function isValidAddress(addr: string) {
    return (addr.startsWith('G') || addr.startsWith('C')) && addr.length === 56
  }

  // Build + sign the transfer in the browser, then hand the signed XDR to the
  // server action for submission.
  async function handleSend() {
    setClientError(null)
    setSigning(true)
    try {
      const net = resolveNetwork(clientEnv())

      const feePayerSecret = localStorage.getItem('veil_fee_payer_secret')
      if (!feePayerSecret) throw new Error('Fee-payer key not found. Re-create your wallet.')
      const feePayerKp = Keypair.fromSecret(feePayerSecret)

      // Passkey assertion — proves the user controls this device's wallet.
      const credIdHex = localStorage.getItem('invisible_wallet_credential_id')
      if (credIdHex) {
        const credId = Uint8Array.from(
          credIdHex.match(/.{1,2}/g)!.map((b) => parseInt(b, 16)),
        )
        const assertion = await navigator.credentials.get({
          publicKey: {
            challenge: crypto.getRandomValues(new Uint8Array(32)),
            allowCredentials: [{ id: credId, type: 'public-key' }],
            userVerification: 'required',
          },
        })
        if (!assertion) throw new Error('Passkey verification was cancelled.')
      }

      const server = new SorobanRpc.Server(net.rpcUrl)
      const feePayerAcct = await server.getAccount(feePayerKp.publicKey())
      const sac = new Contract(net.nativeAssetContractId())
      const stroops = BigInt(Math.round(parseFloat(amount) * 10_000_000))

      const tx = new TransactionBuilder(feePayerAcct, {
        fee: BASE_FEE,
        networkPassphrase: net.networkPassphrase,
      })
        .addOperation(
          sac.call(
            'transfer',
            nativeToScVal(feePayerKp.publicKey(), { type: 'address' }),
            nativeToScVal(recipient, { type: 'address' }),
            nativeToScVal(stroops, { type: 'i128' }),
          ),
        )
        .setTimeout(30)
        .build()

      const sim = await server.simulateTransaction(tx)
      if (SorobanRpc.Api.isSimulationError(sim)) {
        throw new Error(`Simulation failed: ${sim.error}`)
      }
      const assembled = SorobanRpc.assembleTransaction(tx, sim).build()
      assembled.sign(feePayerKp)

      // Hand off to the server action.
      fetcher.submit({ xdr: assembled.toXDR() }, { method: 'post' })
    } catch (err) {
      setClientError(err instanceof Error ? err.message : String(err))
    } finally {
      setSigning(false)
    }
  }

  const canSubmit =
    isValidAddress(recipient) && !isNaN(parseFloat(amount)) && parseFloat(amount) > 0

  return (
    <main className="page">
      <div className="card stack">
        <div className="row">
          <Link to="/dashboard" className="muted" style={{ textDecoration: 'none' }}>
            ← Back
          </Link>
          <h1 style={{ fontSize: '1.25rem' }}>Send XLM</h1>
        </div>

        {!result?.hash && (
          <>
            <div>
              <label>Recipient address</label>
              <input
                type="text"
                placeholder="G… or C…"
                className="mono"
                value={recipient}
                onChange={(e) => setRecipient(e.target.value.trim())}
              />
            </div>
            <div>
              <label>Amount (XLM)</label>
              <input
                type="number"
                placeholder="0.0"
                min="0"
                step="0.0000001"
                value={amount}
                onChange={(e) => setAmount(e.target.value)}
              />
            </div>
            <button onClick={handleSend} disabled={!canSubmit || submitting}>
              {submitting ? 'Submitting…' : 'Send — confirm with passkey'}
            </button>
          </>
        )}

        {(clientError || result?.error) && (
          <p className="alert error">{clientError || result?.error}</p>
        )}

        {result?.hash && (
          <div className="alert success stack">
            <p>Transaction confirmed ✓</p>
            <a
              href={`https://stellar.expert/explorer/testnet/tx/${result.hash}`}
              target="_blank"
              rel="noopener noreferrer"
              className="mono"
            >
              {result.hash}
            </a>
            <Link to="/dashboard" className="muted">Back to dashboard</Link>
          </div>
        )}
      </div>
    </main>
  )
}
