'use client'

import { useActivityFeed } from '@/lib/activityFeed'
import { inclusionFee } from '@/lib/fees'
import { Nav, PageHeader } from '@/components/ui/primitives'
import { useState, useEffect, useRef } from 'react'
import { useRouter } from 'next/navigation'

import {
  Keypair, TransactionBuilder, BASE_FEE, Asset, Operation,
  Contract, rpc as SorobanRpc, nativeToScVal, Horizon,
} from '@stellar/stellar-sdk'
import { walletLocal, walletSession } from '@/lib/walletStorage'
const Server = Horizon.Server
import { ContactPicker } from '@/components/ContactPicker'
import { QrScanner } from '@/components/QrScanner'
import { useInactivityLock } from '@/hooks/useInactivityLock'
import { parseQrValue } from '@/lib/sep7'
import { passkeyErrorMessage } from '@/lib/passkeyAuth'

import { getNativeAssetContractId, getNetwork } from '@/lib/network'
import { beginTx, endTx } from '@/lib/txState'
import { fetchPrices } from '@/lib/fetchPrice'
import { formatFiat, hydrateCurrency, useCurrency } from '@/lib/currency'

const network = getNetwork()

type Step = 'form' | 'confirm' | 'signing' | 'done' | 'error'

interface WalletAsset {
  code: string
  issuer: string | null
  contractId: string | null
  /** Decimal string from Horizon. '0' when the account could not be loaded. */
  balance: string
}

function assetKey(a: WalletAsset): string {
  return a.issuer ? `${a.code}:${a.issuer}` : a.code
}

/** Spendable amount: native XLM keeps the base reserve + a fee cushion. */
function maxSendable(asset: WalletAsset): number {
  const bal = parseFloat(asset.balance)
  if (!Number.isFinite(bal)) return 0
  if (asset.code === 'XLM' && !asset.issuer) return Math.max(0, bal - 1.5)
  return Math.max(0, bal)
}

