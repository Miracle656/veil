'use client'

import React, { useEffect, useState } from 'react'
import { Shield, Clock, AlertTriangle, ArrowRight, CheckCircle2, ChevronDown, ChevronUp } from 'lucide-react'

import {
  type PendingStealthSweep,
  getPendingStealthSweeps,
  executeStealthSweep,
  getStealthLinkageDisclosure,
} from '@/lib/privacy/stealthSweep'

export interface StealthSweepCardProps {
  onSweepComplete?: (sweepId: string, txHash: string) => void
}

export function StealthSweepCard({ onSweepComplete }: StealthSweepCardProps) {
  const [sweeps, setSweeps] = useState<PendingStealthSweep[]>([])
  const [isExecuting, setIsExecuting] = useState<string | null>(null)
  const [errorMessage, setErrorMessage] = useState<string | null>(null)
  const [disclosureOpen, setDisclosureOpen] = useState(false)
  const [now, setNow] = useState(Date.now())

  useEffect(() => {
    setSweeps(getPendingStealthSweeps())
    const interval = setInterval(() => {
      setNow(Date.now())
      setSweeps(getPendingStealthSweeps())
    }, 5000)
    return () => clearInterval(interval)
  }, [])

  const disclosure = getStealthLinkageDisclosure()
  const activeSweeps = sweeps.filter((s) => s.status === 'pending' || s.status === 'executing')

  if (activeSweeps.length === 0) {
    return null
  }

  async function handleForceSweep(sweepId: string) {
    try {
      setIsExecuting(sweepId)
      setErrorMessage(null)
      const result = await executeStealthSweep(sweepId, { force: true })
      setSweeps(getPendingStealthSweeps())
      if (onSweepComplete) {
        onSweepComplete(sweepId, result.txHash)
      }
    } catch (err) {
      setErrorMessage(err instanceof Error ? err.message : String(err))
    } finally {
      setIsExecuting(null)
    }
  }

  return (
    <div
      className="card"
      style={{
        background: 'var(--surface, #16181b)',
        border: '1px solid var(--border-dim, rgba(246, 247, 248, 0.12))',
        borderRadius: 14,
        padding: '1.25rem',
        marginTop: '1.25rem',
        marginBottom: '1.25rem',
        color: 'var(--off-white, #f6f7f8)',
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '0.875rem' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: '0.625rem' }}>
          <Shield size={18} color="var(--gold, #c5a059)" />
          <h3 style={{ margin: 0, fontSize: '0.9375rem', fontWeight: 600, letterSpacing: '0.02em' }}>
            Pending Stealth Receipts ({activeSweeps.length})
          </h3>
        </div>
        <button
          type="button"
          onClick={() => setDisclosureOpen(!disclosureOpen)}
          aria-expanded={disclosureOpen}
          style={{
            background: 'none',
            border: 'none',
            color: 'var(--color-muted, rgba(246,247,248,0.5))',
            cursor: 'pointer',
            fontSize: '0.75rem',
            display: 'flex',
            alignItems: 'center',
            gap: '0.25rem',
            padding: '0.25rem 0.5rem',
          }}
        >
          <span>What observers see</span>
          {disclosureOpen ? <ChevronUp size={14} /> : <ChevronDown size={14} />}
        </button>
      </div>

      {/* Honest Linkage & Threat Model Disclosure */}
      {disclosureOpen && (
        <div
          style={{
            background: 'rgba(0, 0, 0, 0.25)',
            border: '1px solid rgba(246, 247, 248, 0.08)',
            borderRadius: 10,
            padding: '1rem',
            marginBottom: '1rem',
            fontSize: '0.8125rem',
            lineHeight: 1.5,
          }}
        >
          <p style={{ margin: '0 0 0.5rem', color: 'rgba(246, 247, 248, 0.85)' }}>
            {disclosure.summary}
          </p>

          <div style={{ marginBottom: '0.625rem' }}>
            <strong style={{ color: '#34d399', display: 'block', marginBottom: '0.25rem' }}>
              What is hidden:
            </strong>
            <ul style={{ margin: 0, paddingLeft: '1.25rem', color: 'rgba(246, 247, 248, 0.75)' }}>
              {disclosure.hiddenGuarantees.map((item, idx) => (
                <li key={idx}>{item}</li>
              ))}
            </ul>
          </div>

          <div style={{ marginBottom: '0.625rem' }}>
            <strong style={{ color: '#f87171', display: 'block', marginBottom: '0.25rem' }}>
              What an observer can still correlate:
            </strong>
            <ul style={{ margin: 0, paddingLeft: '1.25rem', color: 'rgba(246, 247, 248, 0.75)' }}>
              {disclosure.observableLinkage.map((item, idx) => (
                <li key={idx}>{item}</li>
              ))}
            </ul>
          </div>

          <p style={{ margin: 0, fontStyle: 'italic', color: 'var(--gold, #c5a059)', fontSize: '0.75rem' }}>
            {disclosure.recommendation}
          </p>
        </div>
      )}

      {errorMessage && (
        <div
          style={{
            background: 'rgba(239, 68, 68, 0.1)',
            border: '1px solid rgba(239, 68, 68, 0.3)',
            borderRadius: 8,
            padding: '0.625rem 0.75rem',
            marginBottom: '0.875rem',
            fontSize: '0.8125rem',
            color: '#f87171',
          }}
        >
          {errorMessage}
        </div>
      )}

      {/* Sweep Items */}
      <div style={{ display: 'flex', flexDirection: 'column', gap: '0.75rem' }}>
        {activeSweeps.map((sweep) => {
          const remainingSeconds = Math.max(0, Math.ceil((sweep.scheduledExecutionTime - now) / 1000))
          const remainingMinutes = Math.ceil(remainingSeconds / 60)
          const isReady = remainingSeconds === 0
          const executingThis = isExecuting === sweep.id

          return (
            <div
              key={sweep.id}
              style={{
                background: 'rgba(246, 247, 248, 0.03)',
                border: '1px solid rgba(246, 247, 248, 0.08)',
                borderRadius: 10,
                padding: '0.875rem',
              }}
            >
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: '0.5rem' }}>
                <div>
                  <span style={{ fontSize: '1rem', fontWeight: 600, color: 'var(--off-white)' }}>
                    +{sweep.amount} {sweep.asset.code}
                  </span>
                  <div style={{ fontSize: '0.75rem', color: 'rgba(246,247,248,0.5)', marginTop: '0.125rem' }}>
                    Received at one-time stealth address
                  </div>
                </div>

                <div
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    gap: '0.375rem',
                    fontSize: '0.75rem',
                    color: isReady ? 'var(--teal, #2dd4bf)' : 'var(--gold, #c5a059)',
                    background: isReady ? 'rgba(45, 212, 191, 0.1)' : 'rgba(197, 160, 89, 0.1)',
                    padding: '0.25rem 0.5rem',
                    borderRadius: 6,
                  }}
                >
                  <Clock size={12} />
                  <span>
                    {isReady ? 'Ready to sweep' : `Delay: ~${remainingMinutes} min remaining`}
                  </span>
                </div>
              </div>

              <div style={{ fontSize: '0.75rem', color: 'rgba(246, 247, 248, 0.6)', marginBottom: '0.75rem' }}>
                <div style={{ marginBottom: '0.25rem' }}>
                  <span style={{ color: 'rgba(246,247,248,0.4)' }}>One-time address: </span>
                  <code style={{ wordBreak: 'break-all', fontSize: '0.6875rem' }}>
                    {sweep.oneTimePublicKey}
                  </code>
                </div>
                <div>
                  <span style={{ color: 'rgba(246,247,248,0.4)' }}>Destination wallet: </span>
                  <code style={{ wordBreak: 'break-all', fontSize: '0.6875rem' }}>
                    {sweep.destinationContractAddress}
                  </code>
                </div>
              </div>

              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                <p style={{ margin: 0, fontSize: '0.75rem', color: 'rgba(246,247,248,0.4)', lineHeight: 1.4, maxWidth: '65%' }}>
                  Decorrelation delay separates receipt from sweep to avoid timing analysis.
                </p>

                <button
                  type="button"
                  onClick={() => handleForceSweep(sweep.id)}
                  disabled={executingThis}
                  className="btn-secondary"
                  style={{
                    fontSize: '0.75rem',
                    padding: '0.375rem 0.75rem',
                    width: 'auto',
                    whiteSpace: 'nowrap',
                  }}
                >
                  {executingThis ? 'Sweeping' : 'Sweep now'}
                </button>
              </div>
            </div>
          )
        })}
      </div>
    </div>
  )
}
