'use client'

import { Suspense, useState, useEffect } from 'react'
import { useRouter, useSearchParams } from 'next/navigation'
import Link from 'next/link'
import { PageHeader, Card, Nav, SectionLabel, Amount } from '@/components/ui/primitives'
import {
  generateDisclosure,
  exportDisclosureAsFile,
  encodeDisclosureForLink,
  type SelectiveDisclosure,
} from '@/lib/privacy/disclosure'
import { SPP_NETWORKS } from '@/lib/privacy/config'

const PARTY_PRESETS = [
  'Landlord / Property Manager',
  'Mortgage Lender / Bank',
  'Tax Authority / IRS',
  'Employer / Payroll',
  'Escrow Agent',
]

function DiscloseContent() {
  const router = useRouter()
  const searchParams = useSearchParams()

  // Pre-fill from query params if coming from TxDetailSheet
  const paramTxId = searchParams.get('txId') || ''
  const paramAmount = searchParams.get('amount') || ''
  const paramAsset = searchParams.get('asset') || 'XLM'
  const paramCounterparty = searchParams.get('counterparty') || searchParams.get('recipient') || ''
  const paramTimestamp = Number(searchParams.get('timestamp')) || Math.floor(Date.now() / 1000)
  const paramHash = searchParams.get('hash') || ''
  const paramMemo = searchParams.get('memo') || ''

  const [amount, setAmount] = useState(paramAmount || '10.0000000')
  const [asset, setAsset] = useState(paramAsset || 'XLM')
  const [recipient, setRecipient] = useState(
    paramCounterparty || 'GBEXAMPLERECEIVERLANDLORDADDRESS3456789012345678901234567',
  )
  const [sender, setSender] = useState('GAEXAMPLEPAYERSENDERWALLET7XLMADDRESS234567890123456789012')
  const [txHash, setTxHash] = useState(
    paramHash || '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef',
  )
  const [timestamp, setTimestamp] = useState<number>(paramTimestamp)
  const [memo, setMemo] = useState(paramMemo)

  const [intendedParty, setIntendedParty] = useState('')
  const [generating, setGenerating] = useState(false)
  const [disclosure, setDisclosure] = useState<SelectiveDisclosure | null>(null)
  const [copiedLink, setCopiedLink] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [showRawJson, setShowRawJson] = useState(false)

  useEffect(() => {
    if (paramAmount) setAmount(paramAmount)
    if (paramAsset) setAsset(paramAsset)
    if (paramCounterparty) setRecipient(paramCounterparty)
    if (paramHash) setTxHash(paramHash)
    if (paramTimestamp) setTimestamp(paramTimestamp)
    if (paramMemo) setMemo(paramMemo)
  }, [paramAmount, paramAsset, paramCounterparty, paramHash, paramTimestamp, paramMemo])

  const handleGenerate = async (e: React.FormEvent) => {
    e.preventDefault()
    setError(null)

    if (!intendedParty.trim()) {
      setError('Please provide the intended party name to bind this disclosure proof.')
      return
    }

    setGenerating(true)
    try {
      const generated = await generateDisclosure({
        payment: {
          txHash,
          timestamp,
          amount,
          asset,
          sender,
          recipient,
          memo: memo || undefined,
        },
        intendedParty: intendedParty.trim(),
      })
      setDisclosure(generated)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setGenerating(false)
    }
  }

  const getVerificationUrl = (disc: SelectiveDisclosure): string => {
    const encoded = encodeDisclosureForLink(disc)
    const base = typeof window !== 'undefined' ? window.location.origin : ''
    return `${base}/privacy/verify?data=${encoded}`
  }

  const handleCopyLink = async () => {
    if (!disclosure) return
    const url = getVerificationUrl(disclosure)
    try {
      await navigator.clipboard.writeText(url)
      setCopiedLink(true)
      setTimeout(() => setCopiedLink(false), 2500)
    } catch {
      setError('Failed to copy link to clipboard')
    }
  }

  return (
    <div className="vw-shell" style={{ maxWidth: 560, margin: '0 auto', padding: '16px 20px 48px' }}>
      <Nav onBack={() => router.back()} title="Selective Disclosure" />

      <div style={{ marginTop: '20px' }}>
        <PageHeader eyebrow="Privacy" title="Prove this payment" />
      </div>

      <p style={{ fontSize: '13px', color: 'rgba(246,247,248,0.6)', lineHeight: 1.5, marginTop: '8px' }}>
        Privacy that can’t be shown to a bank, landlord or tax office is a liability. Generate a
        cryptographic, note-scoped disclosure proof bound specifically to the party you name. It reveals
        exactly this payment, and <strong>nothing</strong> about your other notes or shielded balance.
      </p>

      {!disclosure ? (
        <form onSubmit={handleGenerate} style={{ display: 'flex', flexDirection: 'column', gap: '18px', marginTop: '24px' }}>
          <Card>
            <SectionLabel tone="gold">Payment to Prove</SectionLabel>

            <div style={{ display: 'flex', flexDirection: 'column', gap: '12px', marginTop: '14px' }}>
              <div>
                <label style={{ display: 'block', fontSize: '11px', color: 'rgba(246,247,248,0.4)', textTransform: 'uppercase', marginBottom: '4px' }}>
                  Amount & Asset
                </label>
                <div style={{ display: 'flex', gap: '8px' }}>
                  <input
                    type="text"
                    value={amount}
                    onChange={(e) => setAmount(e.target.value)}
                    required
                    style={{
                      flex: 1,
                      background: 'rgba(255,255,255,0.04)',
                      border: '1px solid rgba(255,255,255,0.1)',
                      borderRadius: '12px',
                      padding: '10px 14px',
                      color: 'var(--off-white)',
                      fontFamily: 'Inconsolata, monospace',
                      fontSize: '15px',
                    }}
                  />
                  <input
                    type="text"
                    value={asset}
                    onChange={(e) => setAsset(e.target.value)}
                    style={{
                      width: '90px',
                      background: 'rgba(255,255,255,0.04)',
                      border: '1px solid rgba(255,255,255,0.1)',
                      borderRadius: '12px',
                      padding: '10px 14px',
                      color: 'var(--off-white)',
                      fontWeight: 600,
                      textAlign: 'center',
                    }}
                  />
                </div>
              </div>

              <div>
                <label style={{ display: 'block', fontSize: '11px', color: 'rgba(246,247,248,0.4)', textTransform: 'uppercase', marginBottom: '4px' }}>
                  Recipient Address
                </label>
                <input
                  type="text"
                  value={recipient}
                  onChange={(e) => setRecipient(e.target.value)}
                  required
                  style={{
                    width: '100%',
                    background: 'rgba(255,255,255,0.04)',
                    border: '1px solid rgba(255,255,255,0.1)',
                    borderRadius: '12px',
                    padding: '10px 14px',
                    color: 'var(--off-white)',
                    fontFamily: 'Inconsolata, monospace',
                    fontSize: '13px',
                  }}
                />
              </div>

              <div>
                <label style={{ display: 'block', fontSize: '11px', color: 'rgba(246,247,248,0.4)', textTransform: 'uppercase', marginBottom: '4px' }}>
                  Transaction Hash
                </label>
                <input
                  type="text"
                  value={txHash}
                  onChange={(e) => setTxHash(e.target.value)}
                  required
                  style={{
                    width: '100%',
                    background: 'rgba(255,255,255,0.04)',
                    border: '1px solid rgba(255,255,255,0.1)',
                    borderRadius: '12px',
                    padding: '10px 14px',
                    color: 'var(--off-white)',
                    fontFamily: 'Inconsolata, monospace',
                    fontSize: '13px',
                  }}
                />
              </div>

              {memo ? (
                <div>
                  <label style={{ display: 'block', fontSize: '11px', color: 'rgba(246,247,248,0.4)', textTransform: 'uppercase', marginBottom: '4px' }}>
                    Memo
                  </label>
                  <input
                    type="text"
                    value={memo}
                    onChange={(e) => setMemo(e.target.value)}
                    style={{
                      width: '100%',
                      background: 'rgba(255,255,255,0.04)',
                      border: '1px solid rgba(255,255,255,0.1)',
                      borderRadius: '12px',
                      padding: '10px 14px',
                      color: 'var(--off-white)',
                      fontSize: '13px',
                    }}
                  />
                </div>
              ) : null}
            </div>
          </Card>

          <Card>
            <SectionLabel tone="teal">Bound Party (Required)</SectionLabel>
            <p style={{ fontSize: '12px', color: 'rgba(246,247,248,0.5)', marginTop: '4px', marginBottom: '12px' }}>
              The proof will be cryptographically bound to this recipient so it cannot be altered or presented to third parties.
            </p>

            <input
              type="text"
              placeholder="e.g. Acme Landlord Corp, Barclays Mortgage, IRS"
              value={intendedParty}
              onChange={(e) => setIntendedParty(e.target.value)}
              required
              style={{
                width: '100%',
                background: 'rgba(255,255,255,0.04)',
                border: '1px solid rgba(0,167,181,0.3)',
                borderRadius: '12px',
                padding: '12px 14px',
                color: 'var(--off-white)',
                fontSize: '14px',
                marginBottom: '10px',
              }}
            />

            <div style={{ display: 'flex', flexWrap: 'wrap', gap: '6px' }}>
              {PARTY_PRESETS.map((preset) => (
                <button
                  key={preset}
                  type="button"
                  onClick={() => setIntendedParty(preset)}
                  style={{
                    background: intendedParty === preset ? 'rgba(0,167,181,0.2)' : 'rgba(255,255,255,0.05)',
                    border: intendedParty === preset ? '1px solid var(--teal)' : '1px solid rgba(255,255,255,0.1)',
                    borderRadius: '999px',
                    padding: '4px 10px',
                    fontSize: '11px',
                    color: intendedParty === preset ? 'var(--teal)' : 'rgba(246,247,248,0.7)',
                    cursor: 'pointer',
                  }}
                >
                  {preset}
                </button>
              ))}
            </div>
          </Card>

          <div
            style={{
              padding: '12px 16px',
              borderRadius: '16px',
              background: 'rgba(253,218,36,0.06)',
              border: '1px solid rgba(253,218,36,0.2)',
              fontSize: '12px',
              color: 'rgba(246,247,248,0.7)',
              display: 'flex',
              gap: '10px',
              alignItems: 'center',
            }}
          >
            <span style={{ fontSize: '18px' }}>🛡️</span>
            <span>
              <strong>Zero-Knowledge Scope:</strong> The proof targets canonical SPP verifier{' '}
              <code style={{ fontSize: '11px', color: 'var(--gold)' }}>
                {SPP_NETWORKS.testnet?.verifiers.standard.slice(0, 8)}…
              </code>{' '}
              and proves only this single note commitment.
            </span>
          </div>

          {error && (
            <div style={{ padding: '12px', borderRadius: '12px', background: 'rgba(255,100,100,0.1)', border: '1px solid rgba(255,100,100,0.3)', color: '#ff7777', fontSize: '13px' }}>
              {error}
            </div>
          )}

          <button
            type="submit"
            disabled={generating || !intendedParty.trim()}
            style={{
              background: 'linear-gradient(135deg, #fdda24 0%, #f3c82a 100%)',
              color: '#0a1220',
              fontWeight: 700,
              fontSize: '15px',
              padding: '14px 20px',
              borderRadius: '9999px',
              border: 'none',
              cursor: generating || !intendedParty.trim() ? 'not-allowed' : 'pointer',
              opacity: generating || !intendedParty.trim() ? 0.6 : 1,
              transition: 'opacity 0.2s',
            }}
          >
            {generating ? 'Generating Proof…' : 'Generate Disclosure Proof →'}
          </button>
        </form>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: '20px', marginTop: '24px' }}>
          <div
            style={{
              background: 'rgba(0,167,181,0.08)',
              border: '1px solid rgba(0,167,181,0.3)',
              borderRadius: '20px',
              padding: '18px 20px',
            }}
          >
            <div style={{ display: 'flex', alignItems: 'center', gap: '10px', marginBottom: '6px' }}>
              <span style={{ color: 'var(--teal)', fontSize: '20px' }}>✓</span>
              <h2 style={{ fontSize: '16px', fontWeight: 700, color: 'var(--teal)', margin: 0 }}>
                Selective Disclosure Generated
              </h2>
            </div>
            <p style={{ fontSize: '12px', color: 'rgba(246,247,248,0.7)', margin: 0, lineHeight: 1.5 }}>
              This disclosure reveals exactly this one payment and is bound to <strong>{disclosure.intendedParty}</strong>.
            </p>
          </div>

          <Card>
            <SectionLabel tone="gold">Disclosure Proof Summary</SectionLabel>

            <div style={{ display: 'flex', flexDirection: 'column', gap: '10px', marginTop: '14px', fontSize: '13px' }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', borderBottom: '1px solid rgba(255,255,255,0.05)', paddingBottom: '8px' }}>
                <span style={{ color: 'rgba(246,247,248,0.4)' }}>Bound Intended Party</span>
                <span style={{ fontWeight: 600, color: 'var(--gold)' }}>{disclosure.intendedParty}</span>
              </div>

              <div style={{ display: 'flex', justifyContent: 'space-between', borderBottom: '1px solid rgba(255,255,255,0.05)', paddingBottom: '8px' }}>
                <span style={{ color: 'rgba(246,247,248,0.4)' }}>Amount Disclosed</span>
                <Amount className="font-semibold text-teal">
                  {disclosure.payment.amount} {disclosure.payment.asset}
                </Amount>
              </div>

              <div style={{ display: 'flex', justifyContent: 'space-between', borderBottom: '1px solid rgba(255,255,255,0.05)', paddingBottom: '8px' }}>
                <span style={{ color: 'rgba(246,247,248,0.4)' }}>Recipient</span>
                <span className="font-mono" style={{ fontSize: '12px' }}>
                  {disclosure.payment.recipient.slice(0, 8)}…{disclosure.payment.recipient.slice(-8)}
                </span>
              </div>

              <div style={{ display: 'flex', justifyContent: 'space-between', borderBottom: '1px solid rgba(255,255,255,0.05)', paddingBottom: '8px' }}>
                <span style={{ color: 'rgba(246,247,248,0.4)' }}>Tx Hash</span>
                <span className="font-mono" style={{ fontSize: '12px' }}>
                  {disclosure.payment.txHash.slice(0, 8)}…{disclosure.payment.txHash.slice(-8)}
                </span>
              </div>

              <div style={{ display: 'flex', justifyContent: 'space-between', borderBottom: '1px solid rgba(255,255,255,0.05)', paddingBottom: '8px' }}>
                <span style={{ color: 'rgba(246,247,248,0.4)' }}>Note Commitment</span>
                <span className="font-mono" style={{ fontSize: '12px' }}>
                  {disclosure.noteScope.noteCommitment.slice(0, 10)}…
                </span>
              </div>

              <div style={{ display: 'flex', justifyContent: 'space-between' }}>
                <span style={{ color: 'rgba(246,247,248,0.4)' }}>Canonical Verifier</span>
                <span className="font-mono" style={{ fontSize: '12px' }}>
                  {disclosure.verifierContractId.slice(0, 8)}…
                </span>
              </div>
            </div>
          </Card>

          <div style={{ display: 'flex', flexDirection: 'column', gap: '10px' }}>
            <button
              type="button"
              onClick={() => exportDisclosureAsFile(disclosure)}
              style={{
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                gap: '8px',
                background: 'rgba(255,255,255,0.08)',
                border: '1px solid rgba(255,255,255,0.15)',
                color: 'var(--off-white)',
                fontWeight: 600,
                fontSize: '14px',
                padding: '12px 18px',
                borderRadius: '16px',
                cursor: 'pointer',
              }}
            >
              📥 Export as File (.json)
            </button>

            <button
              type="button"
              onClick={handleCopyLink}
              style={{
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                gap: '8px',
                background: copiedLink ? 'rgba(0,167,181,0.2)' : 'rgba(255,255,255,0.08)',
                border: copiedLink ? '1px solid var(--teal)' : '1px solid rgba(255,255,255,0.15)',
                color: copiedLink ? 'var(--teal)' : 'var(--off-white)',
                fontWeight: 600,
                fontSize: '14px',
                padding: '12px 18px',
                borderRadius: '16px',
                cursor: 'pointer',
              }}
            >
              🔗 {copiedLink ? 'Verification Link Copied!' : 'Copy Verification Link'}
            </button>

            <Link
              href={`/privacy/verify?data=${encodeDisclosureForLink(disclosure)}`}
              style={{
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                gap: '8px',
                background: 'linear-gradient(135deg, #fdda24 0%, #f3c82a 100%)',
                color: '#0a1220',
                fontWeight: 700,
                fontSize: '14px',
                padding: '12px 18px',
                borderRadius: '16px',
                textDecoration: 'none',
                marginTop: '4px',
              }}
            >
              Open Verify Page →
            </Link>
          </div>

          <div style={{ marginTop: '12px' }}>
            <button
              type="button"
              onClick={() => setShowRawJson(!showRawJson)}
              style={{
                background: 'transparent',
                border: 'none',
                color: 'rgba(246,247,248,0.5)',
                fontSize: '12px',
                cursor: 'pointer',
                display: 'flex',
                alignItems: 'center',
                gap: '4px',
              }}
            >
              {showRawJson ? 'Hide' : 'View'} Raw Disclosure JSON
            </button>

            {showRawJson && (
              <pre
                style={{
                  marginTop: '8px',
                  padding: '12px',
                  background: 'rgba(0,0,0,0.4)',
                  border: '1px solid rgba(255,255,255,0.08)',
                  borderRadius: '12px',
                  fontSize: '11px',
                  lineHeight: 1.4,
                  color: 'rgba(246,247,248,0.7)',
                  overflowX: 'auto',
                }}
              >
                {JSON.stringify(disclosure, null, 2)}
              </pre>
            )}
          </div>

          <button
            type="button"
            onClick={() => setDisclosure(null)}
            style={{
              background: 'transparent',
              border: 'none',
              color: 'rgba(246,247,248,0.4)',
              fontSize: '13px',
              cursor: 'pointer',
              marginTop: '8px',
            }}
          >
            ← Generate another disclosure
          </button>
        </div>
      )}
    </div>
  )
}

export default function DisclosePage() {
  return (
    <Suspense fallback={<div className="vw-shell" style={{ padding: 40, textAlign: 'center' }}>Loading disclosure...</div>}>
      <DiscloseContent />
    </Suspense>
  )
}
