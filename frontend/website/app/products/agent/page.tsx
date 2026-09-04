'use client'

import { motion } from 'framer-motion'
import Link from 'next/link'
import { ArrowLeft, MessageSquare, TrendingUp, History, Repeat, Send, CheckCircle } from 'lucide-react'

const fadeUp = {
  hidden: { opacity: 0, y: 28 },
  show: { opacity: 1, y: 0, transition: { duration: 0.65, ease: [0.22, 1, 0.36, 1] as [number, number, number, number] } },
}
const stagger = { hidden: {}, show: { transition: { staggerChildren: 0.1 } } }
const vp = { once: true, margin: '-60px' as const }

function H({ children }: { children: React.ReactNode }) {
  return <span className="hl">{children}</span>
}

const CAPABILITIES = [
  {
    Icon: TrendingUp,
    title: 'Live Price Queries',
    body: 'Ask for the best XLM/USDC rate and the Agent calls the Lens oracle automatically, paying the x402 fee on your behalf and returning the best available route.',
  },
  {
    Icon: Repeat,
    title: 'Swap Execution',
    body: 'Describe a swap in plain language. The Agent builds the transaction, shows you the details, and only executes once you explicitly approve — nothing runs without your sign-off.',
  },
  {
    Icon: History,
    title: 'Transfer History',
    body: 'Ask to see recent transactions and the Agent queries Wraith for Soroban token transfers alongside Horizon classic payments, combining both into a single readable summary.',
  },
  {
    Icon: Send,
    title: 'Payment Building',
    body: 'Send XLM to any Stellar address. The Agent constructs the payment transaction and presents it for your review. One tap to approve, one biometric to sign.',
  },
  {
    Icon: CheckCircle,
    title: 'Human-in-the-Loop',
    body: 'Every action that moves funds — swaps, payments — requires explicit user approval. The Agent will describe what it wants to do and pause until you confirm.',
  },
  {
    Icon: MessageSquare,
    title: 'Natural Language Interface',
    body: 'No menus, no forms. Just describe what you want. The Agent handles tool selection, error recovery, and response formatting.',
  },
]

const EXAMPLE_EXCHANGES = [
  { role: 'user',  text: 'Best XLM/USDC rate right now?' },
  { role: 'agent', text: 'The best route is SDEX at ~0.112 USDC per XLM — about 3% better than the AMM pool. Ready to swap?' },
  { role: 'user',  text: 'Swap 500 XLM to USDC' },
  { role: 'agent', text: 'I\'ll swap 500 XLM for ~55.8 USDC via SDEX. Estimated fee: 0.00001 XLM. Approve?' },
  { role: 'user',  text: 'Show my last 5 transfers' },
  { role: 'agent', text: 'Here are your 5 most recent transfers: received 100 USDC from G3K…, sent 50 XLM to GBCD…, ...' },
]

