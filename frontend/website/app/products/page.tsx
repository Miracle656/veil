'use client'

import { useState } from 'react'
import { motion } from 'framer-motion'
import Link from 'next/link'
import { ArrowRight, Wallet, Eye, Activity, Bot, Menu, X } from 'lucide-react'

const fadeUp = {
  hidden: { opacity: 0, y: 28 },
  show: { opacity: 1, y: 0, transition: { duration: 0.65, ease: [0.22, 1, 0.36, 1] as [number, number, number, number] } },
}
const stagger = { hidden: {}, show: { transition: { staggerChildren: 0.12 } } }
const vp = { once: true, margin: '-60px' as const }

const PRODUCTS = [
  {
    slug: 'wallet',
    Icon: Wallet,
    accent: '#FDDA24',
    tag: 'Consumer',
    name: 'Veil Wallet',
    tagline: 'The smart wallet you never see, but always trust.',
    desc: 'A seedless, biometric-native smart wallet on Stellar Soroban. No seed phrases, no private keys — just your fingerprint or face.',
    highlights: ['WebAuthn / FIDO2 passkeys', 'On-chain P-256 verification', 'AI-powered assistant', 'Instant Stellar finality'],
    cta: 'Try the Wallet',
    ctaHref: 'https://app.useveilapp.xyz',
    external: true,
  },
  {
    slug: 'lens',
    Icon: Eye,
    accent: '#00A7B5',
    tag: 'Infrastructure',
    name: 'Lens',
    tagline: 'Real-time price intelligence for Stellar.',
    desc: 'A unified price oracle that ingests SDEX trades and AMM pool snapshots, computing VWAP, OHLCV, and best-route recommendations — gated behind x402 micropayments.',
    highlights: ['SDEX + AMM aggregation', 'VWAP & OHLCV data', 'Best route routing', 'x402 pay-per-call'],
    cta: 'Explore Lens',
    ctaHref: '/products/lens',
    external: false,
  },
  {
    slug: 'wraith',
    Icon: Activity,
    accent: '#B7ACE8',
    tag: 'Infrastructure',
    name: 'Wraith',
    tagline: 'The Stellar event indexer Horizon never had.',
    desc: 'An indexer for Stellar Asset Contract events, filling the gap Horizon leaves for Soroban token transfers. Query incoming, outgoing, or both — with filters, summaries, and pagination.',
    highlights: ['SAC event indexing', 'Incoming & outgoing transfers', 'Date range filters', 'Transfer summaries'],
    cta: 'Explore Wraith',
    ctaHref: '/products/wraith',
    external: false,
  },
  {
    slug: 'agent',
    Icon: Bot,
    accent: '#FDDA24',
    tag: 'AI',
    name: 'Veil Agent',
    tagline: 'Your wallet, now with a brain.',
    desc: 'A Claude-powered AI agent embedded in the Veil wallet. Ask about prices, check transfer history, or execute swaps — all in plain language, all requiring your approval.',
    highlights: ['Natural language interface', 'Price & swap execution', 'Transfer history queries', 'Human-in-the-loop approvals'],
    cta: 'Explore Agent',
    ctaHref: '/products/agent',
    external: false,
  },
]

const PRODUCT_NAV = [
  { label: 'How It Works', href: '/#how-it-works' },
  { label: 'Features',     href: '/#features' },
  { label: 'Developers',   href: '/#developers' },
  { label: 'Products',     href: '/products' },
  { label: 'Ecosystem',    href: '/#ecosystem' },
]

function Navbar() {
  const [mobileOpen, setMobileOpen] = useState(false)

  return (
    <nav className="fixed top-0 left-0 right-0 z-50 bg-near-black/80 backdrop-blur-md border-b border-white/[0.06]">
      <div className="max-w-6xl mx-auto px-6 py-4 flex items-center justify-between">
        <Link href="/" className="font-lora font-semibold italic text-gold text-xl tracking-tight select-none">
          Veil
        </Link>

        <div className="hidden md:flex items-center gap-7">
          {PRODUCT_NAV.map(({ label, href }) => (
            <Link key={label} href={href}
              className={`font-inter text-sm transition-colors ${
                label === 'Products' ? 'text-off-white' : 'text-warm-grey hover:text-off-white'
              }`}
            >
              {label}
            </Link>
          ))}
        </div>

        <div className="hidden md:flex items-center gap-2.5">
          <a href="https://docs.useveilapp.xyz" className="font-inter text-sm text-warm-grey hover:text-off-white transition-colors px-3 py-1.5">
            Docs
          </a>
          <a href="/#early-access" className="btn-gold !py-2 !px-5 !text-sm">
            Get Early Access
          </a>
        </div>

        <button
          type="button"
          aria-label={mobileOpen ? 'Close menu' : 'Open menu'}
          aria-expanded={mobileOpen}
          onClick={() => setMobileOpen((v) => !v)}
          className="md:hidden text-warm-grey hover:text-off-white p-1.5 transition-colors"
        >
          {mobileOpen ? <X size={22} strokeWidth={1.5} /> : <Menu size={22} strokeWidth={1.5} />}
        </button>
      </div>

      {mobileOpen && (
        <div className="md:hidden border-t border-white/[0.06] bg-near-black/95 px-6 py-5 flex flex-col gap-4">
          {PRODUCT_NAV.map(({ label, href }) => (
            <Link
              key={label}
              href={href}
              onClick={() => setMobileOpen(false)}
              className={`font-inter text-[15px] ${
                label === 'Products' ? 'text-off-white' : 'text-warm-grey'
              }`}
            >
              {label}
            </Link>
          ))}
          <a
            href="https://docs.useveilapp.xyz"
            onClick={() => setMobileOpen(false)}
            className="font-inter text-[15px] text-warm-grey"
          >
            Docs
          </a>
          <a
            href="/#early-access"
            onClick={() => setMobileOpen(false)}
            className="btn-gold mt-1 justify-center"
          >
            Get Early Access
          </a>
        </div>
      )}
    </nav>
  )
}

