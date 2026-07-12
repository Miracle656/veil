'use client'

import { motion } from 'framer-motion'
import Link from 'next/link'
import { ArrowLeft, Filter, ArrowDownUp, BarChart, Activity, Clock, Search } from 'lucide-react'

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
    Icon: Activity,
    title: 'SAC Event Indexing',
    body: 'Listens to Soroban contract events from Stellar Asset Contracts. Decodes transfer, mint, burn, and clawback events that Horizon\'s payments endpoint misses entirely.',
  },
  {
    Icon: ArrowDownUp,
    title: 'Combined Transfers Endpoint',
    body: 'Query incoming, outgoing, or both in a single request. Each transfer includes a direction field so you never have to merge two separate lists client-side.',
  },
  {
    Icon: Clock,
    title: 'Date Range Filters',
    body: 'Pass fromDate and toDate as ISO 8601 strings to scope any query to a time window. Essential for audits, reports, and displaying monthly activity.',
  },
  {
    Icon: BarChart,
    title: 'Transfer Summaries',
    body: 'The /summary/:address endpoint returns aggregate stats — total sent, total received, and transfer count — computed with raw SQL for speed.',
  },
  {
    Icon: Filter,
    title: 'Event Type Filtering',
    body: 'Filter transfers by eventType (transfer, mint, burn, clawback) with allowlist validation. Precise queries without client-side post-processing.',
  },
  {
    Icon: Search,
    title: 'Protocol 22 Resilience',
    body: 'Uses bisection-based fetchEventsSafe to handle XDR decode errors introduced in Stellar Protocol 22 — keeps indexing even when individual ledgers fail to parse.',
  },
]

const ENDPOINTS = [
  { method: 'GET', path: '/transfers/address/:address', desc: 'All transfers for an address — direction=incoming|outgoing|both' },
  { method: 'GET', path: '/summary/:address', desc: 'Aggregate stats: total sent, received, and transfer count' },
  { method: 'GET', path: '/status', desc: 'Indexer health and last processed ledger' },
]

