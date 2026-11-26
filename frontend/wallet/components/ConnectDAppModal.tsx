'use client'

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import jsQR from 'jsqr'
import { useWalletConnect } from '@/hooks/useWalletConnect'
import { walletSession } from '@/lib/walletStorage'

type ConnectDAppModalProps = {
  isOpen: boolean
  onClose: () => void
  onConnected?: (dappName: string) => void
}

type Tab = 'scan' | 'paste'

export function ConnectDAppModal({ isOpen, onClose, onConnected }: ConnectDAppModalProps) {
  const { pendingProposal, pair, approveSession, rejectSession } = useWalletConnect()

  const [tab, setTab] = useState<Tab>('scan')
  const [uriInput, setUriInput] = useState('')
  const [isPairing, setIsPairing] = useState(false)
  const [isApproving, setIsApproving] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const videoRef = useRef<HTMLVideoElement | null>(null)
  const canvasRef = useRef<HTMLCanvasElement | null>(null)
  const streamRef = useRef<MediaStream | null>(null)
  const frameRef = useRef<number | null>(null)

  const dappName = pendingProposal?.proposer?.metadata?.name || 'dApp'
  const dappDescription = pendingProposal?.proposer?.metadata?.description || ''
  const dappIcon = pendingProposal?.proposer?.metadata?.icons?.[0] || ''

  const walletAddress = useMemo(
    () => (typeof window !== 'undefined' ? walletSession.getItem('invisible_wallet_address') : null),
    [isOpen],
  )

  const stopScanner = useCallback(() => {
    if (frameRef.current != null) {
      cancelAnimationFrame(frameRef.current)
      frameRef.current = null
    }
    if (streamRef.current) {
      for (const track of streamRef.current.getTracks()) track.stop()
      streamRef.current = null
    }
  }, [])

  const handlePair = useCallback(async (uri: string) => {
    const normalized = uri.trim()
    if (!normalized.startsWith('wc:')) {
      throw new Error('Invalid WalletConnect URI. It must start with "wc:".')
    }
    setIsPairing(true)
    setError(null)
    try {
      await pair(normalized)
    } finally {
      setIsPairing(false)
    }
  }, [pair])

  const startScanner = useCallback(async () => {
    if (!isOpen || tab !== 'scan' || pendingProposal) return
    if (!navigator.mediaDevices?.getUserMedia) {
      setError('Camera is not supported in this browser.')
      return
    }

    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: 'environment' },
      })
      streamRef.current = stream
      const video = videoRef.current
      const canvas = canvasRef.current
      if (!video || !canvas) return
      video.srcObject = stream
      await video.play()

      const ctx = canvas.getContext('2d', { willReadFrequently: true })
      if (!ctx) throw new Error('Unable to start camera scanner.')

      const tick = async () => {
        if (!videoRef.current || !canvasRef.current) return
        const w = videoRef.current.videoWidth
        const h = videoRef.current.videoHeight
        if (w > 0 && h > 0) {
          canvas.width = w
          canvas.height = h
          ctx.drawImage(videoRef.current, 0, 0, w, h)
          const imageData = ctx.getImageData(0, 0, w, h)
          const code = jsQR(imageData.data, w, h)
          if (code?.data && code.data.trim().startsWith('wc:')) {
            stopScanner()
            try {
              await handlePair(code.data)
            } catch (scanError: unknown) {
              setError(scanError instanceof Error ? scanError.message : 'Failed to pair from QR code.')
            }
            return
          }
        }
        frameRef.current = requestAnimationFrame(() => {
          void tick()
        })
      }

      frameRef.current = requestAnimationFrame(() => {
        void tick()
      })
    } catch (cameraError: unknown) {
      const message = cameraError instanceof Error ? cameraError.message : String(cameraError)
      setError(
        message.includes('NotAllowed') || message.includes('Permission')
          ? 'Camera permission denied. Allow camera access and try again.'
          : message,
      )
    }
  }, [handlePair, isOpen, pendingProposal, stopScanner, tab])

  useEffect(() => {
    if (!isOpen) return
    setError(null)
    setUriInput('')
    setTab('scan')
  }, [isOpen])

  useEffect(() => {
    if (!isOpen || tab !== 'scan' || pendingProposal) {
      stopScanner()
      return
    }
    void startScanner()
    return stopScanner
  }, [isOpen, pendingProposal, startScanner, stopScanner, tab])

  const handleApprove = useCallback(async () => {
    if (!pendingProposal) return
    if (!walletAddress) {
      setError('Wallet not unlocked. Open your wallet first.')
      return
    }
    setIsApproving(true)
    setError(null)
    try {
      await approveSession(pendingProposal, walletAddress)
      onConnected?.(dappName)
      onClose()
    } catch (approveError: unknown) {
      setError(approveError instanceof Error ? approveError.message : 'Failed to approve session.')
    } finally {
      setIsApproving(false)
    }
  }, [approveSession, dappName, onClose, onConnected, pendingProposal, walletAddress])

  const handleReject = useCallback(async () => {
    if (!pendingProposal) return
    try {
      await rejectSession(pendingProposal)
    } catch (rejectError: unknown) {
      setError(rejectError instanceof Error ? rejectError.message : 'Failed to reject session.')
    }
  }, [pendingProposal, rejectSession])

  if (!isOpen) return null

  return (
    <div
      style={{
        position: 'fixed',
        inset: 0,
        zIndex: 60,
        background: 'rgba(0,0,0,0.72)',
        display: 'flex',
        alignItems: 'flex-end',
      }}
      onClick={() => {
        stopScanner()
        onClose()
      }}
    >
      <div
        className="card"
        role="dialog"
        aria-modal="true"
        aria-label="Connect dApp"
        style={{
          width: '100%',
          borderBottomLeftRadius: 0,
          borderBottomRightRadius: 0,
          maxHeight: '85dvh',
          overflowY: 'auto',
          background: '#141414',
        }}
        onClick={(event) => event.stopPropagation()}
      >
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '1rem' }}>
          <h3 style={{ fontFamily: 'Lora, Georgia, serif', fontWeight: 600, fontStyle: 'italic', fontSize: '1.25rem' }}>
            Connect dApp
          </h3>
          <button
            onClick={() => {
              stopScanner()
              onClose()
            }}
            style={{ border: 'none', background: 'none', color: 'var(--off-white)', fontSize: '1.5rem', cursor: 'pointer' }}
            aria-label="Close"
          >
            ×
          </button>
        </div>

        {!pendingProposal && (
          <>
            <div style={{ display: 'flex', gap: '0.5rem', marginBottom: '1rem' }}>
              <button
                onClick={() => setTab('scan')}
                style={{
                  borderRadius: '999px',
                  border: '1px solid',
                  borderColor: tab === 'scan' ? 'var(--gold)' : 'var(--border-dim)',
                  background: tab === 'scan' ? 'rgba(253,218,36,0.12)' : 'transparent',
                  color: tab === 'scan' ? 'var(--gold)' : 'var(--off-white)',
                  padding: '0.4rem 0.9rem',
                  cursor: 'pointer',
                }}
              >
                Scan QR
              </button>
              <button
                onClick={() => setTab('paste')}
                style={{
                  borderRadius: '999px',
                  border: '1px solid',
                  borderColor: tab === 'paste' ? 'var(--gold)' : 'var(--border-dim)',
                  background: tab === 'paste' ? 'rgba(253,218,36,0.12)' : 'transparent',
                  color: tab === 'paste' ? 'var(--gold)' : 'var(--off-white)',
                  padding: '0.4rem 0.9rem',
                  cursor: 'pointer',
                }}
              >
                Paste URI
              </button>
            </div>

            {tab === 'scan' && (
              <div>
                <div style={{ borderRadius: '12px', overflow: 'hidden', background: '#000', aspectRatio: '1' }}>
                  <video ref={videoRef} muted playsInline style={{ width: '100%', height: '100%', objectFit: 'cover' }} />
                  <canvas ref={canvasRef} style={{ display: 'none' }} />
                </div>
                <p style={{ marginTop: '0.75rem', fontSize: '0.8125rem', color: 'rgba(246,247,248,0.5)' }}>
                  Point the camera at a WalletConnect QR code.
                </p>
              </div>
            )}

            {tab === 'paste' && (
              <form
                onSubmit={async (event) => {
                  event.preventDefault()
                  try {
                    await handlePair(uriInput)
                  } catch (pairError: unknown) {
                    setError(pairError instanceof Error ? pairError.message : 'Failed to pair URI.')
                  }
                }}
              >
                <label
                  htmlFor="wc-uri"
                  style={{
                    display: 'block',
                    fontSize: '0.75rem',
                    color: 'rgba(246,247,248,0.5)',
                    marginBottom: '0.5rem',
                  }}
                >
                  WalletConnect URI
                </label>
                <input
                  id="wc-uri"
                  className="input-field mono"
                  placeholder="wc:..."
                  value={uriInput}
                  onChange={(event) => setUriInput(event.target.value)}
                />
                <button
                  type="submit"
                  className="btn-gold"
                  style={{ marginTop: '0.875rem' }}
                  disabled={isPairing}
                >
                  {isPairing ? 'Connecting...' : 'Connect'}
                </button>
              </form>
            )}

            <p style={{ marginTop: '1rem', fontSize: '0.8125rem', color: 'rgba(246,247,248,0.5)' }}>
              {isPairing ? 'Waiting for dApp session proposal...' : 'Paste or scan a WalletConnect URI to start.'}
            </p>
          </>
        )}

        {pendingProposal && (
          <div>
            <p style={{ fontSize: '0.8125rem', color: 'rgba(246,247,248,0.45)', marginBottom: '0.75rem' }}>
              Session proposal received
            </p>
            <div className="card-md" style={{ marginBottom: '1rem' }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: '0.75rem' }}>
                {dappIcon ? (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img src={dappIcon} alt={dappName} width={40} height={40} style={{ borderRadius: '999px' }} />
                ) : (
                  <div style={{
                    width: 40,
                    height: 40,
                    borderRadius: '999px',
                    border: '1px solid var(--border-dim)',
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    color: 'var(--gold)',
                    fontWeight: 700,
                  }}>
                    {dappName.slice(0, 1).toUpperCase()}
                  </div>
                )}
                <div>
                  <p style={{ fontSize: '0.95rem', fontWeight: 600 }}>{dappName}</p>
                  <p style={{ fontSize: '0.8rem', color: 'rgba(246,247,248,0.5)' }}>
                    {dappDescription || 'No description provided.'}
                  </p>
                </div>
              </div>
            </div>

            <div style={{ display: 'grid', gap: '0.625rem' }}>
              <button className="btn-gold" onClick={handleApprove} disabled={isApproving}>
                {isApproving ? 'Approving...' : 'Approve'}
              </button>
              <button className="btn-ghost" onClick={handleReject}>
                Reject
              </button>
            </div>
          </div>
        )}

        {error && (
          <p style={{ marginTop: '0.875rem', color: 'var(--teal)', fontSize: '0.8125rem' }}>
            {error}
          </p>
        )}
      </div>
    </div>
  )
}
