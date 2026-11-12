'use client'

import { useState, useEffect } from 'react'
import { X, Share, SquarePlus } from 'lucide-react'

interface BeforeInstallPromptEvent extends Event {
  readonly platforms: string[]
  readonly userChoice: Promise<{
    outcome: 'accepted' | 'dismissed'
    platform: string
  }>
  prompt(): Promise<void>
}

export function InstallBanner() {
  const [show, setShow] = useState(false)
  const [deferredPrompt, setDeferredPrompt] = useState<BeforeInstallPromptEvent | null>(null)
  const [platform, setPlatform] = useState<'ios' | 'android' | null>(null)

  useEffect(() => {
    // 1. Check if dismissed this session (immediate) or within 7 days (localStorage)
    if (sessionStorage.getItem('veil_install_dismissed')) return
    const dismissedAt = localStorage.getItem('veil_install_dismissed')
    if (dismissedAt && Date.now() - parseInt(dismissedAt) < 7 * 24 * 60 * 60 * 1000) return

    // 2. Detect if already installed (standalone mode)
    const isStandalone = window.matchMedia('(display-mode: standalone)').matches || ('standalone' in window.navigator && (window.navigator as any).standalone)
    if (isStandalone) return

    // 3. Detect platform
    const userAgent = window.navigator.userAgent.toLowerCase()
    const isIos = /iphone|ipad|ipod/.test(userAgent)

    if (isIos) {
      setPlatform('ios')
      setShow(true)
    }

    const handleBeforeInstallPrompt = (e: Event) => {
      e.preventDefault()
      setDeferredPrompt(e as BeforeInstallPromptEvent)
      setPlatform('android')
      setShow(true)
    }

    window.addEventListener('beforeinstallprompt' as any, handleBeforeInstallPrompt)
    return () => window.removeEventListener('beforeinstallprompt' as any, handleBeforeInstallPrompt)
  }, [])

  const handleDismiss = () => {
    sessionStorage.setItem('veil_install_dismissed', '1')
    localStorage.setItem('veil_install_dismissed', Date.now().toString())
    setShow(false)
  }

  const handleInstall = async () => {
    if (!deferredPrompt) return
    deferredPrompt.prompt()
    const { outcome } = await deferredPrompt.userChoice
    if (outcome === 'accepted') {
      setShow(false)
    }
    setDeferredPrompt(null)
  }

  if (!show) return null

  return (
    <div className="card-md" style={{ 
      position: 'fixed', 
      bottom: '1rem', 
      left: '1rem', 
      right: '1rem', 
      zIndex: 100,
      display: 'flex',
      flexDirection: 'column',
      gap: '1rem',
      padding: '1.25rem',
      border: '1px solid var(--gold)',
      boxShadow: '0 8px 32px rgba(0,0,0,0.5)'
    }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start' }}>
        <div>
          <span style={{ 
            fontFamily: 'Anton, Impact, sans-serif', 
            fontSize: '0.75rem', 
            letterSpacing: '0.08em', 
            color: 'var(--gold)',
            display: 'block',
            marginBottom: '0.25rem'
          }}>
            MOBILE APP
          </span>
          <h3 style={{ 
            fontFamily: 'Lora, Georgia, serif', 
            fontWeight: 600, 
            fontStyle: 'italic', 
            color: 'var(--off-white)',
            fontSize: '1.125rem'
          }}>
            Install Veil Wallet
          </h3>
        </div>
        <button 
          onClick={handleDismiss} 
          style={{ background: 'none', border: 'none', color: 'var(--warm-grey)', cursor: 'pointer', padding: '4px' }}
        >
          <X size={20} strokeWidth={1.5} />
        </button>
      </div>

      {platform === 'android' ? (
        <>
          <p style={{ fontSize: '0.875rem', color: 'var(--warm-grey)', lineHeight: '1.5' }}>
            Add Veil to your home screen for a faster, native experience.
          </p>
          <button className="btn-gold" onClick={handleInstall}>
            Install App
          </button>
        </>
      ) : (
        <div style={{ fontSize: '0.875rem', color: 'var(--warm-grey)', display: 'flex', flexDirection: 'column', gap: '0.625rem' }}>
          <p>To install on your iPhone:</p>
          <ol style={{ paddingLeft: '1.25rem', margin: 0, display: 'flex', flexDirection: 'column', gap: '0.4rem' }}>
            <li>
              Tap the <Share size={16} strokeWidth={1.5} style={{ display: 'inline', verticalAlign: 'text-bottom' }} /> Share icon in Safari.
            </li>
            <li>
              Scroll down and tap <span style={{ color: 'var(--off-white)' }}>'Add to Home Screen'</span> <SquarePlus size={16} strokeWidth={1.5} style={{ display: 'inline', verticalAlign: 'text-bottom' }} />.
            </li>
          </ol>
        </div>
      )}
    </div>
  )
}