export default function AgentProductPage() {
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
          <a href="https://app.useveilapp.xyz" target="_blank" rel="noopener noreferrer"
            className="btn-gold !py-2 !px-4 !text-[13px] md:!px-5 md:!text-sm inline-flex whitespace-nowrap">
            Try the Wallet
          </a>
        </div>
      </nav>

      <main className="bg-near-black min-h-screen">

        {/* Hero */}
        <section className="relative pt-40 pb-24 px-6 overflow-hidden">
          <div className="hero-orb-gold" style={{ opacity: 0.4 }} />
          <div className="hero-orb-teal" style={{ opacity: 0.3 }} />
          <div className="max-w-4xl mx-auto relative z-10">
            <motion.div initial="hidden" animate="show" variants={stagger}>
              <motion.p variants={fadeUp}
                className="font-anton uppercase text-gold text-[11px] tracking-[0.32em] mb-5">
                AI · Wallet Assistant
              </motion.p>
              <motion.h1 variants={fadeUp}
                className="font-lora font-semibold italic text-off-white text-4xl md:text-5xl lg:text-[64px] leading-[1.08] tracking-tight mb-6"
              >
                Your wallet,{' '}
                <H>now with a brain.</H>
              </motion.h1>
              <motion.p variants={fadeUp}
                className="font-inter text-warm-grey text-lg md:text-xl max-w-2xl leading-relaxed mb-10"
              >
                Veil Agent is a Claude-powered AI assistant embedded directly in the wallet.
                Ask about prices, run a swap, check your history — all in plain language,
                all with your explicit approval before anything executes.
              </motion.p>
              <motion.div variants={fadeUp} className="flex flex-wrap gap-3">
                <a href="https://app.useveilapp.xyz" target="_blank" rel="noopener noreferrer"
                  className="btn-gold">
                  Try in the Wallet
                </a>
                <a href="https://docs.useveilapp.xyz" className="btn-ghost">
                  Read the Docs
                </a>
              </motion.div>
            </motion.div>
          </div>
        </section>

        {/* Example conversation */}
        <section className="bg-off-white section-pad">
          <div className="max-w-3xl mx-auto">
            <motion.div initial="hidden" whileInView="show" viewport={vp} variants={stagger}>
              <motion.p variants={fadeUp}
                className="font-anton uppercase text-near-black text-[11px] tracking-[0.3em] mb-5">
                See it in action
              </motion.p>
              <motion.h2 variants={fadeUp}
                className="font-lora font-semibold italic text-near-black text-4xl md:text-5xl leading-tight mb-10">
                Just ask.{' '}
                <span className="hl-dark">It handles the rest.</span>
              </motion.h2>
              <motion.div variants={stagger} className="space-y-3">
                {EXAMPLE_EXCHANGES.map((msg, i) => (
                  <motion.div
                    key={i}
                    variants={fadeUp}
                    className={`flex ${msg.role === 'user' ? 'justify-end' : 'justify-start'}`}
                  >
                    <div
                      className={`max-w-[78%] px-4 py-3 rounded-2xl font-inter text-sm leading-relaxed ${
                        msg.role === 'user'
                          ? 'bg-near-black text-off-white rounded-br-sm'
                          : 'bg-white border border-black/[0.07] text-near-black/80 rounded-bl-sm'
                      }`}
                    >
                      {msg.role === 'agent' && (
                        <span className="block font-anton uppercase text-[9px] tracking-widest text-gold mb-1.5">
                          Veil Agent
                        </span>
                      )}
                      {msg.text}
                    </div>
                  </motion.div>
                ))}
              </motion.div>
            </motion.div>
          </div>
        </section>

        {/* Capabilities */}
        <section className="bg-near-black section-pad">
          <div className="max-w-6xl mx-auto">
            <motion.div initial="hidden" whileInView="show" viewport={vp} variants={stagger}
              className="text-center mb-16">
              <motion.p variants={fadeUp}
                className="font-anton uppercase text-gold text-[11px] tracking-[0.3em] mb-5">
                What it can do
              </motion.p>
              <motion.h2 variants={fadeUp}
                className="font-lora font-semibold italic text-off-white text-4xl md:text-5xl leading-tight">
                Six tools. One conversation.{' '}
                <H>Your approval.</H>
              </motion.h2>
            </motion.div>
            <motion.div initial="hidden" whileInView="show" viewport={vp} variants={stagger}
              className="grid sm:grid-cols-2 lg:grid-cols-3 gap-4">
              {CAPABILITIES.map(({ Icon, title, body }) => (
                <motion.div key={title} variants={fadeUp} className="card-dark p-7">
                  <Icon size={22} strokeWidth={1.5} className="text-gold mb-5" />
                  <h3 className="font-lora font-semibold text-off-white text-lg mb-2">{title}</h3>
                  <p className="font-inter text-warm-grey/75 text-sm leading-relaxed">{body}</p>
                </motion.div>
              ))}
            </motion.div>
          </div>
        </section>

        {/* How it fits in */}
        <section className="bg-navy section-pad">
          <div className="max-w-4xl mx-auto">
            <motion.div initial="hidden" whileInView="show" viewport={vp} variants={stagger}>
              <motion.p variants={fadeUp}
                className="font-anton uppercase text-gold text-[11px] tracking-[0.3em] mb-5">
                Architecture
              </motion.p>
              <motion.h2 variants={fadeUp}
                className="font-lora font-semibold italic text-off-white text-4xl md:text-5xl leading-tight mb-6">
                Built on the full{' '}
                <span className="hl">Veil stack.</span>
              </motion.h2>
              <motion.p variants={fadeUp}
                className="font-inter text-warm-grey/75 text-base leading-relaxed max-w-2xl mb-10">
                The Agent connects the whole ecosystem: it queries Lens for live prices
                (paying x402 micropayments automatically), Wraith for Soroban transfer history,
                and the Stellar SDK for balance and payment building. Every tool call is
                backed by real on-chain data.
              </motion.p>
              <motion.div variants={stagger} className="grid sm:grid-cols-3 gap-4">
                {[
                  { name: 'Lens', role: 'Price & routing data', color: '#00A7B5', href: '/products/lens' },
                  { name: 'Wraith', role: 'Transfer history', color: '#B7ACE8', href: '/products/wraith' },
                  { name: 'Wallet', role: 'Auth & execution', color: '#FDDA24', href: '/products/wallet' },
                ].map(({ name, role, color, href }) => (
                  <motion.div key={name} variants={fadeUp}>
                    <Link href={href}
                      className="card-dark p-5 flex flex-col gap-2 hover:border-white/[0.15] transition-colors block">
                      <span className="font-lora font-semibold text-off-white text-lg" style={{ color }}>
                        {name}
                      </span>
                      <span className="font-inter text-warm-grey/60 text-sm">{role}</span>
                    </Link>
                  </motion.div>
                ))}
              </motion.div>
            </motion.div>
          </div>
        </section>

        {/* CTA */}
        <section className="section-pad" style={{ background: '#FDDA24' }}>
          <div className="max-w-3xl mx-auto text-center">
            <motion.div initial="hidden" whileInView="show" viewport={vp} variants={stagger}>
              <motion.h2 variants={fadeUp}
                className="font-lora font-semibold italic text-near-black text-4xl md:text-5xl leading-tight mb-4">
                Ask it anything.<br />
                Approve before it acts.
              </motion.h2>
              <motion.p variants={fadeUp}
                className="font-inter text-near-black/65 text-base leading-relaxed max-w-xl mx-auto mb-10">
                Veil Agent is live inside the Veil wallet on Stellar testnet. Open the wallet, tap the chat icon, and start a conversation.
              </motion.p>
              <motion.div variants={fadeUp} className="flex flex-col sm:flex-row gap-3 justify-center">
                <a href="https://app.useveilapp.xyz" target="_blank" rel="noopener noreferrer"
                  className="btn-navy">
                  Open the Wallet
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
