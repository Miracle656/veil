'use client'

import { motion } from 'framer-motion'
import Link from 'next/link'
import { ArrowLeft, BarChart2, GitMerge, Zap, CreditCard, Database, Globe } from 'lucide-react'

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
    Icon: BarChart2,
    title: 'VWAP & OHLCV',
    body: 'Volume-weighted average price across 1m, 5m, 1h, and 24h windows. Open, high, low, close, and volume data for any watched pair.',
  },
  {
    Icon: Database,
    title: 'SDEX + AMM Ingestion',
    body: 'Simultaneously ingests SDEX trade history from Horizon and AMM pool snapshots in real time. Merges both sources into a unified price feed.',
  },
  {
    Icon: GitMerge,
    title: 'Best Route Routing',
    body: 'Given a pair and an amount, Lens computes the optimal execution route — SDEX, AMM, or SPLIT — using live reserves and constant-product formula.',
  },
  {
    Icon: CreditCard,
    title: 'x402 Pay-Per-Call',
    body: 'Every price endpoint is gated behind an x402 micropayment. Callers pay a small XLM fee automatically — no API keys, no subscriptions.',
  },
  {
    Icon: Zap,
    title: 'Low-Latency Cache',
    body: 'Redis-backed result cache with configurable TTL. Repeated queries within the window are served instantly with no database round-trip.',
  },
  {
    Icon: Globe,
    title: 'REST + GraphQL',
    body: 'Full REST API at /price/:assetA/:assetB plus a GraphQL endpoint for flexible data queries. Both covered by the same x402 paywall.',
  },
]

const ENDPOINTS = [
  { method: 'GET', path: '/price/:assetA/:assetB', desc: 'Aggregated price, VWAP, volume, and best route for a pair' },
  { method: 'GET', path: '/price/:assetA/:assetB/route', desc: 'Best execution route with slippage estimate for a given amount' },
  { method: 'GET', path: '/price/:assetA/:assetB/history', desc: 'OHLCV bucket history (1m / 5m / 1h / 24h windows)' },
  { method: 'GET', path: '/pools', desc: 'Latest AMM pool snapshots with reserves and spot prices' },
  { method: 'GET', path: '/status', desc: 'Indexer health — last indexed ledger and processed timestamp' },
]

