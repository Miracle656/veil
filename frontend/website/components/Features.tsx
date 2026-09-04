'use client'

import { motion } from 'framer-motion'
import {
  ShieldIcon, LinkIcon, GlobeIcon,
  ZapIcon, UsersIcon, CodeIcon,
} from './Icons'

const FEATURES = [
  {
    Icon: ShieldIcon,
    title: 'Zero Seed Phrases',
    desc: 'Pure WebAuthn/FIDO2 authentication. Private keys are generated and stored in your device secure enclave — never exposed, never transmitted.',
    tag: 'Security',
  },
  {
    Icon: LinkIcon,
    title: 'Fully On-Chain',
    desc: 'Every check — challenge binding, SHA-256 hashing, P-256 ECDSA verification — happens in the Soroban contract. No trusted third parties.',
    tag: 'Trustless',
  },
  {
    Icon: GlobeIcon,
    title: 'Open Standards',
    desc: 'Built on ES256/P-256 — the same cryptography powering Apple Passkeys, Google Password Manager, and YubiKey. Interoperable by design.',
    tag: 'Interop',
  },
  {
    Icon: ZapIcon,
    title: 'Stellar-Native Speed',
    desc: 'Soroban smart contracts settle in 3–5 seconds with sub-cent fees. Biometric auth adds zero latency to the on-chain flow.',
    tag: 'Performance',
  },
  {
    Icon: UsersIcon,
    title: 'Multi-Signer Ready',
    desc: 'Add multiple passkey signers to one account. Guardian recovery lets you reclaim access even if a device is lost — no centralized backup.',
    tag: 'Phase 5',
  },
  {
    Icon: CodeIcon,
    title: 'TypeScript SDK',
    desc: 'Drop-in React hook: useInvisibleWallet(). Handles registration, signing, key extraction, and DER-to-raw conversion — batteries included.',
    tag: 'DX',
  },
]

const container = {
  hidden: {},
  show: { transition: { staggerChildren: 0.09 } },
}

const item = {
  hidden: { opacity: 0, y: 32 },
  show:   { opacity: 1, y: 0, transition: { duration: 0.55, ease: [0.65, 0.05, 0.36, 1] as [number, number, number, number] } },
}

export default function Features() {
  return (
    <section id="features" className="section-pad">
      <div className="max-w-6xl mx-auto">

        {/* Headline */}
        <motion.div
          initial={{ opacity: 0, y: 32 }}
          whileInView={{ opacity: 1, y: 0 }}
          viewport={{ once: true, margin: '-80px' }}
          transition={{ duration: 0.8, ease: 'easeOut' }}
          className="text-center mb-16"
        >
          <p className="text-xs uppercase tracking-[0.22em] text-[#05A2C2] font-medium mb-4">
            Features
          </p>
          <h2 className="text-display-sm md:text-display font-bold text-white mb-5">
            Built for the next billion users
          </h2>
          <p className="text-[#8f8f8f] text-lg max-w-xl mx-auto leading-relaxed">
            Enterprise-grade cryptography with consumer-grade UX. Everything you
            need to ship a passkey wallet on Stellar.
          </p>
        </motion.div>

        {/* Grid */}
        <motion.div
          variants={container}
          initial="hidden"
          whileInView="show"
          viewport={{ once: true, margin: '-60px' }}
          className="grid sm:grid-cols-2 lg:grid-cols-3 gap-4"
        >
          {FEATURES.map(({ Icon, title, desc, tag }) => (
            <motion.div
              key={title}
              variants={item}
              whileHover={{ y: -3, transition: { duration: 0.18 } }}
              className="card p-6 group cursor-default"
            >
              <div className="flex items-start justify-between mb-5">
                {/* Icon */}
                <div
                  className="w-9 h-9 rounded-md flex items-center justify-center text-[#05A2C2]"
                  style={{ background: 'rgba(5,162,194,0.1)', border: '1px solid rgba(5,162,194,0.15)' }}
                >
                  <Icon size={18} />
                </div>
                {/* Tag */}
                <span className="text-[10px] font-medium uppercase tracking-wider text-[#555] border border-[#1E1E1E] px-2 py-0.5 rounded-sm">
                  {tag}
                </span>
              </div>
              <h3 className="text-[15px] font-semibold text-white mb-2">{title}</h3>
              <p className="text-[#8f8f8f] text-sm leading-relaxed">{desc}</p>
            </motion.div>
          ))}
        </motion.div>

      </div>
    </section>
  )
}