export default function WraithProductPage() {
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
          <a href="https://wraith-0jo1.onrender.com/status" target="_blank" rel="noopener noreferrer"
            className="btn-gold !py-2 !px-5 !text-sm hidden md:inline-flex">
            View Live API
          </a>
        </div>
      </nav>

      <main className="bg-near-black min-h-screen">

        {/* Hero */}
        <section className="relative pt-40 pb-24 px-6 overflow-hidden">
          <div className="absolute top-0 right-0 w-[50vw] h-[50vw] opacity-[0.04]"
            style={{ background: 'radial-gradient(circle, #B7ACE8 0%, transparent 70%)' }} />
          <div className="max-w-4xl mx-auto relative z-10">
            <motion.div initial="hidden" animate="show" variants={stagger}>
              <motion.p variants={fadeUp}
                className="font-anton uppercase text-[11px] tracking-[0.32em] mb-5"
                style={{ color: '#B7ACE8' }}>
                Infrastructure · Event Indexer
              </motion.p>
              <motion.h1 variants={fadeUp}
                className="font-lora font-semibold italic text-off-white text-4xl md:text-5xl lg:text-[64px] leading-[1.08] tracking-tight mb-6"
              >
                The Stellar event indexer{' '}
                <H>Horizon never had.</H>
              </motion.h1>
              <motion.p variants={fadeUp}
                className="font-inter text-warm-grey text-lg md:text-xl max-w-2xl leading-relaxed mb-10"
              >
                Wraith indexes Stellar Asset Contract events — the incoming SAC transfers that
                Horizon's payments endpoint cannot see. Query any address for its full Soroban
                token transfer history with filters, pagination, and summaries.
              </motion.p>
              <motion.div variants={fadeUp} className="flex flex-wrap gap-3">
                <a href="https://wraith-0jo1.onrender.com/status" target="_blank" rel="noopener noreferrer"
                  className="btn-gold">
                  View Live API
                </a>
                <a href="https://github.com/Miracle656/wraith" target="_blank" rel="noopener noreferrer"
                  className="btn-ghost">
                  View on GitHub
                </a>
              </motion.div>
            </motion.div>
          </div>
        </section>

        {/* Problem / solution */}
        <section className="bg-off-white section-pad">
          <div className="max-w-4xl mx-auto">
            <motion.div initial="hidden" whileInView="show" viewport={vp} variants={stagger}>
              <motion.p variants={fadeUp}
                className="font-anton uppercase text-near-black text-[11px] tracking-[0.3em] mb-5">
                The Horizon Gap
              </motion.p>
              <motion.h2 variants={fadeUp}
                className="font-lora font-semibold italic text-near-black text-4xl md:text-5xl leading-tight mb-6">
                Soroban tokens are invisible<br />
                <span className="hl-dark">to classic Stellar tooling.</span>
              </motion.h2>
              <motion.div variants={stagger} className="grid md:grid-cols-2 gap-6 mt-10">
                <motion.div variants={fadeUp} className="card-light p-7">
                  <p className="font-anton uppercase text-near-black/40 text-[10px] tracking-widest mb-4">Without Wraith</p>
                  <ul className="space-y-3">
                    {[
                      'Horizon /payments misses SAC transfers entirely',
                      'Incoming Soroban token transfers are invisible',
                      'No way to query transfer history by address',
                      'No aggregate stats without custom indexing',
                    ].map((item) => (
                      <li key={item} className="flex items-start gap-2.5 font-inter text-sm text-near-black/65">
                        <span className="mt-1.5 w-1.5 h-1.5 rounded-full bg-near-black/20 flex-shrink-0" />
                        {item}
                      </li>
                    ))}
                  </ul>
                </motion.div>
                <motion.div variants={fadeUp} className="card-light p-7 border-teal/30">
                  <p className="font-anton uppercase text-teal text-[10px] tracking-widest mb-4">With Wraith</p>
                  <ul className="space-y-3">
                    {[
                      'Full SAC event history indexed in real time',
                      'Incoming and outgoing transfers unified',
                      'Date range, eventType, and pagination filters',
                      'Aggregate summaries at a single endpoint',
                    ].map((item) => (
                      <li key={item} className="flex items-start gap-2.5 font-inter text-sm text-near-black/65">
                        <span className="mt-1.5 w-1.5 h-1.5 rounded-full flex-shrink-0" style={{ background: '#00A7B5' }} />
                        {item}
                      </li>
                    ))}
                  </ul>
                </motion.div>
              </motion.div>
            </motion.div>
          </div>
        </section>

        {/* Endpoints */}
        <section className="bg-near-black section-pad">
          <div className="max-w-6xl mx-auto">
            <motion.div initial="hidden" whileInView="show" viewport={vp} variants={stagger}
              className="mb-14">
              <motion.p variants={fadeUp}
                className="font-anton uppercase text-[11px] tracking-[0.3em] mb-5"
                style={{ color: '#B7ACE8' }}>
                REST API
              </motion.p>
              <motion.h2 variants={fadeUp}
                className="font-lora font-semibold italic text-off-white text-4xl md:text-5xl leading-tight">
                Simple API.{' '}
                <H>Complete data.</H>
              </motion.h2>
            </motion.div>
            <motion.div initial="hidden" whileInView="show" viewport={vp} variants={stagger}
              className="space-y-3 mb-16">
              {ENDPOINTS.map(({ method, path, desc }) => (
                <motion.div key={path} variants={fadeUp}
                  className="card-dark p-5 flex flex-col sm:flex-row sm:items-center gap-3">
                  <span className="font-inconsolata text-xs font-bold px-2.5 py-1 rounded-sm text-[#B7ACE8] w-fit"
                    style={{ background: 'rgba(183,172,232,0.1)', border: '1px solid rgba(183,172,232,0.2)' }}>
                    {method}
                  </span>
                  <code className="font-inconsolata text-sm text-off-white flex-1 break-all">{path}</code>
                  <p className="font-inter text-warm-grey/55 text-sm sm:text-right sm:max-w-[260px] leading-snug">{desc}</p>
                </motion.div>
              ))}
            </motion.div>

            {/* Features grid */}
            <motion.div initial="hidden" whileInView="show" viewport={vp} variants={stagger}
              className="grid sm:grid-cols-2 lg:grid-cols-3 gap-4">
              {FEATURES.map(({ Icon, title, body }) => (
                <motion.div key={title} variants={fadeUp} className="card-dark p-7">
                  <Icon size={22} strokeWidth={1.5} className="mb-5" style={{ color: '#B7ACE8' }} />
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
                Index your transfers.<br />
                Own your history.
              </motion.h2>
              <motion.p variants={fadeUp}
                className="font-inter text-near-black/65 text-base leading-relaxed max-w-xl mx-auto mb-10">
                Wraith is open source and deployed on Render. Query the live API or fork it and run your own instance.
              </motion.p>
              <motion.div variants={fadeUp} className="flex flex-col sm:flex-row gap-3 justify-center">
                <a href="https://wraith-0jo1.onrender.com/status" target="_blank" rel="noopener noreferrer"
                  className="btn-navy">
                  View Live API
                </a>
                <Link href="/products" className="btn-ghost !border-near-black/25 !text-near-black">
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
                { label: 'Docs', href: 'https://veil-2ap8.vercel.app' },
                { label: 'GitHub', href: 'https://github.com/Miracle656/wraith' },
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
