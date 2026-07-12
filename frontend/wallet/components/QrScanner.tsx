'use client'

import { useEffect, useRef, useState } from 'react'

interface QrScannerProps {
  onScan: (address: string) => void
  onClose: () => void
}

// BarcodeDetector is not yet in the standard TS lib — declare minimally.
interface BarcodeDetectorResult {
  rawValue: string
}
interface BarcodeDetectorApi {
  detect(source: HTMLVideoElement): Promise<BarcodeDetectorResult[]>
}
declare const BarcodeDetector: {
  new(options: { formats: string[] }): BarcodeDetectorApi
}

export function isValidStellarAddress(addr: string): boolean {
  return (addr.startsWith('G') || addr.startsWith('C')) && addr.length === 56
}

export function QrScanner({ onScan, onClose }: QrScannerProps) {
  const videoRef = useRef<HTMLVideoElement>(null)
  const streamRef = useRef<MediaStream | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [announcement, setAnnouncement] = useState('')
  const [manualAddress, setManualAddress] = useState('')
  const [manualError, setManualError] = useState<string | null>(null)

  useEffect(() => {
    let animFrame = 0
    let stopped = false

    function stop() {
      stopped = true
      cancelAnimationFrame(animFrame)
      streamRef.current?.getTracks().forEach(t => t.stop())
    }

    async function start() {
      try {
        const stream = await navigator.mediaDevices.getUserMedia({
          video: { facingMode: 'environment' },
        })
        if (stopped) { stream.getTracks().forEach(t => t.stop()); return }
        streamRef.current = stream

        const video = videoRef.current
        if (!video) return
        video.srcObject = stream
        await video.play()

        if (!('BarcodeDetector' in window)) {
          setError('QR scanning requires a Chromium-based browser (Chrome 88+, Edge 88+).')
          return
        }

        const detector = new BarcodeDetector({ formats: ['qr_code'] })

        async function scan() {
          if (stopped || !video) return
          try {
            const codes = await detector.detect(video)
            for (const code of codes) {
              const addr = code.rawValue.trim()
              if (isValidStellarAddress(addr)) {
                setAnnouncement(`QR code recognized. Address: ${addr}`)
                stop()
                onScan(addr)
                return
              }
            }
          } catch { /* transient detection errors are expected */ }
          animFrame = requestAnimationFrame(scan)
        }

        animFrame = requestAnimationFrame(scan)
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err)
        setError(msg.includes('Permission') || msg.includes('NotAllowed')
          ? 'Camera access denied. Allow camera in browser settings.'
          : msg)
      }
    }

    start()
    return stop
  }, [onScan])

  function handleManualSubmit(e: React.FormEvent) {
    e.preventDefault()
    const addr = manualAddress.trim()
    if (!isValidStellarAddress(addr)) {
      setManualError('Enter a valid Stellar address (G... or C..., 56 characters).')
      return
    }
    setManualError(null)
    onScan(addr)
  }

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label="Scan or enter recipient address"
      style={{
        position: 'fixed', inset: 0, zIndex: 50,
        background: 'rgba(15,15,15,0.95)',
        display: 'flex', flexDirection: 'column',
        alignItems: 'center', justifyContent: 'center',
        padding: '1.5rem',
      }}
    >
      {/* aria-live region — announces QR recognition to screen readers */}
      <div
        aria-live="polite"
        aria-atomic="true"
        style={{
          position: 'absolute', width: 1, height: 1,
          overflow: 'hidden', clip: 'rect(0 0 0 0)',
          whiteSpace: 'nowrap', border: 0,
        }}
      >
        {announcement}
      </div>

      <div style={{ width: '100%', maxWidth: 360 }}>
        {/* Header */}
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '1rem' }}>
          <span style={{
            fontFamily: 'Lora, Georgia, serif', fontWeight: 600, fontStyle: 'italic',
            fontSize: '1.125rem', color: 'var(--off-white)',
          }}>
            Scan Recipient QR
          </span>
          <button
            onClick={onClose}
            aria-label="Close scanner"
            style={{
              background: 'none', border: 'none', cursor: 'pointer',
              color: 'var(--off-white)', fontSize: '1.5rem', lineHeight: 1, padding: '0.25rem',
            }}
          >
            ×
          </button>
        </div>

        {/* Video viewfinder */}
        <div style={{
          position: 'relative', borderRadius: '0.75rem', overflow: 'hidden',
          background: '#000', aspectRatio: '1',
        }}>
          <video
            ref={videoRef}
            muted
            playsInline
            aria-label="Camera viewfinder for QR scanning"
            style={{ width: '100%', height: '100%', objectFit: 'cover', display: 'block' }}
          />
          {/* Corner-bracket viewfinder overlay */}
          <div style={{
            position: 'absolute', inset: 0,
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            pointerEvents: 'none',
          }}>
            <div style={{ position: 'relative', width: 200, height: 200 }}>
              {(['topLeft', 'topRight', 'bottomLeft', 'bottomRight'] as const).map(corner => (
                <CornerBracket key={corner} corner={corner} />
              ))}
            </div>
          </div>
        </div>

        {error ? (
          <p style={{
            marginTop: '0.875rem', fontSize: '0.8125rem',
            color: 'rgba(246,247,248,0.6)', textAlign: 'center',
          }}>
            {error}
          </p>
        ) : (
          <p style={{
            marginTop: '0.875rem', fontSize: '0.75rem',
            color: 'rgba(246,247,248,0.35)', textAlign: 'center',
          }}>
            Point camera at a Stellar address QR code (G... or C...)
          </p>
        )}

        {/* Fallback: manual address entry for screen-reader / no-camera users */}
        <div style={{ marginTop: '1.25rem' }}>
          <div style={{
            display: 'flex', alignItems: 'center', gap: '0.5rem',
            marginBottom: '0.625rem',
          }}>
            <div style={{ flex: 1, height: 1, background: 'rgba(246,247,248,0.15)' }} aria-hidden="true" />
            <span style={{ fontSize: '0.6875rem', color: 'rgba(246,247,248,0.4)', whiteSpace: 'nowrap' }}>
              or type / paste address
            </span>
            <div style={{ flex: 1, height: 1, background: 'rgba(246,247,248,0.15)' }} aria-hidden="true" />
          </div>

          <form onSubmit={handleManualSubmit} noValidate>
            <label
              htmlFor="qr-manual-address"
              style={{
                display: 'block', fontSize: '0.6875rem',
                color: 'rgba(246,247,248,0.5)', marginBottom: '0.375rem',
              }}
            >
              Stellar address
            </label>
            <input
              id="qr-manual-address"
              type="text"
              value={manualAddress}
              onChange={e => { setManualAddress(e.target.value); setManualError(null) }}
              placeholder="G... or C..."
              autoComplete="off"
              spellCheck={false}
              aria-describedby={manualError ? 'qr-manual-error' : undefined}
              aria-invalid={manualError ? true : undefined}
              style={{
                width: '100%',
                boxSizing: 'border-box',
                background: 'rgba(246,247,248,0.06)',
                border: `1px solid ${manualError ? 'rgba(255,80,80,0.6)' : 'rgba(246,247,248,0.15)'}`,
                borderRadius: '0.5rem',
                color: 'var(--off-white)',
                fontSize: '0.8125rem',
                padding: '0.5rem 0.75rem',
                outline: 'none',
              }}
            />
            {manualError && (
              <p
                id="qr-manual-error"
                role="alert"
                style={{
                  marginTop: '0.375rem', fontSize: '0.75rem',
                  color: 'rgba(255,100,100,0.9)',
                }}
              >
                {manualError}
              </p>
            )}
            <button
              type="submit"
              className="btn-ghost"
              style={{ marginTop: '0.75rem', width: '100%' }}
            >
              Use this address
            </button>
          </form>
        </div>

        <button
          className="btn-ghost"
          onClick={onClose}
          style={{ marginTop: '0.75rem', width: '100%' }}
        >
          Cancel
        </button>
      </div>
    </div>
  )
}

type Corner = 'topLeft' | 'topRight' | 'bottomLeft' | 'bottomRight'

function CornerBracket({ corner }: { corner: Corner }) {
  const size = 20
  const thickness = 2
  const color = 'var(--gold)'

  const styles: Record<Corner, React.CSSProperties> = {
    topLeft:     { top: 0, left: 0, borderTop: `${thickness}px solid ${color}`, borderLeft: `${thickness}px solid ${color}` },
    topRight:    { top: 0, right: 0, borderTop: `${thickness}px solid ${color}`, borderRight: `${thickness}px solid ${color}` },
    bottomLeft:  { bottom: 0, left: 0, borderBottom: `${thickness}px solid ${color}`, borderLeft: `${thickness}px solid ${color}` },
    bottomRight: { bottom: 0, right: 0, borderBottom: `${thickness}px solid ${color}`, borderRight: `${thickness}px solid ${color}` },
  }

  return (
    <div style={{
      position: 'absolute',
      width: size, height: size,
      borderRadius: 2,
      ...styles[corner],
    }} />
  )
}