export default function ProductsPage() {
  return (
    <>
      <Navbar />
      <main className="bg-near-black min-h-screen">

        {/* Hero */}
        <section className="relative pt-40 pb-20 px-6 overflow-hidden">
          <div className="hero-orb-gold" style={{ opacity: 0.6 }} />
          <div className="max-w-4xl mx-auto text-center relative z-10">
            <motion.p
              initial={{ opacity: 0, y: 14 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ duration: 0.5, delay: 0.1 }}
              className="font-anton uppercase text-gold text-[11px] tracking-[0.32em] mb-6"
            >
              The Veil Ecosystem
            </motion.p>
            <motion.h1
              initial={{ opacity: 0, y: 24 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ duration: 0.7, delay: 0.25 }}
              className="font-lora font-semibold italic text-off-white text-4xl md:text-5xl lg:text-[60px] leading-[1.1] tracking-tight mb-6"
            >
              One ecosystem.{' '}
              <span className="hl">Four products.</span>
            </motion.h1>
            <motion.p
              initial={{ opacity: 0, y: 16 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ duration: 0.6, delay: 0.45 }}
              className="font-inter text-warm-grey text-lg max-w-xl mx-auto leading-relaxed"
            >
              From passkey wallets to price oracles, Veil is a full stack built
              for the next generation of Stellar applications.
            </motion.p>
          </div>
        </section>

        {/* Product grid */}
        <section className="section-pad pt-8">
          <div className="max-w-6xl mx-auto">
            <motion.div
              initial="hidden"
              whileInView="show"
              viewport={vp}
              variants={stagger}
              className="grid md:grid-cols-2 gap-6"
            >
              {PRODUCTS.map(({ slug, Icon, accent, tag, name, tagline, desc, highlights, cta, ctaHref, external }) => (
                <motion.div
                  key={slug}
                  variants={fadeUp}
                  className="card-dark p-8 flex flex-col group hover:border-white/[0.14] transition-colors duration-200"
                >
                  {/* Header */}
                  <div className="flex items-start justify-between mb-6">
                    <div
                      className="w-11 h-11 rounded-xl flex items-center justify-center"
                      style={{ background: `${accent}14`, border: `1px solid ${accent}28` }}
                    >
                      <Icon size={20} strokeWidth={1.5} style={{ color: accent }} />
                    </div>
                    <span className="font-anton uppercase text-[10px] tracking-widest px-2.5 py-1 rounded-sm border border-white/[0.08] text-warm-grey/60">
                      {tag}
                    </span>
                  </div>

                  {/* Name & tagline */}
                  <h2 className="font-lora font-semibold text-off-white text-2xl mb-2">
                    {name}
                  </h2>
                  <p className="font-inter text-warm-grey/60 text-sm italic mb-4">
                    {tagline}
                  </p>

                  {/* Description */}
                  <p className="font-inter text-warm-grey/75 text-sm leading-relaxed mb-6 flex-1">
                    {desc}
                  </p>

                  {/* Highlights */}
                  <ul className="space-y-2 mb-8">
                    {highlights.map((h) => (
                      <li key={h} className="flex items-center gap-2.5 font-inter text-sm text-warm-grey/70">
                        <span className="w-1 h-1 rounded-full flex-shrink-0" style={{ background: accent }} />
                        {h}
                      </li>
                    ))}
                  </ul>

                  {/* CTA */}
                  {external ? (
                    <a
                      href={ctaHref}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="inline-flex items-center gap-2 font-inter font-semibold text-sm transition-colors"
                      style={{ color: accent }}
                    >
                      {cta}
                      <ArrowRight size={15} />
                    </a>
                  ) : (
                    <Link
                      href={ctaHref}
                      className="inline-flex items-center gap-2 font-inter font-semibold text-sm transition-colors group-hover:gap-3"
                      style={{ color: accent }}
                    >
                      {cta}
                      <ArrowRight size={15} />
                    </Link>
                  )}
                </motion.div>
              ))}
            </motion.div>
          </div>
        </section>

        {/* Footer strip */}
        <footer className="border-t border-white/[0.06] px-6 py-10">
          <div className="max-w-6xl mx-auto flex flex-col md:flex-row items-center justify-between gap-6">
            <Link href="/" className="font-lora font-semibold italic text-gold text-xl tracking-tight select-none">
              Veil
            </Link>
            <nav className="flex flex-wrap justify-center gap-6">
              {[
                { label: 'Home', href: '/' },
                { label: 'Docs', href: 'https://docs.useveilapp.xyz' },
                { label: 'GitHub', href: 'https://github.com/Miracle656/veil' },
                { label: 'Stellar.org', href: 'https://stellar.org' },
              ].map(({ label, href }) => (
                <a key={label} href={href}
                  target={href.startsWith('http') ? '_blank' : undefined}
                  rel={href.startsWith('http') ? 'noopener noreferrer' : undefined}
                  className="font-inter text-sm text-warm-grey hover:text-off-white transition-colors"
                >
                  {label}
                </a>
              ))}
            </nav>
            <p className="font-inter text-xs text-warm-grey/40">
              Powered by Stellar Soroban · WebAuthn / FIDO2
            </p>
          </div>
        </footer>
      </main>
    </>
  )
}
