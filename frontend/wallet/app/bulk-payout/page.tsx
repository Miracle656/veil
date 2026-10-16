'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import {
  Keypair, TransactionBuilder, Operation,
  Contract, rpc as SorobanRpc, nativeToScVal, Horizon, Memo,
} from '@stellar/stellar-sdk'
import { Nav, PageHeader, Card } from '@/components/ui/primitives'
import { walletLocal, walletSession } from '@/lib/walletStorage'
import { getNativeAssetContractId, getNetwork } from '@/lib/network'
import { inclusionFee } from '@/lib/fees'
import { beginTx, endTx } from '@/lib/txState'
import { passkeyErrorMessage } from '@/lib/passkeyAuth'
import { useInactivityLock } from '@/hooks/useInactivityLock'
import {
  parsePayoutCsv,
  resolveAsset,
  totalsByAsset,
  type WebPayoutRow,
  type RowError,
  type RowOutcome,
} from '@/lib/bulkPayoutWeb'
import { submitPayoutRows } from '@/lib/bulkPayoutSubmit'

const Server = Horizon.Server

type Step = 'input' | 'review' | 'signing' | 'done'

const PLACEHOLDER =
  'recipient,amount,asset,issuer,memo\nGCSWM5I2FRYFIDSVJDGLWDH4TMQZY6IVT4JDF2SCFW6PPJ56TSBH23NO,10,XLM,,\nGCSWM5I2FRYFIDSVJDGLWDH4TMQZY6IVT4JDF2SCFW6PPJ56TSBH23NO,25,USDC,GD2VUFNSFXBAVZEZIU6VRPFU2KMSU4VQKP65SCE4TR5C2MJPLJ6VEAIM,payroll'

