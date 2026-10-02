'use client'

import { useEffect, useRef } from 'react'
import dynamic from 'next/dynamic'
import { motion } from 'framer-motion'
import { gsap } from 'gsap'
import { ArrowRightIcon, GithubIcon } from './Icons'

const WebGLScene = dynamic(() => import('./WebGLScene'), { ssr: false })

const TITLE_WORDS = ['Your', 'Biometric', 'IS', 'Your', 'Key']

export default function Hero() {
  const titleRef    = useRef<HTMLHeadingElement>(null)
  const subtitleRef = useRef<HTMLParagraphElement>(null)

  useEffect(() => {
    if (!titleRef.current || !subtitleRef.current) return

    const ctx = gsap.context(() => {
      const chars = titleRef.current!.querySelectorAll('.char')

      gsap.fromTo(
        chars,
        { opacity: 0, y: 40, rotateX: -80, transformOrigin: '50% 100%' },
        {
          opacity: 1, y: 0, rotateX: 0,
          duration: 0.7, stagger: 0.04,
          ease: 'back.out(1.3)', delay: 0.5,
        }
      )

      gsap.fromTo(
        subtitleRef.current,
        { opacity: 0, y: 20 },
        { opacity: 1, y: 0, duration: 0.9, delay: 1.35, ease: 'power3.out' }
      )
    })

    return () => ctx.revert()
  }, [])

  return (
    <section className="relative min-h-screen flex items-center justify-center overflow-hidden">
      {/* WebGL */}
      <div className="absolute inset-0">
        <WebGLScene />
      </div>

      {/* Vignette overlays */}
      <div className="absolute inset-0 bg-gradient-to-b from-black/50 via-transparent to-black pointer-events-none" />
      <div
        className="absolute inset-0 pointer-events-none"
        style={{ background: 'radial-gradient(ellipse 70% 55% at 50% 50%, rgba(5,162,194,0.06) 0%, transparent 70%)' }}
      />

      {/* Content */}
      <div className="relative z-10 text-center px-4 max-w-5xl mx-auto pt-24">

        {/* Badge */}
        <motion.div
          initial={{ opacity: 0, y: -12 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.5, delay: 0.1 }}
          className="inline-flex items-center gap-2 px-3.5 py-1.5 rounded-pill mb-10 border border-white/10 bg-white/[0.04] text-xs text-[#8f8f8f] font-medium tracking-wide"
        >
          <span className="w-1.5 h-1.5 rounded-full bg-teal animate-pulse" style={{ backgroundColor: '#05A2C2' }} />
          Built on Stellar Soroban · Secured by WebAuthn
        </motion.div>

        {/* Animated title */}
        <h1
          ref={titleRef}
          className="text-5xl sm:text-6xl md:text-7xl lg:text-[82px] font-bold leading-[1.06] tracking-tight mb-6"
          style={{ perspective: '600px' }}
        >
          {TITLE_WORDS.map((word, wi) => (
            <span key={wi} className="inline-block mr-[0.22em] last:mr-0">
              {word.split('').map((char, ci) => (
                <span
                  key={ci}
                  className={`char inline-block ${word === 'IS' ? 'text-teal' : 'text-white'}`}
                  style={{ opacity: 0, color: word === 'IS' ? '#05A2C2' : undefined }}
                >
                  {char}
                </span>
              ))}
            </span>
          ))}
        </h1>

        {/* Subtitle */}
        <p
          ref={subtitleRef}
          style={{ opacity: 0 }}
          className="text-lg sm:text-xl text-[#8f8f8f] max-w-2xl mx-auto mb-10 leading-relaxed font-normal"
        >
          A seedless, passkey-powered smart wallet on Stellar. No seed phrases.
          No private keys. Just your fingerprint.
        </p>

        {/* CTAs */}
        <motion.div
          initial={{ opacity: 0, y: 16 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.7, delay: 1.75 }}
          className="flex flex-col sm:flex-row gap-3 justify-center items-center"
        >
          <a href="https://docs.useveilapp.xyz">
            <motion.button
              whileHover={{ scale: 1.03, boxShadow: '0 0 28px rgba(5,162,194,0.22)' }}
              whileTap={{ scale: 0.97 }}
              className="btn-primary flex items-center gap-2"
            >
              Explore Docs
              <ArrowRightIcon size={15} />
            </motion.button>
          </a>
          <a
            href="https://github.com/Miracle656/veil"
            target="_blank"
            rel="noopener noreferrer"
          >
            <motion.button
              whileHover={{ scale: 1.03 }}
              whileTap={{ scale: 0.97 }}
              className="btn-secondary flex items-center gap-2"
            >
              <GithubIcon size={16} />
              View on GitHub
            </motion.button>
          </a>
        </motion.div>

        {/* Stats */}
        <motion.div
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          transition={{ delay: 2.3, duration: 0.8 }}
          className="flex flex-wrap justify-center gap-10 mt-16"
        >
          {[
            { value: '6',     label: 'Passing Tests' },
            { value: 'P-256', label: 'ECDSA Curve' },
            { value: '0',     label: 'Seed Phrases' },
            { value: '100%',  label: 'On-Chain Verified' },
          ].map(({ value, label }) => (
            <div key={label} className="text-center">
              <div className="text-2xl font-bold text-white mb-1">{value}</div>
              <div className="text-[11px] text-[#555] uppercase tracking-widest">{label}</div>
            </div>
          ))}
        </motion.div>
      </div>

      {/* Scroll cue */}
      <motion.div
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        transition={{ delay: 2.7, duration: 0.8 }}
        className="absolute bottom-8 left-1/2 -translate-x-1/2 flex flex-col items-center gap-1.5"
      >
        <motion.div
          animate={{ y: [0, 8, 0] }}
          transition={{ repeat: Infinity, duration: 1.8, ease: 'easeInOut' }}
        >
          <span className="text-[10px] text-[#555] uppercase tracking-[0.2em] block text-center mb-1">
            Scroll
          </span>
          <div className="w-px h-8 mx-auto" style={{ background: 'linear-gradient(to bottom, #05A2C2, transparent)' }} />
        </motion.div>
      </motion.div>
    </section>
  )
}
