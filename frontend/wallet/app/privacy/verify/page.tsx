'use client'

import { Suspense, useState, useEffect } from 'react'
import { useRouter, useSearchParams } from 'next/navigation'
import Link from 'next/link'
import { PageHeader, Card, Nav, SectionLabel, Amount } from '@/components/ui/primitives'
import {
  verifyDisclosure,
  decodeDisclosureFromLink,
  type DisclosureVerificationResult,
  type SelectiveDisclosure,
} from '@/lib/privacy/disclosure'

function VerifyContent() {
  const router = useRouter()
  const searchParams = useSearchParams()

  const [inputData, setInputData] = useState('')
  const [verifying, setVerifying] = useState(false)
  const [result, setResult] = useState<DisclosureVerificationResult | null>(null)
  const [sourceDisclosure, setSourceDisclosure] = useState<SelectiveDisclosure | null>(null)
  const [errorMsg, setErrorMsg] = useState<string | null>(null)

  const runVerification = async (disc: unknown) => {
    setVerifying(true)
    setErrorMsg(null)
    try {
      const res = await verifyDisclosure(disc)
      setResult(res)
      if (res.valid && res.disclosure) {
        setSourceDisclosure(res.disclosure)
      } else {
        setSourceDisclosure((disc as SelectiveDisclosure) || null)
      }
    } catch (err) {
      setErrorMsg(err instanceof Error ? err.message : String(err))
      setResult({
        valid: false,
        error: err instanceof Error ? err.message : String(err),
      })
    } finally {
      setVerifying(false)
    }
  }

  // Auto-verify if data is present in searchParams or window.location.hash
  useEffect(() => {
    const queryParam = searchParams.get('data')
    if (queryParam) {
      try {
        const decoded = decodeDisclosureFromLink(queryParam)
        setInputData(JSON.stringify(decoded, null, 2))
        runVerification(decoded)
      } catch (e) {
        setErrorMsg('Failed to parse disclosure data from URL link')
      }
      return
    }

    if (typeof window !== 'undefined' && window.location.hash) {
      const hash = window.location.hash.replace(/^#/, '')
      const match = hash.match(/data=([^&]+)/)
      if (match && match[1]) {
        try {
          const decoded = decodeDisclosureFromLink(match[1])
          setInputData(JSON.stringify(decoded, null, 2))
          runVerification(decoded)
        } catch {
          // ignore hash parse failure
        }
      }
    }
  }, [searchParams])

  const handleManualVerify = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!inputData.trim()) return

    try {
      let parsed: unknown
      const trimmed = inputData.trim()

      if (trimmed.includes('/privacy/verify?data=') || trimmed.startsWith('http')) {
        const url = new URL(trimmed)
        const dataParam = url.searchParams.get('data')
        if (!dataParam) throw new Error('No disclosure data parameter found in URL')
        parsed = decodeDisclosureFromLink(dataParam)
      } else {
        parsed = JSON.parse(trimmed)
      }

      await runVerification(parsed)
    } catch (err) {
      setErrorMsg(`Invalid disclosure format: ${err instanceof Error ? err.message : String(err)}`)
      setResult({
        valid: false,
        error: `Could not parse disclosure JSON: ${err instanceof Error ? err.message : String(err)}`,
      })
    }
  }

  const handleFileUpload = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]
    if (!file) return

    const reader = new FileReader()
    reader.onload = async (event) => {
      const text = event.target?.result as string
      if (!text) return
      setInputData(text)
      try {
        const parsed = JSON.parse(text)
        await runVerification(parsed)
      } catch (err) {
        setErrorMsg('File content is not valid JSON')
        setResult({
          valid: false,
          error: 'File does not contain valid JSON disclosure data',
        })
      }
    }
    reader.readAsText(file)
  }

  return (
    <div className="vw-shell" style={{ maxWidth: 560, margin: '0 auto', padding: '16px 20px 48px' }}>
      <Nav onBack={() => router.push('/dashboard')} title="Selective Disclosure" />

      <div style={{ marginTop: '20px' }}>
        <PageHeader eyebrow="Verifier" title="Verify Payment Proof" />
      </div>

      <p style={{ fontSize: '13px', color: 'rgba(246,247,248,0.6)', lineHeight: 1.5, marginTop: '8px' }}>
        Check the authenticity of a note-scoped selective payment disclosure. The verifier checks
        cryptographic commitment integrity against the canonical Stellar Private Payments (SPP) verifier,
        confirming that the payment is genuine, bound to the intended party, and has not been altered.
      </p>

      {verifying && (
        <div style={{ textAlign: 'center', padding: '36px 0', color: 'var(--teal)' }}>
          <div style={{ fontSize: '24px', marginBottom: '8px' }}>⚙️</div>
          <div style={{ fontSize: '14px', fontWeight: 600 }}>Verifying cryptographic disclosure proof…</div>
        </div>
      )}

      {result && !verifying && (
        <div style={{ marginTop: '24px', display: 'flex', flexDirection: 'column', gap: '20px' }}>
          {result.valid && result.verificationDetails ? (
            <>
              <div
                style={{
                  background: 'rgba(0,167,181,0.08)',
                  border: '1px solid rgba(0,167,181,0.3)',
                  borderRadius: '20px',
                  padding: '18px 20px',
                }}
              >
                <div style={{ display: 'flex', alignItems: 'center', gap: '10px', marginBottom: '6px' }}>
                  <span style={{ color: 'var(--teal)', fontSize: '22px' }}>✓</span>
                  <h2 style={{ fontSize: '16px', fontWeight: 700, color: 'var(--teal)', margin: 0 }}>
                    Valid Payment Disclosure
                  </h2>
                </div>
                <p style={{ fontSize: '12px', color: 'rgba(246,247,248,0.7)', margin: 0, lineHeight: 1.5 }}>
                  Cryptographic verification against canonical SPP verifier succeeded. All payment
                  attributes and party bindings are authentic and untampered.
                </p>
              </div>

              <Card>
                <SectionLabel tone="teal">Verified Payment Details</SectionLabel>

                <div style={{ display: 'flex', flexDirection: 'column', gap: '12px', marginTop: '14px', fontSize: '13px' }}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', borderBottom: '1px solid rgba(255,255,255,0.05)', paddingBottom: '8px' }}>
                    <span style={{ color: 'rgba(246,247,248,0.4)' }}>Bound Intended Party</span>
                    <span style={{ fontWeight: 700, color: 'var(--gold)', textAlign: 'right' }}>
                      {result.verificationDetails.verifiedParty}
                    </span>
                  </div>

                  <div style={{ display: 'flex', justifyContent: 'space-between', borderBottom: '1px solid rgba(255,255,255,0.05)', paddingBottom: '8px' }}>
                    <span style={{ color: 'rgba(246,247,248,0.4)' }}>Verified Amount</span>
                    <Amount className="font-semibold text-teal text-[15px]">
                      {result.verificationDetails.verifiedAmount}
                    </Amount>
                  </div>

                  <div style={{ display: 'flex', justifyContent: 'space-between', borderBottom: '1px solid rgba(255,255,255,0.05)', paddingBottom: '8px' }}>
                    <span style={{ color: 'rgba(246,247,248,0.4)' }}>Recipient</span>
                    <span className="font-mono" style={{ fontSize: '12px', wordBreak: 'break-all', textAlign: 'right', maxWidth: '65%' }}>
                      {result.verificationDetails.verifiedRecipient}
                    </span>
                  </div>

                  <div style={{ display: 'flex', justifyContent: 'space-between', borderBottom: '1px solid rgba(255,255,255,0.05)', paddingBottom: '8px' }}>
                    <span style={{ color: 'rgba(246,247,248,0.4)' }}>Sender</span>
                    <span className="font-mono" style={{ fontSize: '12px', wordBreak: 'break-all', textAlign: 'right', maxWidth: '65%' }}>
                      {result.verificationDetails.verifiedSender}
                    </span>
                  </div>

                  <div style={{ display: 'flex', justifyContent: 'space-between', borderBottom: '1px solid rgba(255,255,255,0.05)', paddingBottom: '8px' }}>
                    <span style={{ color: 'rgba(246,247,248,0.4)' }}>Tx Hash</span>
                    <a
                      href={`https://stellar.expert/explorer/testnet/tx/${result.verificationDetails.verifiedTxHash}`}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="font-mono"
                      style={{ fontSize: '12px', color: 'var(--gold)', textDecoration: 'none', borderBottom: '1px dotted rgba(253,218,36,0.4)' }}
                    >
                      {result.verificationDetails.verifiedTxHash.slice(0, 10)}…{result.verificationDetails.verifiedTxHash.slice(-8)} ↗
                    </a>
                  </div>

                  <div style={{ display: 'flex', justifyContent: 'space-between', borderBottom: '1px solid rgba(255,255,255,0.05)', paddingBottom: '8px' }}>
                    <span style={{ color: 'rgba(246,247,248,0.4)' }}>Payment Date</span>
                    <span>{result.verificationDetails.verifiedDate}</span>
                  </div>

                  <div style={{ display: 'flex', justifyContent: 'space-between', borderBottom: '1px solid rgba(255,255,255,0.05)', paddingBottom: '8px' }}>
                    <span style={{ color: 'rgba(246,247,248,0.4)' }}>Note Commitment</span>
                    <span className="font-mono" style={{ fontSize: '12px' }}>
                      {result.verificationDetails.noteCommitment.slice(0, 12)}…
                    </span>
                  </div>

                  <div style={{ display: 'flex', justifyContent: 'space-between' }}>
                    <span style={{ color: 'rgba(246,247,248,0.4)' }}>Canonical Verifier</span>
                    <span className="font-mono" style={{ fontSize: '12px' }}>
                      {result.verificationDetails.verifierContractId.slice(0, 8)}…
                    </span>
                  </div>
                </div>
              </Card>

              <div
                style={{
                  padding: '14px 18px',
                  borderRadius: '16px',
                  background: 'rgba(253,218,36,0.05)',
                  border: '1px solid rgba(253,218,36,0.2)',
                  fontSize: '12px',
                  color: 'rgba(246,247,248,0.7)',
                  lineHeight: 1.5,
                }}
              >
                🔒 <strong>Privacy Assurance:</strong> This selective disclosure proves exactly this single payment.
                No other notes, nullifiers, balances, or transaction history were revealed.
              </div>
            </>
          ) : (
            <div
              style={{
                background: 'rgba(255,60,60,0.08)',
                border: '1px solid rgba(255,60,60,0.3)',
                borderRadius: '20px',
                padding: '18px 20px',
              }}
            >
              <div style={{ display: 'flex', alignItems: 'center', gap: '10px', marginBottom: '6px' }}>
                <span style={{ color: '#ff6666', fontSize: '22px' }}>⚠️</span>
                <h2 style={{ fontSize: '16px', fontWeight: 700, color: '#ff6666', margin: 0 }}>
                  Disclosure Verification Rejected
                </h2>
              </div>
              <p style={{ fontSize: '13px', color: '#ff9999', margin: '4px 0 12px', fontWeight: 600 }}>
                {result.error || 'The proof is invalid or has been altered.'}
              </p>
              <p style={{ fontSize: '12px', color: 'rgba(246,247,248,0.7)', margin: 0, lineHeight: 1.5 }}>
                The payment details, intended party binding, or zero-knowledge proof failed cryptographic
                consistency checks. Do <strong>not</strong> accept this disclosure as proof of payment.
              </p>
            </div>
          )}

          <button
            type="button"
            onClick={() => {
              setResult(null)
              setInputData('')
              setSourceDisclosure(null)
            }}
            style={{
              background: 'rgba(255,255,255,0.08)',
              border: '1px solid rgba(255,255,255,0.15)',
              color: 'var(--off-white)',
              padding: '12px 18px',
              borderRadius: '16px',
              fontWeight: 600,
              fontSize: '13px',
              cursor: 'pointer',
            }}
          >
            ← Verify another disclosure
          </button>
        </div>
      )}

      {(!result || verifying) && (
        <form onSubmit={handleManualVerify} style={{ marginTop: '24px', display: 'flex', flexDirection: 'column', gap: '18px' }}>
          <Card>
            <SectionLabel tone="gold">Import Disclosure</SectionLabel>

            <div style={{ marginTop: '14px', display: 'flex', flexDirection: 'column', gap: '14px' }}>
              <div>
                <label
                  htmlFor="file-upload"
                  style={{
                    display: 'flex',
                    flexDirection: 'column',
                    alignItems: 'center',
                    justifyContent: 'center',
                    border: '1px dashed rgba(255,255,255,0.2)',
                    borderRadius: '16px',
                    padding: '24px 16px',
                    cursor: 'pointer',
                    background: 'rgba(255,255,255,0.02)',
                    transition: 'border-color 0.2s',
                  }}
                >
                  <span style={{ fontSize: '24px', marginBottom: '6px' }}>📄</span>
                  <span style={{ fontSize: '13px', fontWeight: 600, color: 'var(--off-white)' }}>
                    Upload disclosure .json file
                  </span>
                  <span style={{ fontSize: '11px', color: 'rgba(246,247,248,0.4)', marginTop: '2px' }}>
                    Click or drop JSON exported from Veil
                  </span>
                  <input
                    id="file-upload"
                    type="file"
                    accept=".json"
                    onChange={handleFileUpload}
                    style={{ display: 'none' }}
                  />
                </label>
              </div>

              <div>
                <label style={{ display: 'block', fontSize: '11px', color: 'rgba(246,247,248,0.4)', textTransform: 'uppercase', marginBottom: '6px' }}>
                  Or paste disclosure JSON or verification URL
                </label>
                <textarea
                  rows={6}
                  value={inputData}
                  onChange={(e) => setInputData(e.target.value)}
                  placeholder="Paste { ... } JSON or https://veil.app/privacy/verify?data=..."
                  style={{
                    width: '100%',
                    background: 'rgba(255,255,255,0.04)',
                    border: '1px solid rgba(255,255,255,0.1)',
                    borderRadius: '12px',
                    padding: '12px',
                    color: 'var(--off-white)',
                    fontFamily: 'Inconsolata, monospace',
                    fontSize: '12px',
                    lineHeight: 1.4,
                  }}
                />
              </div>
            </div>
          </Card>

          {errorMsg && (
            <div style={{ padding: '12px', borderRadius: '12px', background: 'rgba(255,100,100,0.1)', border: '1px solid rgba(255,100,100,0.3)', color: '#ff7777', fontSize: '13px' }}>
              {errorMsg}
            </div>
          )}

          <button
            type="submit"
            disabled={!inputData.trim() || verifying}
            style={{
              background: 'linear-gradient(135deg, #00a7b5 0%, #008894 100%)',
              color: '#ffffff',
              fontWeight: 700,
              fontSize: '15px',
              padding: '14px 20px',
              borderRadius: '9999px',
              border: 'none',
              cursor: !inputData.trim() || verifying ? 'not-allowed' : 'pointer',
              opacity: !inputData.trim() || verifying ? 0.6 : 1,
            }}
          >
            {verifying ? 'Checking Proof…' : 'Verify Disclosure Proof →'}
          </button>

          <div style={{ textAlign: 'center', marginTop: '8px' }}>
            <Link
              href="/privacy/disclose"
              style={{ fontSize: '13px', color: 'var(--gold)', textDecoration: 'none' }}
            >
              Need to generate a proof? Go to Disclose →
            </Link>
          </div>
        </form>
      )}
    </div>
  )
}

export default function VerifyPage() {
  return (
    <Suspense fallback={<div className="vw-shell" style={{ padding: 40, textAlign: 'center' }}>Loading verifier...</div>}>
      <VerifyContent />
    </Suspense>
  )
}
