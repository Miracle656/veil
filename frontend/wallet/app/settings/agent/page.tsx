'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { useInactivityLock } from '@/hooks/useInactivityLock'

const SERVICES = [
  { name: 'Oracle', description: 'Live SDEX + AMM price data', pricePerCall: '0.10 USDC' },
  { name: 'Wraith', description: 'Soroban transfer history', pricePerCall: '0.10 USDC' },
]

export default function AgentSettingsPage() {
  const router = useRouter()
  useInactivityLock()

  const [agentEnabled, setAgentEnabled] = useState(() =>
    typeof window !== 'undefined' && localStorage.getItem('veil_agent_enabled') === 'true'
  )
  const [perTxLimit, setPerTxLimit] = useState(() =>
    typeof window !== 'undefined' ? (localStorage.getItem('veil_agent_per_tx_limit') ?? '10') : '10'
  )
  const [dailyLimit, setDailyLimit] = useState(() =>
    typeof window !== 'undefined' ? (localStorage.getItem('veil_agent_daily_limit') ?? '100') : '100'
  )
  const [saved, setSaved] = useState(false)

  const saveSettings = () => {
    localStorage.setItem('veil_agent_enabled', String(agentEnabled))
    localStorage.setItem('veil_agent_per_tx_limit', perTxLimit)
    localStorage.setItem('veil_agent_daily_limit', dailyLimit)
    setSaved(true)
    setTimeout(() => setSaved(false), 2000)
  }

  const revokeAgent = () => {
    localStorage.removeItem('veil_agent_enabled')
    localStorage.removeItem('veil_agent_per_tx_limit')
    localStorage.removeItem('veil_agent_daily_limit')
    setAgentEnabled(false)
    router.back()
  }

  return (
    <div className="wallet-shell">
      <header className="wallet-nav">
        <button
          onClick={() => router.back()}
          style={{ background: 'none', border: 'none', cursor: 'pointer', padding: '0.25rem', color: 'var(--warm-grey)', display: 'flex' }}
        >
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none">
            <path d="M19 12H5M12 19l-7-7 7-7" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/>
          </svg>
        </button>
        <span style={{ fontWeight: 600, fontSize: '0.9375rem' }}>Agent Settings</span>
        <div style={{ width: '28px' }} />
      </header>

      <main className="wallet-main" style={{ display: 'flex', flexDirection: 'column', gap: '1rem' }}>

        {/* Enable toggle */}
        <div className="card">
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: '0.75rem' }}>
              <div style={{
                width: '2.25rem', height: '2.25rem', borderRadius: '10px',
                background: 'rgba(253,218,36,0.08)', border: '1px solid rgba(253,218,36,0.15)',
                display: 'flex', alignItems: 'center', justifyContent: 'center',
              }}>
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none">
                  <path d="M12 2a4 4 0 0 1 4 4v1a4 4 0 0 1-8 0V6a4 4 0 0 1 4-4zm0 10c-4 0-7 2-7 4v1h14v-1c0-2-3-4-7-4z" stroke="var(--gold)" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/>
                </svg>
              </div>
              <div>
                <div style={{ fontSize: '0.9375rem', fontWeight: 600 }}>Veil Agent</div>
                <div style={{ fontSize: '0.75rem', color: 'var(--warm-grey)' }}>Autonomous task execution</div>
              </div>
            </div>
            <button
              onClick={() => setAgentEnabled(!agentEnabled)}
              style={{
                position: 'relative', width: '44px', height: '24px', borderRadius: '100px',
                background: agentEnabled ? 'var(--gold)' : 'var(--surface-md)',
                border: `1px solid ${agentEnabled ? 'var(--gold)' : 'var(--border-dim)'}`,
                cursor: 'pointer', transition: 'background 120ms',
              }}
            >
              <span style={{
                position: 'absolute', top: '2px',
                left: agentEnabled ? '22px' : '2px',
                width: '18px', height: '18px', borderRadius: '50%',
                background: agentEnabled ? 'var(--near-black)' : 'var(--warm-grey)',
                transition: 'left 120ms',
              }} />
            </button>
          </div>
        </div>

        {/* Spending limits */}
        <div className="card">
          <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', marginBottom: '1.25rem' }}>
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none">
              <polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2" stroke="var(--gold)" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/>
            </svg>
            <span style={{ fontSize: '0.75rem', fontFamily: 'Anton, Impact, sans-serif', letterSpacing: '0.08em', color: 'var(--warm-grey)' }}>SPENDING LIMITS</span>
          </div>

          <div style={{ display: 'flex', flexDirection: 'column', gap: '1rem' }}>
            <div>
              <label style={{ fontSize: '0.8125rem', color: 'var(--warm-grey)', display: 'block', marginBottom: '0.5rem' }}>
                Per-transaction limit (XLM)
              </label>
              <input
                type="number"
                value={perTxLimit}
                onChange={(e) => setPerTxLimit(e.target.value)}
                min="1"
                className="input-field"
              />
              <p style={{ fontSize: '0.75rem', color: 'rgba(214,210,196,0.5)', marginTop: '0.375rem' }}>
                Agent auto-executes transactions up to this amount
              </p>
            </div>
            <div>
              <label style={{ fontSize: '0.8125rem', color: 'var(--warm-grey)', display: 'block', marginBottom: '0.5rem' }}>
                Daily spending limit (XLM)
              </label>
              <input
                type="number"
                value={dailyLimit}
                onChange={(e) => setDailyLimit(e.target.value)}
                min="1"
                className="input-field"
              />
            </div>
          </div>
        </div>

        {/* Allowed services */}
        <div className="card">
          <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', marginBottom: '1.25rem' }}>
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none">
              <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z" stroke="var(--teal)" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/>
            </svg>
            <span style={{ fontSize: '0.75rem', fontFamily: 'Anton, Impact, sans-serif', letterSpacing: '0.08em', color: 'var(--warm-grey)' }}>ALLOWED SERVICES (X402)</span>
          </div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: '0.875rem' }}>
            {SERVICES.map((svc) => (
              <div key={svc.name} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                <div>
                  <div style={{ fontSize: '0.875rem', fontWeight: 500 }}>{svc.name}</div>
                  <div style={{ fontSize: '0.75rem', color: 'var(--warm-grey)' }}>{svc.description}</div>
                </div>
                <div style={{ textAlign: 'right' }}>
                  <div style={{ fontSize: '0.75rem', color: 'var(--warm-grey)' }}>{svc.pricePerCall}</div>
                  <div style={{ fontSize: '0.6875rem', color: 'var(--teal)' }}>Enabled</div>
                </div>
              </div>
            ))}
          </div>
        </div>

        <button onClick={saveSettings} className="btn-gold">
          {saved ? 'Saved!' : 'Save Settings'}
        </button>

        <button
          onClick={revokeAgent}
          className="btn-ghost"
          style={{ color: '#f87171', borderColor: 'rgba(248,113,113,0.2)' }}
        >
          Revoke Agent Access
        </button>
      </main>
    </div>
  )
}
