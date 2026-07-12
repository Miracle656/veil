'use client'

import { useState } from 'react'
import { motion, AnimatePresence } from 'framer-motion'

interface OnboardingTutorialProps {
  onComplete: () => void
}

export function OnboardingTutorial({ onComplete }: OnboardingTutorialProps) {
  const [step, setStep] = useState(0)

  const steps = [
    {
      title: 'No seed phrase',
      description: "Veil uses your device's biometrics as your key. No seed phrase, no private key file — just your fingerprint or Face ID.",
      icon: (
        <svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="var(--gold)" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
          <path d="M12 10a2 2 0 0 0-2 2c0 .34.07.66.21.96l.89 1.79c.1.2.3.35.54.4a3 3 0 0 1 2.36 2.85V20a2 2 0 0 1-2 2h-4a2 2 0 0 1-2-2v-4.5a7 7 0 0 1 7-7 7 7 0 0 1 7 7V20a2 2 0 0 1-2 2h-4" />
          <path d="M12 2v2" />
          <path d="m4.9 4.9 1.4 1.4" />
          <path d="m19.1 4.9-1.4 1.4" />
          <path d="M2 12h2" />
          <path d="M20 12h2" />
        </svg>
      )
    },
    {
      title: 'Your passkey, your wallet',
      description: "When you create a wallet, your device registers a passkey. The cryptographic public key is stored on-chain. Only your device can sign.",
      icon: (
        <svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="var(--gold)" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
          <rect width="18" height="11" x="3" y="11" rx="2" ry="2" />
          <path d="M7 11V7a5 5 0 0 1 10 0v4" />
        </svg>
      )
    },
    {
      title: 'Ready to start',
      description: "Tap Create wallet to register your passkey and deploy your wallet on Stellar. It takes about 10 seconds.",
      icon: (
        <svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="var(--gold)" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
          <path d="M4.5 16.5c-1.5 1.26-2 5-2 5s3.74-.5 5-2c.71-.84.7-2.13-.09-2.91a2.18 2.18 0 0 0-2.91-.09z" />
          <path d="m12 15-3-3a22 22 0 0 1 2-3.95A12.88 12.88 0 0 1 22 2c0 2.72-.78 7.5-6 11a22.35 22.35 0 0 1-4 2z" />
          <path d="M9 12H4s.55-3.03 2-5c1.62-2.2 5-3 5-3" />
          <path d="M12 15v5s3.03-.55 5-2c2.2-1.62 3-5 3-5" />
        </svg>
      )
    }
  ]

  const handleNext = () => {
    if (step < steps.length - 1) {
      setStep(step + 1)
    } else {
      onComplete()
    }
  }

  return (
    <div 
    role="dialog"
    aria-modal="true"
    aria-labelledby="tutorial-title"
    aria-describedby="tutorial-description"
    style={{ 
      position: 'fixed', 
      inset: 0, 
      zIndex: 100, 
      backgroundColor: 'var(--near-black)', 
      display: 'flex', 
      flexDirection: 'column', 
      alignItems: 'center', 
      justifyContent: 'center', 
      padding: '2rem' 
    }}>
      <AnimatePresence mode="wait">
        <motion.div
          key={step}
          initial={{ opacity: 0, y: 20 }}
          animate={{ opacity: 1, y: 0 }}
          exit={{ opacity: 0, y: -20 }}
          transition={{ duration: 0.4, ease: [0.22, 1, 0.36, 1] }}
          style={{ maxWidth: 400, width: '100%', textAlign: 'center', display: 'flex', flexDirection: 'column', alignItems: 'center', gap: '1.5rem' }}
        >
          <div style={{ marginBottom: '1rem' }}>
            {steps[step].icon}
          </div>
          
          <h2 
          id='tutorial-title'
          style={{ fontFamily: 'Lora, Georgia, serif', fontStyle: 'italic', fontWeight: 600, fontSize: '1.75rem',  color: '#d4d4d4', }}>
            {steps[step].title}
          </h2>

          <p 
          id='tutorial-description'
          style={{ fontFamily: 'Inter, sans-serif', fontSize: '1rem', lineHeight: 1.6, color: 'rgba(246,247,248,0.6)' }}>
            {steps[step].description}
          </p>

          <div style={{ display: 'flex', gap: '0.75rem', marginTop: '1rem' }}>
            {steps.map((_, i) => (
              <div
                key={i}
                style={{
                  width: 8,
                  height: 8,
                  borderRadius: '50%',
                  backgroundColor: i === step ? 'var(--gold)' : 'rgba(246,247,248,0.2)',
                  transition: 'background-color 0.3s ease'
                }}
              />
            ))}
          </div>

          <div style={{ width: '100%', marginTop: '2rem', display: 'flex', flexDirection: 'column', gap: '0.75rem' }}>
            <button 
            className="btn-gold"
            style={{ backgroundColor: '#c9a227', color: '#111111' }} 
            onClick={handleNext}>
              {step === steps.length - 1 ? 'Get started' : 'Next'}
            </button>
            {step < steps.length - 1 && (
              <button 
              className="btn-ghost" 
              style={{ fontSize: '0.875rem',color: '#a0a0a0'}} 
              onClick={onComplete}>
                Skip
              </button>
            )}
          </div>
        </motion.div>
      </AnimatePresence>
    </div>
  )
}