export default function SendPage() {
  const router = useRouter()
  useInactivityLock()
  const [step, setStep]               = useState<Step>('form')
  const [recipient, setRecipient]     = useState('')
  const [amount, setAmount]           = useState('')
  const [memo, setMemo]               = useState('')
  const [txHash, setTxHash]           = useState<string | null>(null)
  const [errorMsg, setErrorMsg]       = useState<string | null>(null)
  const [showPicker, setShowPicker]   = useState(false)

  // Who this wallet has actually paid, newest first. Derived from the activity
  // feed rather than the contact book: a contact you have never paid is not a
  // "recent recipient", and this needs no extra storage.
  const transactions = useActivityFeed()
  const recentRecipients = Array.from(
    new Set(transactions.filter((t) => t.type === 'sent').map((t) => t.counterparty)),
  ).slice(0, 3)
  const [showScanner, setShowScanner] = useState(false)
  const [hasCamera, setHasCamera]     = useState(false)
  const [imgError, setImgError]       = useState<string | null>(null)
  const [imgDecoding, setImgDecoding] = useState(false)

  const fileInputRef = useRef<HTMLInputElement>(null)

  const [assets, setAssets]               = useState<WalletAsset[]>([])
  const [selectedAsset, setSelectedAsset] = useState<WalletAsset | null>(null)
  const [showAssets, setShowAssets]       = useState(false)
  const [prices, setPrices]               = useState<Record<string, number | null>>({})
  const { code: currencyCode, rate: fxRate } = useCurrency()

  useEffect(() => {
    const addr = walletSession.getItem('invisible_wallet_address')
    if (!addr) { router.replace('/lock'); return }

    if (typeof (window as unknown as { BarcodeDetector?: unknown }).BarcodeDetector !== 'undefined' || !!navigator.mediaDevices?.getUserMedia) {
      setHasCamera(true)
    }

    const signerPublicKey = walletSession.getItem('veil_signer_secret')
      ? Keypair.fromSecret(walletSession.getItem('veil_signer_secret')!).publicKey()
      : walletLocal.getItem('veil_signer_public_key') || null
    if (!signerPublicKey || !signerPublicKey.startsWith('G')) {
      const xlm: WalletAsset = { code: 'XLM', issuer: null, contractId: getNativeAssetContractId(), balance: '0' }
      setAssets([xlm])
      setSelectedAsset(xlm)
      return
    }
    const server = new Server(network.horizonUrl)
    server.loadAccount(signerPublicKey).then(account => {
      const list: WalletAsset[] = account.balances.map(b => {
        if (b.asset_type === 'native') {
          return { code: 'XLM', issuer: null, contractId: getNativeAssetContractId(), balance: b.balance }
        }
        const issued = b as { asset_code: string; asset_issuer: string; balance: string }
        const asset  = new Asset(issued.asset_code, issued.asset_issuer)
        return {
          code: issued.asset_code,
          issuer: issued.asset_issuer,
          contractId: asset.contractId(network.networkPassphrase),
          balance: issued.balance,
        }
      })
      setAssets(list)
      if (list.length > 0) setSelectedAsset(list[0])
    }).catch(() => {
      const xlm: WalletAsset = { code: 'XLM', issuer: null, contractId: getNativeAssetContractId(), balance: '0' }
      setAssets([xlm])
      setSelectedAsset(xlm)
    })
  }, [router])

  useEffect(() => { hydrateCurrency() }, [])
  useEffect(() => {
    if (assets.length === 0) return
    void fetchPrices(assets).then(setPrices)
  }, [assets])

  // ── QR image upload ─────────────────────────────────────────────────────────
  // Reads an image file, draws it to an offscreen canvas, and passes the
  // ImageData to BarcodeDetector. Falls back to a clear error if the browser
  // doesn't support BarcodeDetector or no QR is found in the image.
  const handleImageFile = async (file: File) => {
    setImgError(null)
    setImgDecoding(true)

    try {
      // Decode image into a bitmap
      const bitmap = await createImageBitmap(file)

      // Draw onto an offscreen canvas so BarcodeDetector can read it
      const canvas = document.createElement('canvas')
      canvas.width  = bitmap.width
      canvas.height = bitmap.height
      const ctx = canvas.getContext('2d')!
      ctx.drawImage(bitmap, 0, 0)
      bitmap.close()

      const BarcodeDetectorClass = (
        window as unknown as { BarcodeDetector?: new (opts: { formats: string[] }) => { detect: (src: HTMLCanvasElement) => Promise<{ rawValue: string }[]> } }
      ).BarcodeDetector

      if (!BarcodeDetectorClass) {
        setImgError('QR image scan is not supported in this browser. Please type the address manually or use the camera scanner.')
        return
      }

      const detector = new BarcodeDetectorClass({ formats: ['qr_code'] })
      const codes = await detector.detect(canvas)

      if (codes.length === 0) {
        setImgError('No QR code found in the image. Try a clearer photo.')
        return
      }

      const value = codes[0].rawValue.trim()
      const isAddress = (value.startsWith('G') || value.startsWith('C')) && value.length === 56
      if (!isAddress) {
        setImgError(`QR decoded "${value.slice(0, 20)}…" — doesn't look like a Stellar address.`)
        return
      }

      setRecipient(value)
      setImgError(null)
    } catch {
      setImgError('Could not read the image. Please try a different file.')
    } finally {
      setImgDecoding(false)
      // Reset file input so the same file can be re-selected if needed
      if (fileInputRef.current) fileInputRef.current.value = ''
    }
  }

  function validateForm(): boolean {
    const validAddress = (recipient.startsWith('G') || recipient.startsWith('C')) && recipient.length === 56
    if (!validAddress) return false
    if (isNaN(parseFloat(amount)) || parseFloat(amount) <= 0) return false
    if (!selectedAsset) return false
    return true
  }

  async function handleSend() {
    beginTx()
    setStep('signing')
    setErrorMsg(null)
    try {
      const signerSecret = walletSession.getItem('veil_signer_secret')
        || walletLocal.getItem('veil_signer_secret')
      if (!signerSecret) {
        setErrorMsg('Signing key not found. Return to dashboard and tap "Fund wallet" to set up a fee-payer.')
        setStep('error')
        return
      }
      const feePayerKp = Keypair.fromSecret(signerSecret)

      const keyId = walletLocal.getItem('invisible_wallet_key_id')
      if (!keyId) throw new Error('No passkey found. Please register the wallet first.')
      if (keyId !== 'recovery') {
        const normalized = keyId.replace(/-/g, '+').replace(/_/g, '/')
        const padded = normalized + '='.repeat((4 - (normalized.length % 4)) % 4)
        const credIdBin = atob(padded)
        const credId    = Uint8Array.from(credIdBin, c => c.charCodeAt(0))
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

      const horizonServer = new Server(network.horizonUrl)

      if (recipient.startsWith('G') && recipient.length === 56) {
        const account = await horizonServer.loadAccount(feePayerKp.publicKey())
        const tx = new TransactionBuilder(account, {
          fee: inclusionFee(),
          networkPassphrase: network.networkPassphrase,
        })
          .addOperation(Operation.payment({
            destination: recipient,
            asset: Asset.native(),
            amount,
          }))
          .setTimeout(30)
          .build()
        tx.sign(feePayerKp)
        const result = await horizonServer.submitTransaction(tx)
        setTxHash(result.hash)
      } else {
        const rpcServer     = new SorobanRpc.Server(network.rpcUrl)
        const feePayerAcct  = await rpcServer.getAccount(feePayerKp.publicKey())
        const sacContract   = new Contract(getNativeAssetContractId())
        const amountStroops = BigInt(Math.round(parseFloat(amount) * 10_000_000))

        const tx = new TransactionBuilder(feePayerAcct, {
          fee: inclusionFee(),
          networkPassphrase: network.networkPassphrase,
        })
          .addOperation(sacContract.call(
            'transfer',
            nativeToScVal(feePayerKp.publicKey(), { type: 'address' }),
            nativeToScVal(recipient,              { type: 'address' }),
            nativeToScVal(amountStroops,          { type: 'i128' }),
          ))
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
          throw new Error(`Transaction rejected: ${sendResult.errorResult?.toXDR('base64') ?? 'unknown'}`)
        }
        for (let i = 0; i < 30; i++) {
          const result = await rpcServer.getTransaction(sendResult.hash)
          if (result.status !== SorobanRpc.Api.GetTransactionStatus.NOT_FOUND) {
            if (result.status !== SorobanRpc.Api.GetTransactionStatus.SUCCESS) {
              throw new Error(`Transaction failed: ${result.status}`)
            }
            break
          }
          await new Promise(r => setTimeout(r, 1_000))
        }
        setTxHash(sendResult.hash)
      }

      setStep('done')
    } catch (err: unknown) {
      setErrorMsg(passkeyErrorMessage(err))
      setStep('error')
    } finally {
      endTx()
    }
  }

  const amtNum = parseFloat(amount)
  const unitUsd = selectedAsset ? (prices[assetKey(selectedAsset)] ?? null) : null
  const fiatLabel =
    unitUsd != null && Number.isFinite(amtNum) && amtNum > 0
      ? `≈ ${formatFiat(amtNum * unitUsd, currencyCode, fxRate)}`
      : '\u00a0'
  const feeXlm = (Number(inclusionFee()) / 10_000_000).toFixed(7)

  return (
    <div className="wallet-shell">
      <Nav onBack={() => router.back()} title="VEIL" />

      <main className="wallet-main wallet-main--wide">
        <div style={{ marginBottom: '1.75rem' }}>
          <PageHeader eyebrow="Transfer" title="Send money" />
        </div>

        {step === 'form' && (
          <div className="vw-send-stage vw-row vw-row--first" style={{ alignItems: 'flex-start' }}>
            <div className="vw-sendcol">

            <div>
              <div className="vw-fieldlabel">Asset</div>
              <button
                type="button"
                className="vw-assetcard"
                onClick={() => assets.length > 1 && setShowAssets((open) => !open)}
                aria-expanded={assets.length > 1 ? showAssets : undefined}
                aria-haspopup={assets.length > 1 ? 'listbox' : undefined}
              >
                <span className="vw-assetcard__left">
                  <span className="vw-send-swap" key={selectedAsset ? assetKey(selectedAsset) : 'none'}>
                    <span className="vw-avatar">{selectedAsset?.code.slice(0, 1) ?? '?'}</span>
                    <span style={{ display: 'flex', flexDirection: 'column', gap: 2, minWidth: 0 }}>
                      <span style={{ fontSize: 15, fontWeight: 600 }}>{selectedAsset?.code ?? '—'}</span>
                      <span className="vw-meta">
                        {selectedAsset
                          ? `${parseFloat(selectedAsset.balance).toFixed(4)} available`
                          : 'Loading…'}
                      </span>
                    </span>
                  </span>
                </span>
                {assets.length > 1 && (
                  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" aria-hidden="true" style={{ color: 'rgba(246,247,248,0.4)' }}>
                    <path d="M6 9l6 6 6-6" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/>
                  </svg>
                )}
              </button>
              {showAssets && assets.length > 1 && (
                <div className="vw-assetlist" role="listbox" aria-label="Select asset">
                  {assets.map((a) => (
                    <button
                      key={assetKey(a)}
                      type="button"
                      role="option"
                      aria-selected={selectedAsset ? assetKey(a) === assetKey(selectedAsset) : false}
                      onClick={() => { setSelectedAsset(a); setShowAssets(false) }}
                    >
                      <span className="vw-assetcard__left">
                        <span className="vw-avatar">{a.code.slice(0, 1)}</span>
                        <span>
                          <span style={{ display: 'block', fontSize: 15, fontWeight: 600 }}>{a.code}</span>
                          <span className="vw-meta">{parseFloat(a.balance).toFixed(4)}</span>
                        </span>
                      </span>
                    </button>
                  ))}
                </div>
              )}
            </div>

            <div>
              <label htmlFor="send-amount" className="vw-fieldlabel">Amount</label>
              <div className="vw-amountcard">
                <input
                  id="send-amount"
                  className="vw-amountinput"
                  type="number"
                  placeholder="0"
                  value={amount}
                  onChange={e => setAmount(e.target.value)}
                  min="0"
                  step="0.0000001"
                  aria-label={`Amount in ${selectedAsset?.code ?? 'asset'}`}
                />
                <div className="vw-amountsub">{fiatLabel}</div>
                <div className="vw-amountfoot">
                  <span className="vw-amountbal">
                    {selectedAsset ? `Balance ${parseFloat(selectedAsset.balance).toFixed(2)} ${selectedAsset.code}` : ''}
                  </span>
                  <span className="vw-chips">
                    {[0.25, 0.5, 0.75].map((f) => (
                      <button
                        key={f}
                        type="button"
                        className="vw-amountchip"
                        onClick={() => {
                          if (!selectedAsset) return
                          const bal = parseFloat(selectedAsset.balance)
                          if (!Number.isFinite(bal)) return
                          setAmount((Math.floor(bal * f * 1e7) / 1e7).toString())
                        }}
                      >
                        {f * 100}%
                      </button>
                    ))}
                    <button
                      type="button"
                      className="vw-amountchip"
                      onClick={() => {
                        if (!selectedAsset) return
                        const max = maxSendable(selectedAsset)
                        setAmount((Math.floor(max * 1e7) / 1e7).toString())
                      }}
                    >
                      Max
                    </button>
                  </span>
                </div>
              </div>
            </div>

            <div>
              <label htmlFor="send-recipient" className="vw-fieldlabel">To</label>
              <div className="vw-recipientcard">
                <input
                  id="send-recipient"
                  className="input-field mono"
                  type="text"
                  placeholder="G… or C…"
                  value={recipient}
                  onChange={e => { setRecipient(e.target.value.trim()); setImgError(null) }}
                  autoComplete="off"
                  spellCheck={false}
                  style={{ flex: 1 }}
                />
                {hasCamera && (
                  <button
                    type="button"
                    className="vw-roundbtn"
                    onClick={() => setShowScanner(true)}
                    aria-label="Scan QR code with camera"
                    title="Scan QR code with camera"
                  >
                    <svg width="16" height="16" viewBox="0 0 20 20" fill="none" aria-hidden="true">
                      <rect x="2" y="2" width="6" height="6" rx="1" stroke="currentColor" strokeWidth="1.5"/>
                      <rect x="12" y="2" width="6" height="6" rx="1" stroke="currentColor" strokeWidth="1.5"/>
                      <rect x="2" y="12" width="6" height="6" rx="1" stroke="currentColor" strokeWidth="1.5"/>
                      <rect x="4" y="4" width="2" height="2" fill="currentColor"/>
                      <rect x="14" y="4" width="2" height="2" fill="currentColor"/>
                      <rect x="4" y="14" width="2" height="2" fill="currentColor"/>
                      <path d="M12 12h2v2h-2zM14 14h2v2h-2zM16 12h2v2h-2zM12 16h4v2h-4z" fill="currentColor"/>
                    </svg>
                  </button>
                )}
                <button
                  type="button"
                  className="vw-roundbtn"
                  onClick={() => setShowPicker(true)}
                  aria-label="Choose from contacts"
                  title="Choose from contacts"
                >
                  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" aria-hidden="true">
                    <path d="M17 21v-2a4 4 0 00-4-4H5a4 4 0 00-4 4v2" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round"/>
                    <circle cx="9" cy="7" r="4" stroke="currentColor" strokeWidth="1.75"/>
                    <path d="M23 21v-2a4 4 0 00-3-3.87M16 3.13a4 4 0 010 7.75" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round"/>
                  </svg>
                </button>
                <button
                  type="button"
                  className="vw-roundbtn"
                  onClick={() => fileInputRef.current?.click()}
                  aria-label="Upload QR code image"
                  title="Upload a QR code image from your device"
                  disabled={imgDecoding}
                >
                  <span className="vw-send-swap" key={imgDecoding ? 'busy' : 'idle'}>
                    {imgDecoding ? (
                      <div className="spinner spinner-light" style={{ width: 16, height: 16 }} />
                    ) : (
                      <svg width="16" height="16" viewBox="0 0 20 20" fill="none" aria-hidden="true">
                        <path d="M3 13v3a1 1 0 001 1h12a1 1 0 001-1v-3" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"/>
                        <path d="M10 3v9M7 6l3-3 3 3" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/>
                      </svg>
                    )}
                  </span>
                </button>
                <input
                  ref={fileInputRef}
                  type="file"
                  accept="image/*"
                  style={{ display: 'none' }}
                  onChange={e => {
                    const file = e.target.files?.[0]
                    if (file) handleImageFile(file)
                  }}
                />
              </div>
              {imgError && (
                <p style={{ fontSize: '0.75rem', color: 'var(--teal)', marginTop: '0.375rem', lineHeight: 1.4 }}>
                  {imgError}
                </p>
              )}
            </div>

            <div>
              <label htmlFor="send-memo" className="vw-fieldlabel">Memo · optional</label>
              <input
                id="send-memo"
                className="input-field"
                type="text"
                placeholder="Add a note for the recipient"
                value={memo}
                onChange={e => setMemo(e.target.value)}
                maxLength={28}
              />
            </div>

            <div className="vw-feerow">
              <span className="vw-feerow__label">Network fee</span>
              <span className="vw-feerow__value">{feeXlm} XLM · paid by fee-payer</span>
            </div>

            <div className="vw-sendcta">
              <button
                className="btn-gold"
                onClick={() => setStep('confirm')}
                disabled={!validateForm()}
              >
                Review &amp; sign with passkey
              </button>
            </div>
            </div>

            <div className="vw-swapside">
              <div className="vw-panel" style={{ padding: '24px 26px' }}>
                <div className="vw-label">Summary</div>
                <div className="vw-sumrow">
                  <span>They receive</span>
                  <strong>{amount ? `${amount} ${selectedAsset?.code ?? ''}` : '—'}</strong>
                </div>
                <div className="vw-sumrow">
                  <span>Debited</span>
                  <strong className="font-mono">{amount ? `${amount} ${selectedAsset?.code ?? ''}` : '—'}</strong>
                </div>
                <div className="vw-sumrow vw-sumrow--last">
                  <span>Remaining</span>
                  <strong className="font-mono">
                    {selectedAsset && amount && Number.isFinite(parseFloat(amount))
                      ? `${Math.max(0, parseFloat(selectedAsset.balance) - parseFloat(amount)).toFixed(4)} ${selectedAsset.code}`
                      : '—'}
                  </strong>
                </div>
              </div>

              <div className="vw-panel" style={{ padding: '8px 26px 16px' }}>
                <div className="vw-label" style={{ padding: '18px 0 4px' }}>Recent recipients</div>
                {recentRecipients.length === 0 ? (
                  <p style={{ fontSize: '13px', color: 'rgba(246,247,248,0.4)', padding: '12px 0' }}>
                    Nobody yet. People you send to will appear here.
                  </p>
                ) : recentRecipients.map((addr) => (
                  <button
                    key={addr}
                    type="button"
                    className="vw-listrow"
                    style={{ padding: '13px 0' }}
                    onClick={() => setRecipient(addr)}
                  >
                    <span style={{ display: 'flex', alignItems: 'center', gap: '13px', minWidth: 0 }}>
                      <span className="vw-avatar">{addr.slice(0, 1)}</span>
                      <span className="vw-meta">{addr.slice(0, 6)}…{addr.slice(-6)}</span>
                    </span>
                  </button>
                ))}
              </div>
            </div>
          </div>
        )}

        {step === 'confirm' && (
          <div className="vw-send-stage" style={{ display: 'flex', flexDirection: 'column', gap: '1.25rem' }}>
            <div className="card">
              <div style={{ display: 'flex', flexDirection: 'column', gap: '1rem' }}>
                <Row label="To"      value={`${recipient.slice(0, 8)}...${recipient.slice(-8)}`} mono />
                <Row label="Amount"  value={`${amount} ${selectedAsset?.code ?? 'XLM'}`} mono />
                {memo && <Row label="Memo" value={memo} />}
                <Row label="Network" value={network.displayName} />
                <Row label="Auth"    value="Passkey (WebAuthn)" />
              </div>
            </div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: '0.75rem' }}>
              <button className="btn-gold" onClick={handleSend}>
                Confirm &amp; sign
              </button>
              <button className="btn-ghost" onClick={() => setStep('form')}>
                Edit
              </button>
            </div>
          </div>
        )}

        {step === 'signing' && (
          <div className="card vw-send-stage" style={{ textAlign: 'center' }}>
            <div style={{ display: 'flex', justifyContent: 'center', marginBottom: '1rem' }}>
              <div className="spinner spinner-light" />
            </div>
            <p style={{ fontWeight: 500 }}>Waiting for passkey…</p>
            <p style={{ fontSize: '0.8125rem', color: 'rgba(246,247,248,0.4)', marginTop: '0.5rem' }}>
              Approve the prompt to authorise the transfer
            </p>
          </div>
        )}

        {step === 'done' && (
          <div className="card vw-send-stage" style={{ display: 'flex', flexDirection: 'column', gap: '1.25rem', textAlign: 'center' }}>
            <svg width="40" height="40" viewBox="0 0 40 40" fill="none" style={{ margin: '0 auto' }}>
              <circle cx="20" cy="20" r="19" stroke="var(--teal)" strokeWidth="1.5"/>
              <path d="M13 20.5l5 5 9-9" stroke="var(--teal)" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/>
            </svg>
            <div>
              <p style={{ fontFamily: 'Lora, Georgia, serif', fontWeight: 600, fontStyle: 'italic', fontSize: '1.25rem' }}>
                Sent successfully
              </p>
              {txHash && (
                <p style={{ fontSize: '0.75rem', color: 'rgba(246,247,248,0.35)', fontFamily: 'Inconsolata, monospace', marginTop: '0.5rem', wordBreak: 'break-all' }}>
                  {txHash.slice(0, 20)}...
                </p>
              )}
            </div>
            <button className="btn-gold" onClick={() => router.push('/dashboard')}>
              Done
            </button>
          </div>
        )}

        {step === 'error' && (
          <div className="card vw-send-stage" style={{ display: 'flex', flexDirection: 'column', gap: '1.25rem', textAlign: 'center' }}>
            <svg width="40" height="40" viewBox="0 0 40 40" fill="none" style={{ margin: '0 auto' }}>
              <circle cx="20" cy="20" r="19" stroke="var(--teal)" strokeWidth="1.5" opacity="0.5"/>
              <path d="M14 14l12 12M26 14l-12 12" stroke="var(--teal)" strokeWidth="2" strokeLinecap="round"/>
            </svg>
            <div>
              <p style={{ fontWeight: 500 }}>Transaction failed</p>
              <p style={{ fontSize: '0.8125rem', color: 'rgba(246,247,248,0.4)', marginTop: '0.5rem' }}>
                {errorMsg}
              </p>
            </div>
            <button className="btn-ghost" onClick={() => setStep('form')}>
              Try again
            </button>
          </div>
        )}
      </main>

      {showPicker && (
        <ContactPicker
          onSelect={contact => { setRecipient(contact.address); setShowPicker(false) }}
          onClose={() => setShowPicker(false)}
        />
      )}

      {showScanner && (
        <QrScanner
          onScan={value => {
            const parsed = parseQrValue(value)
            if (!parsed) return

            if ('destination' in parsed) {
              if (parsed.destination) setRecipient(parsed.destination)
              if ('amount' in parsed && parsed.amount) setAmount(parsed.amount)
            } else {
              // Sep7Parsed
              if (parsed.destination) setRecipient(parsed.destination)
              if (parsed.amount) setAmount(parsed.amount)

              // If asset info is present, we could later auto-select asset.
            }

            // If SEP-7 URI provided a memo, we can also fill it.
            if (typeof parsed !== 'string' && 'memo' in parsed && parsed.memo) setMemo(parsed.memo)

            setShowScanner(false)
          }}
          onClose={() => setShowScanner(false)}
        />
      )}

    </div>
  )
}

function Row({ label, value, mono }: { label: string; value: string; mono?: boolean }) {
  return (
    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: '1rem' }}>
      <span style={{ fontSize: '0.8125rem', color: 'rgba(246,247,248,0.4)', flexShrink: 0 }}>{label}</span>
      <span style={{
        fontSize: '0.875rem',
        fontFamily: mono ? 'Inconsolata, monospace' : 'Inter, sans-serif',
        fontVariantNumeric: 'tabular-nums',
        textAlign: 'right',
        wordBreak: 'break-all',
      }}>
        {value}
      </span>
    </div>
  )
}
