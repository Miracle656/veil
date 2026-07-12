'use client'

import { motion } from 'framer-motion'
import Link from 'next/link'
import { ArrowLeft, Fingerprint, Shield, Zap, Key, Bot, RefreshCw } from 'lucide-react'

const fadeUp = {
  hidden: { opacity: 0, y: 28 },
  show: { opacity: 1, y: 0, transition: { duration: 0.65, ease: [0.22, 1, 0.36, 1] as [number, number, number, number] } },
}
const stagger = { hidden: {}, show: { transition: { staggerChildren: 0.1 } } }
const vp = { once: true, margin: '-60px' as const }

function H({ children }: { children: React.ReactNode }) {
  return <span className="hl">{children}</span>
}

const FEATURES = [
  {
    Icon: Fingerprint,
    title: 'Biometric Auth',
    body: 'Face ID, fingerprint, or Windows Hello — your biometric signs every transaction. No password prompt. No typed phrase. The private key never leaves the secure enclave on your device.',
  },
  {
    Icon: Shield,
    title: 'On-Chain P-256 Verification',
    body: 'Every signature is verified by a Soroban custom account contract. P-256 ECDSA, SHA-256 client data hash, and challenge binding all happen on-chain. Zero trusted intermediaries.',
  },
  {
    Icon: Key,
    title: 'No Seed Phrases',
    body: 'There is nothing to write down and nothing to steal. Your account is backed by your device passkey, with optional guardian recovery for multi-device setups.',
  },
  {
    Icon: Bot,
    title: 'AI Agent Built-In',
    body: 'Ask the Veil Agent to check prices, run a swap, or query your transfer history — all in plain English. Every action requires your explicit approval before execution.',
  },
  {
    Icon: Zap,
    title: 'Stellar Native Speed',
    body: 'Transactions settle in 3–5 seconds with sub-cent fees on Stellar. The biometric step adds zero latency to the on-chain flow.',
  },
  {
    Icon: RefreshCw,
    title: 'Cross-Device Recovery',
    body: 'Add multiple passkeys across devices. Guardian recovery lets you reclaim access even if a device is lost — without a centralized backup.',
  },
]

const HOW_IT_WORKS = [
  {
    num: '01',
    title: 'Register',
    body: 'Your browser creates a P-256 key pair. The public key is stored on-chain in the Soroban contract. The private key stays in your device secure enclave — it never moves.',
  },
  {
    num: '02',
    title: 'Approve',
    body: 'When you initiate any transaction, a biometric prompt appears. Face ID, fingerprint, or Windows Hello signs the Soroban auth payload. No password. No phrase.',
  },
  {
    num: '03',
    title: 'Verified',
    body: 'The Soroban contract verifies the P-256 ECDSA signature on-chain. If it matches the registered public key, the transaction executes. Trustless. Invisible. Done.',
  },
]

