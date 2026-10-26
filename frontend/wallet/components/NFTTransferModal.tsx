'use client'

import React, { useState } from 'react'
import type { NFTItem } from '@/lib/nfts'
import {
  getTokenBoundName,
  getNameTransferWarningCopy,
  validateNFTTransfer,
  shouldShowNameTransferWarning,
} from '@/lib/nftTransfer'

interface NFTTransferModalProps {
  token: NFTItem | null
  isOpen: boolean
  onClose: () => void
  onTransfer: (recipient: string, warningConfirmed: boolean) => Promise<void> | void
}

export function NFTTransferModal({ token, isOpen, onClose, onTransfer }: NFTTransferModalProps) {
  const [recipient, setRecipient] = useState('')
  const [warningConfirmed, setWarningConfirmed] = useState(false)
  const [isSubmitting, setIsSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)

  if (!isOpen || !token) return null

  const boundName = getTokenBoundName(token)
  const hasName = shouldShowNameTransferWarning(token)
  const warningCopy = boundName ? getNameTransferWarningCopy(boundName) : null

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    setError(null)

    const validation = validateNFTTransfer(token, recipient, warningConfirmed)
    if (!validation.valid) {
      setError(validation.error || 'Please fix validation errors.')
      return
    }

    try {
      setIsSubmitting(true)
      await onTransfer(recipient.trim(), warningConfirmed)
      onClose()
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Transfer failed.')
    } finally {
      setIsSubmitting(false)
    }
  }

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="nft-transfer-title"
      style={{
        position: 'fixed',
        inset: 0,
        backgroundColor: 'rgba(0, 0, 0, 0.8)',
        backdropFilter: 'blur(8px)',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        padding: '1.25rem',
        zIndex: 10000,
      }}
      onClick={onClose}
    >
      <div
        style={{
          background: 'var(--surface-md, #16181b)',
          border: '1px solid var(--border-dim, rgba(246, 247, 248, 0.12))',
          borderRadius: '16px',
          maxWidth: '520px',
          width: '100%',
          maxHeight: '90vh',
          overflowY: 'auto',
          padding: '1.75rem',
          color: 'var(--off-white, #f6f7f8)',
          boxShadow: '0 25px 50px -12px rgba(0,0,0,0.7)',
        }}
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '1.25rem' }}>
          <div>
            <span style={{ fontSize: '0.75rem', color: 'var(--gold, #FDDA24)', fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.05em' }}>
              CAP-46 Transfer
            </span>
            <h2 id="nft-transfer-title" style={{ margin: '0.25rem 0 0', fontSize: '1.25rem', fontWeight: 600, color: 'var(--off-white)' }}>
              Transfer Token #{token.tokenId}
            </h2>
          </div>
          <button
            onClick={onClose}
            aria-label="Close"
            style={{
              background: 'var(--surface, #1e2024)',
              border: 'none',
              color: 'var(--text-muted, rgba(246,247,248,0.6))',
              width: '32px',
              height: '32px',
              borderRadius: '50%',
              cursor: 'pointer',
              fontSize: '1.125rem',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
            }}
          >
            ✕
          </button>
        </div>

        <form onSubmit={handleSubmit} style={{ display: 'flex', flexDirection: 'column', gap: '1.25rem' }}>
          {/* Token Summary */}
          <div style={{ background: 'var(--surface, #1e2024)', padding: '0.875rem 1rem', borderRadius: '10px', border: '1px solid var(--border-dim)' }}>
            <div style={{ fontSize: '0.8125rem', color: 'var(--text-muted)', marginBottom: '0.2rem' }}>Item</div>
            <div style={{ fontSize: '0.9375rem', fontWeight: 600, color: 'var(--off-white)' }}>{token.name}</div>
            {boundName && (
              <div style={{ marginTop: '0.35rem', fontSize: '0.8125rem', color: 'var(--teal, #00FFC8)' }}>
                Bound name: <strong>{boundName}</strong>
              </div>
            )}
          </div>

          {/* Recipient Address */}
          <div>
            <label htmlFor="nft-recipient-input" style={{ display: 'block', fontSize: '0.8125rem', fontWeight: 600, color: 'var(--text-muted)', marginBottom: '0.5rem' }}>
              Recipient Stellar Address
            </label>
            <input
              id="nft-recipient-input"
              type="text"
              value={recipient}
              onChange={(e) => {
                setRecipient(e.target.value)
                setError(null)
              }}
              placeholder="G... or C..."
              autoFocus
              style={{
                width: '100%',
                background: 'var(--surface, #1e2024)',
                border: '1px solid var(--border-dim, rgba(246, 247, 248, 0.2))',
                borderRadius: '8px',
                padding: '0.75rem 1rem',
                color: 'var(--off-white)',
                fontSize: '0.875rem',
                fontFamily: 'Inconsolata, monospace',
                boxSizing: 'border-box',
              }}
            />
          </div>

          {/* Name Consequence Warning - ONLY shown if token carries a name */}
          {hasName && warningCopy && (
            <div
              data-testid="name-transfer-warning-card"
              style={{
                background: 'rgba(253, 218, 36, 0.08)',
                border: '1px solid rgba(253, 218, 36, 0.3)',
                borderRadius: '12px',
                padding: '1rem',
                display: 'flex',
                flexDirection: 'column',
                gap: '0.75rem',
              }}
            >
              <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', color: 'var(--gold, #FDDA24)' }}>
                <span style={{ fontSize: '1.1rem' }}>⚠️</span>
                <span style={{ fontWeight: 600, fontSize: '0.875rem' }}>
                  {warningCopy.title}
                </span>
              </div>
              <p style={{ margin: 0, fontSize: '0.8125rem', color: 'var(--off-white)', lineHeight: 1.5 }}>
                {warningCopy.consequence}
              </p>
              <label
                style={{
                  display: 'flex',
                  alignItems: 'flex-start',
                  gap: '0.625rem',
                  fontSize: '0.8125rem',
                  color: 'var(--off-white)',
                  cursor: 'pointer',
                  marginTop: '0.25rem',
                  userSelect: 'none',
                }}
              >
                <input
                  type="checkbox"
                  data-testid="name-transfer-confirm-checkbox"
                  checked={warningConfirmed}
                  onChange={(e) => {
                    setWarningConfirmed(e.target.checked)
                    setError(null)
                  }}
                  style={{ marginTop: '0.15rem' }}
                />
                <span>{warningCopy.acknowledgmentLabel}</span>
              </label>
            </div>
          )}

          {/* Error Message */}
          {error && (
            <div
              role="alert"
              style={{
                color: '#ff6b6b',
                background: 'rgba(255, 107, 107, 0.1)',
                border: '1px solid rgba(255, 107, 107, 0.3)',
                borderRadius: '8px',
                padding: '0.625rem 0.875rem',
                fontSize: '0.8125rem',
              }}
            >
              {error}
            </div>
          )}

          {/* Action Buttons */}
          <div style={{ display: 'flex', gap: '0.75rem', marginTop: '0.5rem' }}>
            <button
              type="button"
              onClick={onClose}
              disabled={isSubmitting}
              style={{
                flex: 1,
                padding: '0.75rem',
                background: 'var(--surface, #1e2024)',
                border: '1px solid var(--border-dim)',
                color: 'var(--off-white)',
                borderRadius: '8px',
                fontSize: '0.875rem',
                fontWeight: 500,
                cursor: 'pointer',
              }}
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={isSubmitting || (hasName && !warningConfirmed)}
              data-testid="confirm-transfer-button"
              style={{
                flex: 2,
                padding: '0.75rem',
                background: hasName && !warningConfirmed ? 'var(--surface-md, #2a2e35)' : 'var(--teal, #00FFC8)',
                border: 'none',
                color: hasName && !warningConfirmed ? 'var(--text-muted, rgba(246,247,248,0.4))' : '#000',
                borderRadius: '8px',
                fontSize: '0.875rem',
                fontWeight: 600,
                cursor: hasName && !warningConfirmed || isSubmitting ? 'not-allowed' : 'pointer',
                transition: 'all 0.15s ease',
              }}
            >
              {isSubmitting ? 'Transferring…' : 'Sign & Transfer'}
            </button>
          </div>
        </form>
      </div>
    </div>
  )
}
