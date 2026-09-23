'use client'

import { useEffect, useState, type CSSProperties } from 'react'

interface AnchorDirectoryModalProps {
  isOpen: boolean
  url: string | null
  title?: string
  onClose: () => void
  onComplete?: () => void
}

export function AnchorDirectoryModal({
  isOpen,
  url,
  title = 'Anchor Hosted Flow',
  onClose,
  onComplete,
}: AnchorDirectoryModalProps) {
  const [iframeLoading, setIframeLoading] = useState(true)

  useEffect(() => {
    if (!isOpen || !url) return

    // Listen for postMessage events from SEP-24 anchor flow (e.g. status: 'complete' / 'close')
    function handleMessage(event: MessageEvent) {
      if (!event.data) return
      const data = typeof event.data === 'string' ? safeJsonParse(event.data) : event.data
      if (data && (data.type === 'sep24_complete' || data.status === 'completed')) {
        onComplete?.()
        onClose()
      } else if (data && (data.type === 'sep24_close' || data.action === 'close')) {
        onClose()
      }
    }

    window.addEventListener('message', handleMessage)
    return () => window.removeEventListener('message', handleMessage)
  }, [isOpen, url, onClose, onComplete])

  if (!isOpen || !url) return null

  return (
    <div style={overlayStyle} role="dialog" aria-modal="true" aria-label={title}>
      <div style={modalStyle}>
        <header style={headerStyle}>
          <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
            <span style={dotStyle} />
            <h3 style={{ fontSize: '1rem', fontWeight: 600, color: 'var(--off-white)', margin: 0 }}>
              {title}
            </h3>
          </div>
          <div style={{ display: 'flex', gap: '0.5rem' }}>
            <button
              onClick={() => window.open(url, '_blank', 'width=520,height=740')}
              style={secondaryBtnStyle}
              title="Open in new window"
            >
              Pop-out ↗
            </button>
            <button onClick={onClose} style={closeBtnStyle} aria-label="Close modal">
              ✕
            </button>
          </div>
        </header>

        <div style={contentStyle}>
          {iframeLoading && (
            <div style={loaderOverlayStyle}>
              <p style={{ color: 'var(--warm-grey)', fontSize: '0.875rem' }}>
                Connecting to anchor securely via SEP-10…
              </p>
            </div>
          )}
          <iframe
            src={url}
            title={title}
            style={iframeStyle}
            onLoad={() => setIframeLoading(false)}
            sandbox="allow-same-origin allow-scripts allow-forms allow-popups allow-top-navigation"
          />
        </div>
      </div>
    </div>
  )
}

function safeJsonParse(str: string): any {
  try {
    return JSON.parse(str)
  } catch {
    return null
  }
}

const overlayStyle: CSSProperties = {
  position: 'fixed',
  top: 0,
  left: 0,
  right: 0,
  bottom: 0,
  backgroundColor: 'rgba(10, 12, 16, 0.85)',
  backdropFilter: 'blur(8px)',
  zIndex: 9999,
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
  padding: '1rem',
}

const modalStyle: CSSProperties = {
  background: 'var(--near-black, #12151c)',
  border: '1px solid var(--border-dim, rgba(255,255,255,0.12))',
  borderRadius: '0.875rem',
  width: '100%',
  maxWidth: '560px',
  height: '80vh',
  maxHeight: '740px',
  display: 'flex',
  flexDirection: 'column',
  overflow: 'hidden',
  boxShadow: '0 20px 40px rgba(0, 0, 0, 0.6)',
}

const headerStyle: CSSProperties = {
  display: 'flex',
  justifyContent: 'space-between',
  alignItems: 'center',
  padding: '0.875rem 1.25rem',
  borderBottom: '1px solid var(--border-dim, rgba(255,255,255,0.08))',
  background: 'rgba(255,255,255,0.02)',
}

const dotStyle: CSSProperties = {
  width: '8px',
  height: '8px',
  borderRadius: '50%',
  backgroundColor: '#00a7b5',
}

const contentStyle: CSSProperties = {
  position: 'relative',
  flex: 1,
  width: '100%',
  height: '100%',
}

const loaderOverlayStyle: CSSProperties = {
  position: 'absolute',
  top: 0,
  left: 0,
  right: 0,
  bottom: 0,
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
  background: 'var(--near-black, #12151c)',
  zIndex: 1,
}

const iframeStyle: CSSProperties = {
  width: '100%',
  height: '100%',
  border: 'none',
}

const closeBtnStyle: CSSProperties = {
  background: 'none',
  border: 'none',
  color: 'var(--warm-grey, #999)',
  fontSize: '1rem',
  cursor: 'pointer',
  padding: '0.25rem 0.5rem',
  borderRadius: '0.25rem',
}

const secondaryBtnStyle: CSSProperties = {
  background: 'rgba(246,247,248,0.08)',
  border: '1px solid rgba(255,255,255,0.15)',
  color: 'var(--off-white, #f6f7f8)',
  fontSize: '0.75rem',
  padding: '0.25rem 0.625rem',
  borderRadius: '0.375rem',
  cursor: 'pointer',
}