export default function LensProductPage() {
  return (
    <>
      <nav className="fixed top-0 left-0 right-0 z-50 bg-near-black/80 backdrop-blur-md border-b border-white/[0.06]">
        <div className="max-w-6xl mx-auto px-6 py-4 flex items-center justify-between">
          <Link href="/" className="font-lora font-semibold italic text-gold text-xl tracking-tight select-none">
            Veil
          </Link>
          <Link href="/products" className="inline-flex items-center gap-2 font-inter text-sm text-warm-grey hover:text-off-white transition-colors">
            <ArrowLeft size={15} />
            All Products
          </Link>
          <a href="https://lens-ldtu.onrender.com/status" target="_blank" rel="noopener noreferrer"
            className="btn-gold !py-2 !px-4 !text-[13px] md:!px-5 md:!text-sm inline-flex whitespace-nowrap">
            View Live API
          </a>
        </div>
      </nav>

      <main className="bg-near-black min-h-screen">

        {/* Hero */}
        <section className="relative pt-40 pb-24 px-6 overflow-hidden">
          <div className="hero-orb-teal" style={{ opacity: 0.6 }} />
          <div className="max-w-4xl mx-auto relative z-10">
            <motion.div initial="hidden" animate="show" variants={stagger}>
              <motion.p variants={fadeUp}
                className="font-anton uppercase text-[11px] tracking-[0.32em] mb-5"
                style={{ color: '#00A7B5' }}>
                Infrastructure · Price Oracle
              </motion.p>
              <motion.h1 variants={fadeUp}
                className="font-lora font-semibold italic text-off-white text-4xl md:text-5xl lg:text-[64px] leading-[1.08] tracking-tight mb-6"
              >
                Real-time price intelligence{' '}
                <H>for Stellar.</H>
              </motion.h1>
              <motion.p variants={fadeUp}
                className="font-inter text-warm-grey text-lg md:text-xl max-w-2xl leading-relaxed mb-10"
              >
                Lens is a unified price oracle that continuously ingests Stellar DEX trade history
                and AMM pool snapshots, computing VWAP, OHLCV, and optimal routing — served
                behind x402 micropayments with no API key required.
              </motion.p>
              <motion.div variants={fadeUp} className="flex flex-wrap gap-3">
                <a href="https://lens-ldtu.onrender.com/status" target="_blank" rel="noopener noreferrer"
                  className="btn-gold">
                  View Live API
                </a>
                <a href="https://docs.useveilapp.xyz" className="btn-ghost">
                  Read the Docs
                </a>
              </motion.div>
            </motion.div>
          </div>
        </section>

        {/* API Endpoints */}
        <section className="bg-off-white section-pad">
          <div className="max-w-6xl mx-auto">
            <motion.div initial="hidden" whileInView="show" viewport={vp} variants={stagger}
              className="mb-14">
              <motion.p variants={fadeUp}
                className="font-anton uppercase text-near-black text-[11px] tracking-[0.3em] mb-5">
                REST API
              </motion.p>
              <motion.h2 variants={fadeUp}
                className="font-lora font-semibold italic text-near-black text-4xl md:text-5xl leading-tight">
                Five endpoints.{' '}
                <span className="hl-dark">One paywall.</span>
              </motion.h2>
            </motion.div>
            <motion.div initial="hidden" whileInView="show" viewport={vp} variants={stagger}
              className="space-y-3">
              {ENDPOINTS.map(({ method, path, desc }) => (
                <motion.div key={path} variants={fadeUp}
                  className="card-light p-5 flex flex-col sm:flex-row sm:items-center gap-3">
                  <span className="font-inconsolata text-xs font-bold px-2.5 py-1 rounded-sm bg-near-black/[0.06] text-teal w-fit">
                    {method}
                  </span>
                  <code className="font-inconsolata text-sm text-navy flex-1 break-all">
                    {path}
                  </code>
                  <p className="font-inter text-near-black/55 text-sm sm:text-right sm:max-w-[260px] leading-snug">
                    {desc}
                  </p>
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
                className="font-anton uppercase text-[11px] tracking-[0.3em] mb-5"
                style={{ color: '#00A7B5' }}>
                Under the hood
              </motion.p>
              <motion.h2 variants={fadeUp}
                className="font-lora font-semibold italic text-off-white text-4xl md:text-5xl leading-tight">
                Aggregated. Routed.{' '}
                <H>Monetized.</H>
              </motion.h2>
            </motion.div>
            <motion.div initial="hidden" whileInView="show" viewport={vp} variants={stagger}
              className="grid sm:grid-cols-2 lg:grid-cols-3 gap-4">
              {FEATURES.map(({ Icon, title, body }) => (
                <motion.div key={title} variants={fadeUp} className="card-dark p-7">
                  <Icon size={22} strokeWidth={1.5} className="mb-5" style={{ color: '#00A7B5' }} />
                  <h3 className="font-lora font-semibold text-off-white text-lg mb-2">{title}</h3>
                  <p className="font-inter text-warm-grey/75 text-sm leading-relaxed">{body}</p>
                </motion.div>
              ))}
            </motion.div>
          </div>
        </section>

        {/* x402 callout */}
        <section className="bg-navy section-pad">
          <div className="max-w-3xl mx-auto text-center">
            <motion.div initial="hidden" whileInView="show" viewport={vp} variants={stagger}>
              <motion.p variants={fadeUp}
                className="font-anton uppercase text-gold text-[11px] tracking-[0.3em] mb-5">
                x402 Micropayments
              </motion.p>
              <motion.h2 variants={fadeUp}
                className="font-lora font-semibold italic text-off-white text-4xl md:text-5xl leading-tight mb-4"
              >
                No API keys.<br />
                <span className="hl">Pay per call.</span>
              </motion.h2>
              <motion.p variants={fadeUp}
                className="font-inter text-warm-grey/75 text-base leading-relaxed max-w-xl mx-auto mb-10"
              >
                Lens uses the x402 HTTP payment protocol. When you call a price endpoint, your
                client automatically pays a small XLM fee on Stellar and retries — no wallet
                connection required, no subscription to manage.
              </motion.p>
              <motion.div variants={fadeUp} className="flex flex-wrap gap-3 justify-center">
                <a href="https://lens-ldtu.onrender.com/status" target="_blank" rel="noopener noreferrer"
                  className="btn-gold">
                  Explore the API
                </a>
                <Link href="/products" className="btn-ghost">
                  See All Products
                </Link>
              </motion.div>
            </motion.div>
          </div>
        </section>

        <footer className="border-t border-white/[0.06] px-6 py-10">
          <div className="max-w-6xl mx-auto flex flex-col md:flex-row items-center justify-between gap-6">
            <Link href="/" className="font-lora font-semibold italic text-gold text-xl tracking-tight select-none">Veil</Link>
            <nav className="flex flex-wrap justify-center gap-6">
              {[
                { label: 'Home', href: '/' },
                { label: 'Products', href: '/products' },
                { label: 'Docs', href: 'https://docs.useveilapp.xyz' },
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
