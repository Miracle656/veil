'use client'

import { motion } from 'framer-motion'
import { ArrowRightIcon, GithubIcon } from './Icons'

export default function CTA() {
  return (
    <section className="section-pad relative overflow-hidden">

      {/* Subtle grid */}
      <div
        className="absolute inset-0 pointer-events-none opacity-[0.025]"
        style={{
          backgroundImage: `linear-gradient(#fff 1px, transparent 1px), linear-gradient(90deg, #fff 1px, transparent 1px)`,
          backgroundSize: '48px 48px',
        }}
      />

      {/* Teal radial glow */}
      <div
        className="absolute inset-0 pointer-events-none"
        style={{
          background: 'radial-gradient(ellipse 55% 45% at 50% 50%, rgba(5,162,194,0.07) 0%, transparent 70%)',
        }}
      />

      <div className="max-w-3xl mx-auto text-center relative z-10">
        <motion.div
          initial={{ opacity: 0, y: 44 }}
          whileInView={{ opacity: 1, y: 0 }}
          viewport={{ once: true, margin: '-80px' }}
          transition={{ duration: 0.85, ease: [0.65, 0.05, 0.36, 1] as [number, number, number, number] }}
        >
          {/* Badge */}
          <span className="inline-flex items-center gap-2 px-3.5 py-1.5 rounded-pill border border-white/10 bg-white/[0.03] text-xs text-[#8f8f8f] font-medium mb-8">
            <span className="w-1.5 h-1.5 rounded-full bg-[#30A46C]" />
            Open Source · MIT License
          </span>

          <h2 className="text-display-sm md:text-display font-bold text-white mb-5 leading-tight">
            Ready to build the<br />
            <span style={{ color: '#05A2C2' }}>invisible wallet?</span>
          </h2>

          <p className="text-[#8f8f8f] text-lg mb-12 max-w-xl mx-auto leading-relaxed">
            Explore the docs, contribute to open issues, or fork the repo and
            start shipping passkey-native DeFi apps today.
          </p>

          <div className="flex flex-col sm:flex-row gap-3 justify-center">
            <a href="https://docs.useveilapp.xyz">
              <motion.button
                whileHover={{ scale: 1.04, boxShadow: '0 0 28px rgba(5,162,194,0.2)' }}
                whileTap={{ scale: 0.97 }}
                className="btn-primary w-full sm:w-auto justify-center"
              >
                Read the Docs
                <ArrowRightIcon size={15} />
              </motion.button>
            </a>
            <a
              href="https://github.com/Miracle656/veil"
              target="_blank"
              rel="noopener noreferrer"
            >
              <motion.button
                whileHover={{ scale: 1.04 }}
                whileTap={{ scale: 0.97 }}
                className="btn-secondary w-full sm:w-auto justify-center"
              >
                <GithubIcon size={16} />
                Star on GitHub
              </motion.button>
            </a>
          </div>

          {/* Tertiary links */}
          <div className="flex flex-wrap justify-center gap-6 mt-10 text-[13px] text-[#555]">
            {[
              { label: 'Stellar Developers', href: 'https://developers.stellar.org' },
              { label: 'Soroban',            href: 'https://soroban.stellar.org' },
              { label: 'WebAuthn Guide',     href: 'https://webauthn.guide' },
            ].map(({ label, href }) => (
              <a
                key={label}
                href={href}
                target="_blank"
                rel="noopener noreferrer"
                className="hover:text-[#8f8f8f] transition-colors underline underline-offset-4 decoration-[#333]"
              >
                {label} ↗
              </a>
            ))}
          </div>
        </motion.div>
      </div>
    </section>
  )
}