export default function WalletProductPage() {
  return (
    <>
      {/* Navbar */}
      <nav className="fixed top-0 left-0 right-0 z-50 bg-near-black/80 backdrop-blur-md border-b border-white/[0.06]">
        <div className="max-w-6xl mx-auto px-6 py-4 flex items-center justify-between">
          <Link href="/" className="font-lora font-semibold italic text-gold text-xl tracking-tight select-none">
            Veil
          </Link>
          <Link href="/products" className="inline-flex items-center gap-2 font-inter text-sm text-warm-grey hover:text-off-white transition-colors">
            <ArrowLeft size={15} />
            All Products
          </Link>
          <a href="https://veil-ezry.vercel.app" target="_blank" rel="noopener noreferrer"
            className="btn-gold !py-2 !px-5 !text-sm hidden md:inline-flex">
            Try the Wallet
          </a>
        </div>
      </nav>

      <main className="bg-near-black min-h-screen">

        {/* Hero */}
        <section className="relative pt-40 pb-24 px-6 overflow-hidden">
          <div className="hero-orb-gold" style={{ opacity: 0.5 }} />
          <div className="max-w-4xl mx-auto relative z-10">
            <motion.div
              initial="hidden"
              animate="show"
              variants={stagger}
            >
              <motion.p variants={fadeUp} className="font-anton uppercase text-gold text-[11px] tracking-[0.32em] mb-5">
                Consumer · Smart Wallet
              </motion.p>
              <motion.h1 variants={fadeUp}
                className="font-lora font-semibold italic text-off-white text-4xl md:text-5xl lg:text-[64px] leading-[1.08] tracking-tight mb-6"
              >
                The smart wallet{' '}
                <H>you never see</H>,<br />
                but always trust.
              </motion.h1>
              <motion.p variants={fadeUp}
                className="font-inter text-warm-grey text-lg md:text-xl max-w-2xl leading-relaxed mb-10"
              >
                Veil Wallet is a seedless passkey smart account on Stellar Soroban.
                Your fingerprint — or face — replaces every private key, seed phrase,
                and password that cryptocurrency has ever demanded from you.
              </motion.p>
              <motion.div variants={fadeUp} className="flex flex-wrap gap-3">
                <a href="https://veil-ezry.vercel.app" target="_blank" rel="noopener noreferrer"
                  className="btn-gold">
                  Try the Wallet
                </a>
                <a href="https://veil-2ap8.vercel.app" className="btn-ghost">
                  Read the Docs
                </a>
              </motion.div>
            </motion.div>
          </div>
        </section>

        {/* How it works */}
        <section className="bg-off-white section-pad">
          <div className="max-w-6xl mx-auto">
            <motion.div initial="hidden" whileInView="show" viewport={vp} variants={stagger}
              className="text-center mb-16">
              <motion.p variants={fadeUp}
                className="font-anton uppercase text-near-black text-[11px] tracking-[0.3em] mb-5">
                The Invisible Handshake
              </motion.p>
              <motion.h2 variants={fadeUp}
                className="font-lora font-semibold italic text-near-black text-4xl md:text-5xl leading-tight">
                Three steps.{' '}
                <span className="hl-dark">Zero phrases.</span>
              </motion.h2>
            </motion.div>
            <motion.div initial="hidden" whileInView="show" viewport={vp} variants={stagger}
              className="grid md:grid-cols-3 gap-5">
              {HOW_IT_WORKS.map((step) => (
                <motion.div key={step.num} variants={fadeUp} className="card-light p-8">
                  <div className="w-10 h-10 rounded-full bg-gold flex items-center justify-center mb-6">
                    <span className="font-anton text-near-black text-[13px]">{step.num}</span>
                  </div>
                  <h3 className="font-lora font-semibold text-near-black text-xl mb-3">{step.title}</h3>
                  <p className="font-inter text-near-black/60 text-sm leading-relaxed">{step.body}</p>
                </motion.div>
              ))}
            </motion.div>
          </div>
        </section>

        {/* Features */}
        <section className="bg-near-black section-pad">
          <div className="max-w-6xl mx-auto">
            <motion.div initial="hidden" whileInView="show" viewport={vp} variants={stagger}
              className="text-center mb-16">
              <motion.p variants={fadeUp}
                className="font-anton uppercase text-gold text-[11px] tracking-[0.3em] mb-5">
                Everything included
              </motion.p>
              <motion.h2 variants={fadeUp}
                className="font-lora font-semibold italic text-off-white text-4xl md:text-5xl leading-tight">
                Invisible to attackers.<br />
                <H>Obvious to you.</H>
              </motion.h2>
            </motion.div>
            <motion.div initial="hidden" whileInView="show" viewport={vp} variants={stagger}
              className="grid sm:grid-cols-2 lg:grid-cols-3 gap-4">
              {FEATURES.map(({ Icon, title, body }) => (
                <motion.div key={title} variants={fadeUp} className="card-dark p-7">
                  <Icon size={22} strokeWidth={1.5} className="text-teal mb-5" />
                  <h3 className="font-lora font-semibold text-off-white text-lg mb-2">{title}</h3>
                  <p className="font-inter text-warm-grey/75 text-sm leading-relaxed">{body}</p>
                </motion.div>
              ))}
            </motion.div>
          </div>
        </section>

        {/* CTA */}
        <section className="section-pad" style={{ background: '#FDDA24' }}>
          <div className="max-w-3xl mx-auto text-center">
            <motion.div initial="hidden" whileInView="show" viewport={vp} variants={stagger}>
              <motion.h2 variants={fadeUp}
                className="font-lora font-semibold italic text-near-black text-4xl md:text-5xl leading-tight mb-4">
                Sign with a glance.<br />
                Own it forever.
              </motion.h2>
              <motion.p variants={fadeUp}
                className="font-inter text-near-black/65 text-base mb-10 max-w-xl mx-auto leading-relaxed">
                Veil is live on Stellar testnet. Try it now — no install, no extension, no seed phrase.
              </motion.p>
              <motion.div variants={fadeUp} className="flex flex-col sm:flex-row gap-3 justify-center">
                <a href="https://veil-ezry.vercel.app" target="_blank" rel="noopener noreferrer"
                  className="btn-navy">
                  Launch Wallet
                </a>
                <Link href="/products" className="btn-ghost !border-near-black/25 !text-near-black">
                  See All Products
                </Link>
              </motion.div>
            </motion.div>
          </div>
        </section>

        {/* Footer */}
        <footer className="border-t border-white/[0.06] px-6 py-10">
          <div className="max-w-6xl mx-auto flex flex-col md:flex-row items-center justify-between gap-6">
            <Link href="/" className="font-lora font-semibold italic text-gold text-xl tracking-tight select-none">Veil</Link>
            <nav className="flex flex-wrap justify-center gap-6">
              {[
                { label: 'Home', href: '/' },
                { label: 'Products', href: '/products' },
                { label: 'Docs', href: 'https://veil-2ap8.vercel.app' },
                { label: 'GitHub', href: 'https://github.com/Miracle656/veil' },
              ].map(({ label, href }) => (
                <a key={label} href={href}
                  target={href.startsWith('http') ? '_blank' : undefined}
                  rel={href.startsWith('http') ? 'noopener noreferrer' : undefined}
                  className="font-inter text-sm text-warm-grey hover:text-off-white transition-colors">
                  {label}
                </a>
              ))}
            </nav>
            <p className="font-inter text-xs text-warm-grey/40">Powered by Stellar Soroban · WebAuthn / FIDO2</p>
          </div>
        </footer>
      </main>
    </>
  )
}
