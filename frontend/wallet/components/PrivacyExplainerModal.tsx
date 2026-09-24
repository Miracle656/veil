'use client'

import React from 'react'

interface PrivacyExplainerModalProps {
  isOpen: boolean
  onClose: () => void
}

export function PrivacyExplainerModal({ isOpen, onClose }: PrivacyExplainerModalProps) {
  if (!isOpen) return null

  return (
    <div
      className="modal-backdrop"
      style={{
        position: 'fixed',
        inset: 0,
        backgroundColor: 'rgba(0, 0, 0, 0.75)',
        backdropFilter: 'blur(6px)',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        padding: '1rem',
        zIndex: 9999,
      }}
      onClick={onClose}
    >
      <div
        className="modal-content"
        style={{
          background: 'var(--surface-md, #16181b)',
          border: '1px solid var(--border-dim, rgba(246, 247, 248, 0.12))',
          borderRadius: '16px',
          maxWidth: '520px',
          width: '100%',
          maxHeight: '90vh',
          overflowY: 'auto',
          padding: '1.5rem',
          color: 'var(--off-white, #f6f7f8)',
          boxShadow: '0 20px 40px rgba(0, 0, 0, 0.5)',
        }}
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '1.25rem' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: '0.625rem' }}>
            <span style={{ fontSize: '1.25rem' }}>🛡️</span>
            <h2 style={{ margin: 0, fontSize: '1.125rem', fontWeight: 600, color: 'var(--off-white)' }}>
              What &quot;Private&quot; Means in Veil
            </h2>
          </div>
          <button
            onClick={onClose}
            aria-label="Close"
            style={{
              background: 'none',
              border: 'none',
              color: 'var(--color-muted, rgba(246,247,248,0.5))',
              fontSize: '1.25rem',
              cursor: 'pointer',
              padding: '0.25rem',
            }}
          >
            ✕
          </button>
        </div>

        {/* Notice badge */}
        <div
          style={{
            padding: '0.75rem 1rem',
            background: 'rgba(217, 119, 6, 0.12)',
            border: '1px solid rgba(217, 119, 6, 0.3)',
            borderRadius: '10px',
            marginBottom: '1.25rem',
            fontSize: '0.8125rem',
            lineHeight: 1.5,
            color: '#fbbf24',
          }}
        >
          <strong>Developer Preview:</strong> Privacy features use Stellar Private Payments (SPP) on <strong>Testnet only</strong>.
        </div>

        {/* Section 1: What is hidden vs public */}
        <div style={{ marginBottom: '1.25rem' }}>
          <h3 style={{ fontSize: '0.9375rem', fontWeight: 600, marginBottom: '0.625rem', color: 'var(--gold, #c5a059)' }}>
            1. Inside vs. Outside the Pool
          </h3>
          <div style={{ display: 'flex', flexDirection: 'column', gap: '0.5rem', fontSize: '0.8125rem' }}>
            <div
              style={{
                padding: '0.625rem 0.75rem',
                background: 'rgba(16, 185, 129, 0.08)',
                border: '1px solid rgba(16, 185, 129, 0.25)',
                borderRadius: '8px',
              }}
            >
              <strong style={{ color: '#34d399' }}>✓ Hidden (Inside the Pool):</strong> Transfer amounts and counterparty addresses during a private send are cryptographically hidden.
            </div>
            <div
              style={{
                padding: '0.625rem 0.75rem',
                background: 'rgba(239, 68, 68, 0.08)',
                border: '1px solid rgba(239, 68, 68, 0.25)',
                borderRadius: '8px',
              }}
            >
              <strong style={{ color: '#f87171' }}>✗ Public (Entering & Exiting):</strong> Deposits (shield) and withdrawals (unshield) are standard on-chain transactions visible on block explorers.
            </div>
          </div>
        </div>

        {/* Section 2: Why shield/unshield are visible */}
        <div style={{ marginBottom: '1.25rem' }}>
          <h3 style={{ fontSize: '0.9375rem', fontWeight: 600, marginBottom: '0.5rem', color: 'var(--gold, #c5a059)' }}>
            2. Why Shield and Unshield are Visible
          </h3>
          <p style={{ fontSize: '0.8125rem', color: 'rgba(246, 247, 248, 0.75)', lineHeight: 1.5, margin: 0 }}>
            Moving funds into or out of the pool bridges Stellar&apos;s public ledger with the pool smart contract. However, outside observers cannot link which deposit corresponds to which withdrawal.
          </p>
        </div>

        {/* Section 3: Selective Disclosure */}
        <div style={{ marginBottom: '1.25rem' }}>
          <h3 style={{ fontSize: '0.9375rem', fontWeight: 600, marginBottom: '0.5rem', color: 'var(--gold, #c5a059)' }}>
            3. Selective Disclosure (&quot;Prove this Payment&quot;)
          </h3>
          <p style={{ fontSize: '0.8125rem', color: 'rgba(246, 247, 248, 0.75)', lineHeight: 1.5, margin: 0 }}>
            You can generate a single cryptographic proof for a specific transaction (e.g. for tax reporting or paying rent) without revealing your overall balance or other transactions.
          </p>
        </div>

        {/* Section 4: Compliance Controls */}
        <div style={{ marginBottom: '1.5rem' }}>
          <h3 style={{ fontSize: '0.9375rem', fontWeight: 600, marginBottom: '0.5rem', color: 'var(--gold, #c5a059)' }}>
            4. Compliance &amp; Operator Controls
          </h3>
          <p style={{ fontSize: '0.8125rem', color: 'rgba(246, 247, 248, 0.75)', lineHeight: 1.5, margin: 0 }}>
            Pools use Association Set Providers (ASPs) with allow/block-lists. The pool operator has the authority to freeze listed keys or notes associated with sanctioned addresses.
          </p>
        </div>

        {/* Actions */}
        <div style={{ display: 'flex', gap: '0.75rem', justifyContent: 'flex-end' }}>
          <a
            href="https://docs.useveilapp.xyz/privacy"
            target="_blank"
            rel="noopener noreferrer"
            className="btn-secondary"
            style={{
              padding: '0.625rem 1rem',
              fontSize: '0.8125rem',
              textDecoration: 'none',
              textAlign: 'center',
              display: 'inline-flex',
              alignItems: 'center',
              gap: '0.375rem',
            }}
          >
            <span>Read full user guide</span>
            <span aria-hidden="true">↗</span>
          </a>
          <button
            onClick={onClose}
            className="btn-gold"
            style={{ padding: '0.625rem 1.25rem', fontSize: '0.8125rem' }}
          >
            Got it
          </button>
        </div>
      </div>
    </div>
  )
}