export default function BulkPayoutPage() {
  const router = useRouter()
  useInactivityLock()

  const [step, setStep] = useState<Step>('input')
  const [csvText, setCsvText] = useState('')
  const [rows, setRows] = useState<WebPayoutRow[]>([])
  const [parseErrors, setParseErrors] = useState<RowError[]>([])
  const [outcomes, setOutcomes] = useState<RowOutcome[]>([])
  const [signing, setSigning] = useState(false)

  const network = getNetwork()

  function handleParse() {
    const { rows: parsedRows, errors } = parsePayoutCsv(csvText)
    setParseErrors(errors)
    setRows(errors.length === 0 ? parsedRows : [])
    setStep(errors.length === 0 && parsedRows.length > 0 ? 'review' : 'input')
  }

  async function submitOneRow(row: WebPayoutRow): Promise<string> {
    const signerSecret = walletSession.getItem('veil_signer_secret')
      || walletLocal.getItem('veil_signer_secret')
    if (!signerSecret) throw new Error('Signing key not found. Set up a fee-payer first.')
    const feePayerKp = Keypair.fromSecret(signerSecret)
    const asset = resolveAsset(row)

    if (asset.isNative() && (row.recipient.startsWith('G'))) {
      const horizonServer = new Server(network.horizonUrl)
      const account = await horizonServer.loadAccount(feePayerKp.publicKey())
      const builder = new TransactionBuilder(account, {
        fee: inclusionFee(),
        networkPassphrase: network.networkPassphrase,
      }).addOperation(Operation.payment({
        destination: row.recipient,
        asset,
        amount: row.amount,
      }))
      if (row.memo) builder.addMemo(Memo.text(row.memo))
      const tx = builder.setTimeout(30).build()
      tx.sign(feePayerKp)
      const result = await horizonServer.submitTransaction(tx)
      return result.hash
    }

    // Contract recipient, or a non-native asset: go through the SAC transfer,
    // exactly as single-send does for the same case.
    const rpcServer = new SorobanRpc.Server(network.rpcUrl)
    const feePayerAcct = await rpcServer.getAccount(feePayerKp.publicKey())
    const sacId = asset.isNative() ? getNativeAssetContractId() : asset.contractId(network.networkPassphrase)
    const sacContract = new Contract(sacId)
    const amountStroops = BigInt(Math.round(parseFloat(row.amount) * 10_000_000))

    const sacBuilder = new TransactionBuilder(feePayerAcct, {
      fee: inclusionFee(),
      networkPassphrase: network.networkPassphrase,
    })
      .addOperation(sacContract.call(
        'transfer',
        nativeToScVal(feePayerKp.publicKey(), { type: 'address' }),
        nativeToScVal(row.recipient, { type: 'address' }),
        nativeToScVal(amountStroops, { type: 'i128' }),
      ))
    // A memo on the SAC path must be attached the same as on the classic path —
    // otherwise it is silently dropped for every contract recipient or
    // non-native asset row, which is exactly the kind of per-row loss the
    // per-row reporting in this flow exists to prevent.
    if (row.memo) sacBuilder.addMemo(Memo.text(row.memo))
    const tx = sacBuilder.setTimeout(30).build()

    const sim = await rpcServer.simulateTransaction(tx)
    if (SorobanRpc.Api.isSimulationError(sim)) throw new Error(`Simulation failed: ${sim.error}`)
    const assembled = SorobanRpc.assembleTransaction(tx, sim).build()
    assembled.sign(feePayerKp)
    const sendResult = await rpcServer.sendTransaction(assembled)
    if (sendResult.status === 'ERROR') {
      throw new Error(`Transaction rejected: ${sendResult.errorResult?.toXDR('base64') ?? 'unknown'}`)
    }
    for (let i = 0; i < 30; i++) {
      const result = await rpcServer.getTransaction(sendResult.hash)
      if (result.status !== SorobanRpc.Api.GetTransactionStatus.NOT_FOUND) {
        if (result.status !== SorobanRpc.Api.GetTransactionStatus.SUCCESS) {
          throw new Error(`Transaction failed: ${result.status}`)
        }
        return sendResult.hash
      }
      await new Promise(r => setTimeout(r, 1_000))
    }
    // The RPC accepted the transaction but it still hadn't landed in a ledger
    // after 30s. A hash existing is not the same as the payment having
    // happened — resending this row risks a double payment if it does land
    // later, so this must surface as a distinct outcome, not a success.
    throw new Error(`Not confirmed within 30s (tx ${sendResult.hash}) — check the explorer before resending this row.`)
  }

  async function handleSignAndSubmit() {
    beginTx()
    setSigning(true)
    setOutcomes([])
    setStep('signing')
    try {
      const keyId = walletLocal.getItem('invisible_wallet_key_id')
      if (!keyId) throw new Error('No passkey found. Please register the wallet first.')
      if (keyId !== 'recovery') {
        const normalized = keyId.replace(/-/g, '+').replace(/_/g, '/')
        const padded = normalized + '='.repeat((4 - (normalized.length % 4)) % 4)
        const credIdBin = atob(padded)
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
      }

      const results = await submitPayoutRows(rows, submitOneRow, (outcome) => {
        setOutcomes(prev => [...prev, outcome])
      })
      setOutcomes(results)
      setStep('done')
    } catch (err: unknown) {
      setParseErrors([{ row: 0, field: 'recipient', message: passkeyErrorMessage(err) }])
      setStep('review')
    } finally {
      setSigning(false)
      endTx()
    }
  }

  const totals = totalsByAsset(rows)
  const feeXlm = ((Number(inclusionFee()) * rows.length) / 10_000_000).toFixed(7)

  return (
    <div className="wallet-shell" style={{ padding: '1.5rem 1.25rem 4rem' }}>
      <Nav title="Bulk Payout" onBack={() => router.push('/dashboard')} />
      <div style={{ maxWidth: 560, width: '100%', margin: '0 auto' }}>
        <div style={{ marginBottom: '1.5rem' }}>
          <PageHeader eyebrow="Payroll" title="Bulk payout" />
        </div>

        {step === 'input' && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: '1rem' }}>
            <p style={{ fontSize: '0.875rem', color: 'rgba(246,247,248,0.5)' }}>
              Paste a CSV with columns: recipient, amount, asset, issuer (optional for XLM), memo (optional).
            </p>
            <textarea
              className="input-field mono"
              rows={10}
              placeholder={PLACEHOLDER}
              value={csvText}
              onChange={e => setCsvText(e.target.value)}
              spellCheck={false}
              style={{ fontFamily: 'Inconsolata, monospace', fontSize: '0.8125rem', resize: 'vertical' }}
            />
            {parseErrors.length > 0 && (
              <Card>
                <p style={{ fontSize: '0.8125rem', color: 'rgba(220,38,38,0.9)', marginBottom: '0.5rem', fontWeight: 600 }}>
                  {parseErrors.length} row{parseErrors.length === 1 ? '' : 's'} need fixing
                </p>
                <div style={{ display: 'flex', flexDirection: 'column', gap: '0.375rem' }}>
                  {parseErrors.map((e, i) => (
                    <p key={i} style={{ fontSize: '0.8125rem', color: 'rgba(246,247,248,0.6)' }}>
                      {e.row > 0 ? `Row ${e.row}: ` : ''}{e.message}
                    </p>
                  ))}
                </div>
              </Card>
            )}
            <button className="btn-gold" onClick={handleParse} disabled={!csvText.trim()}>
              Validate rows
            </button>
          </div>
        )}

        {step === 'review' && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: '1rem' }}>
            <Card>
              <p style={{ fontSize: '0.75rem', color: 'rgba(246,247,248,0.4)', fontFamily: 'Anton, Impact, sans-serif', letterSpacing: '0.06em', marginBottom: '0.625rem' }}>
                {rows.length} RECIPIENT{rows.length === 1 ? '' : 'S'}
              </p>
              <div style={{ display: 'flex', flexDirection: 'column', gap: '0.5rem' }}>
                {Object.entries(totals).map(([key, amt]) => (
                  <div key={key} style={{ display: 'flex', justifyContent: 'space-between', fontSize: '0.875rem' }}>
                    <span style={{ color: 'rgba(246,247,248,0.6)' }}>{key.split(':')[0]}</span>
                    <span style={{ fontFamily: 'Inconsolata, monospace', color: 'var(--gold)' }}>{amt}</span>
                  </div>
                ))}
                <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '0.8125rem', marginTop: '0.5rem', paddingTop: '0.5rem', borderTop: '1px solid rgba(255,255,255,0.06)' }}>
                  <span style={{ color: 'rgba(246,247,248,0.4)' }}>Network fee ({rows.length} tx)</span>
                  <span style={{ fontFamily: 'Inconsolata, monospace', color: 'rgba(246,247,248,0.6)' }}>{feeXlm} XLM</span>
                </div>
              </div>
            </Card>

            {parseErrors.length > 0 && (
              <Card>
                <p style={{ fontSize: '0.8125rem', color: 'rgba(220,38,38,0.9)' }}>{parseErrors[0].message}</p>
              </Card>
            )}

            <div style={{ display: 'flex', gap: '0.75rem' }}>
              <button className="btn" style={{ flex: 1, border: '1px solid var(--border-dim)' }} onClick={() => setStep('input')}>
                Back
              </button>
              <button className="btn-gold" style={{ flex: 2 }} onClick={handleSignAndSubmit} disabled={signing}>
                Sign &amp; send {rows.length} payment{rows.length === 1 ? '' : 's'}
              </button>
            </div>
          </div>
        )}

        {step === 'signing' && (
          <Card>
            <p style={{ fontSize: '0.875rem', marginBottom: '0.75rem' }}>
              Sending {outcomes.length} of {rows.length}…
            </p>
            <span className="spinner" />
          </Card>
        )}

        {step === 'done' && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: '0.75rem' }}>
            <Card>
              <p style={{ fontSize: '0.875rem', fontWeight: 600, marginBottom: '0.5rem' }}>
                {outcomes.filter(o => o.status === 'success').length} of {outcomes.length} sent
              </p>
            </Card>
            {outcomes.map(o => (
              <Card key={o.row} padded={false}>
                <div style={{ display: 'flex', justifyContent: 'space-between', padding: '0.75rem 1rem' }}>
                  <span style={{ fontSize: '0.8125rem' }}>Row {o.row}</span>
                  <span
                    style={{
                      fontSize: '0.8125rem',
                      fontFamily: 'Inconsolata, monospace',
                      color: o.status === 'success' ? 'var(--teal)' : 'rgba(220,38,38,0.9)',
                    }}
                  >
                    {o.status === 'success' ? `✓ ${o.txHash?.slice(0, 10)}…` : `✗ ${o.error}`}
                  </span>
                </div>
              </Card>
            ))}
            <button className="btn-gold" onClick={() => router.push('/dashboard')}>
              Done
            </button>
          </div>
        )}
      </div>
    </div>
  )
}
