'use client'

import { motion } from 'framer-motion'
import { Key, Globe, Layers } from 'lucide-react'

const fadeUp = {
  hidden: { opacity: 0, y: 28 },
  show: {
    opacity: 1,
    y: 0,
    transition: { duration: 0.65, ease: [0.22, 1, 0.36, 1] as const },
  },
}

const stagger = {
  hidden: {},
  show: { transition: { staggerChildren: 0.11 } },
}

const vp = { once: true, margin: '-72px' as const }

const BULLETS = [
  {
    Icon: Key,
    title: 'No Seed Phrases',
    body: 'Nothing to write down, nothing to lose. Your biometric is the only key you need.',
  },
  {
    Icon: Globe,
    title: 'No Browser Extensions',
    body: 'Works in any modern browser. No installs, no plugins, no platform lock-in.',
  },
  {
    Icon: Layers,
    title: 'Account Abstraction',
    body: 'Soroban custom accounts unlock gas sponsorship, multi-sig, and social recovery — built-in.',
  },
]

const TEAL = '#00A7B5'

const TABLE_ROWS = [
  { feature: 'No seed phrase',            veil: true,  freighter: false, xbull: false },
  { feature: 'No browser extension',      veil: true,  freighter: false, xbull: false },
  { feature: 'Account abstraction',       veil: true,  freighter: false, xbull: false },
  { feature: 'Biometric sign-in',         veil: true,  freighter: false, xbull: false },
  { feature: 'On-chain key verification', veil: true,  freighter: false, xbull: false },
  { feature: 'Guardian / social recovery',veil: true,  freighter: false, xbull: false },
]

function Check() {
  return (
    <span className="inline-flex items-center justify-center">
      <svg width="20" height="20" viewBox="0 0 20 20" fill="none" aria-hidden="true" focusable="false">
        <circle cx="10" cy="10" r="9" fill={TEAL} opacity={0.15} />
        <path d="M6 10l3 3 5-5" stroke={TEAL} strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" />
      </svg>
    </span>
  )
}

function Cross() {
  return (
    <span className="inline-flex items-center justify-center text-warm-grey/30">
      <svg width="20" height="20" viewBox="0 0 20 20" fill="none" aria-hidden="true" focusable="false">
        <circle cx="10" cy="10" r="9" fill="currentColor" opacity={0.12} />
        <path d="M7 7l6 6M13 7l-6 6" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" />
      </svg>
    </span>
  )
}

export default function WhyVeil() {
  return (
    <section
      id="features"
      className="bg-near-black section-pad"
      aria-labelledby="why-veil-heading"
    >
      <div className="max-w-6xl mx-auto">

        {/* Header */}
        <motion.div
          initial="hidden"
          whileInView="show"
          viewport={vp}
          variants={stagger}
          className="text-center mb-16"
        >
          <motion.p
            variants={fadeUp}
            className="font-anton uppercase text-gold text-[11px] tracking-[0.3em] mb-5"
          >
            Why Veil
          </motion.p>
          <motion.h2
            id="why-veil-heading"
            variants={fadeUp}
            className="font-lora font-semibold italic text-off-white text-display-sm md:text-display leading-tight"
          >
            Invisible to attackers.<br />
            <span className="hl">Obvious to you.</span>
          </motion.h2>
        </motion.div>

        {/* Three key bullets */}
        <motion.div
          initial="hidden"
          whileInView="show"
          viewport={vp}
          variants={stagger}
          className="grid sm:grid-cols-3 gap-4 mb-20"
        >
          {BULLETS.map(({ Icon, title, body }) => (
            <motion.div key={title} variants={fadeUp} className="card-dark p-7">
              <Icon
                size={22}
                strokeWidth={1.5}
                className="mb-5"
                style={{ color: TEAL }}
                aria-hidden="true"
              />
              <h3 className="font-lora font-semibold text-off-white text-lg mb-2">
                {title}
              </h3>
              <p className="font-inter text-warm-grey/75 text-sm leading-relaxed">
                {body}
              </p>
            </motion.div>
          ))}
        </motion.div>

        {/* Comparison table */}
        <motion.div
          initial="hidden"
          whileInView="show"
          viewport={vp}
          variants={fadeUp}
        >
          <p
            className="font-anton uppercase text-gold text-[11px] tracking-[0.3em] text-center mb-8"
            aria-hidden="true"
          >
            How We Stack Up
          </p>

          <div
            className="overflow-x-auto rounded-2xl border border-white/[0.08]"
            role="region"
            aria-label="Feature comparison: Veil vs Freighter vs xBull"
          >
            <table
              className="w-full min-w-[520px] border-collapse"
            >
              <caption className="sr-only">
                Feature comparison between Veil, Freighter, and xBull Stellar wallets
              </caption>
              <thead>
                <tr className="border-b border-white/[0.08]">
                  <th
                    scope="col"
                    className="text-left font-inter text-xs text-warm-grey/50 uppercase tracking-widest px-6 py-4 w-1/2"
                  >
                    Feature
                  </th>
                  <th
                    scope="col"
                    className="font-lora font-semibold italic text-gold text-sm px-6 py-4 text-center whitespace-nowrap"
                  >
                    Veil
                  </th>
                  <th
                    scope="col"
                    className="font-inter text-sm text-warm-grey/60 px-6 py-4 text-center whitespace-nowrap"
                  >
                    Freighter
                  </th>
                  <th
                    scope="col"
                    className="font-inter text-sm text-warm-grey/60 px-6 py-4 text-center whitespace-nowrap"
                  >
                    xBull
                  </th>
                </tr>
              </thead>
              <tbody>
                {TABLE_ROWS.map(({ feature, veil, freighter, xbull }, i) => (
                  <tr
                    key={feature}
                    className={i < TABLE_ROWS.length - 1 ? 'border-b border-white/[0.05]' : ''}
                  >
                    <th
                      scope="row"
                      className="text-left font-inter text-sm text-warm-grey px-6 py-4 font-normal"
                    >
                      {feature}
                    </th>
                    <td className="text-center px-6 py-4">
                      {veil ? <Check /> : <Cross />}
                      <span className="sr-only">{veil ? 'Yes' : 'No'}</span>
                    </td>
                    <td className="text-center px-6 py-4">
                      {freighter ? <Check /> : <Cross />}
                      <span className="sr-only">{freighter ? 'Yes' : 'No'}</span>
                    </td>
                    <td className="text-center px-6 py-4">
                      {xbull ? <Check /> : <Cross />}
                      <span className="sr-only">{xbull ? 'Yes' : 'No'}</span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </motion.div>

      </div>
    </section>
  )
}
