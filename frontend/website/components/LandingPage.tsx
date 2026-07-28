'use client'

import { useState } from 'react'
import { motion } from 'framer-motion'
import Link from 'next/link'
import {
  Shield, Fingerprint, CheckCircle,
  ExternalLink,
} from 'lucide-react'
import CodeBlock from '@/components/ui/code-block'
import { supabase } from '@/lib/supabase'
import WhyVeil from '@/components/WhyVeil'
import HtmlLang from '@/components/HtmlLang'
import { getMessages, localePath, type Locale, type Messages } from '@/lib/i18n'

/* ── Animation primitives ─────────────────────────────────────────────── */
const fadeUp = {
  hidden: { opacity: 0, y: 28 },
  show: {
    opacity: 1,
    y: 0,
    transition: { duration: 0.65, ease: [0.22, 1, 0.36, 1] as [number, number, number, number] },
  },
}

const stagger = {
  hidden: {},
  show: { transition: { staggerChildren: 0.11 } },
}

const vp = { once: true, margin: '-72px' as const }

/* ── Gold highlight helper (background-image, NOT text-decoration) ────── */
function H({ children, dark }: { children: React.ReactNode; dark?: boolean }) {
  return <span className={dark ? 'hl-dark' : 'hl'}>{children}</span>
}

/* ════════════════════════════════════════════════════════════════════════
   NAVBAR
════════════════════════════════════════════════════════════════════════ */
function Navbar({ t, locale }: { t: Messages; locale: Locale }) {
  const [open, setOpen] = useState(false)

  const items = [
    { label: t.nav.howItWorks, href: '#how-it-works' },
    { label: t.nav.features,   href: '#features' },
    { label: t.nav.developers, href: '#developers' },
    // Product pages are English-only for now — link them from every locale.
    { label: t.nav.products,   href: '/products' },
    { label: t.nav.ecosystem,  href: '#ecosystem' },
  ]

  return (
    <nav className="fixed top-0 left-0 right-0 z-50 bg-near-black/80 backdrop-blur-md border-b border-white/[0.06]">
      <div className="max-w-6xl mx-auto px-6 py-4 flex items-center justify-between">
        {/* Wordmark */}
        <a href={localePath(locale, '/')} className="font-lora font-semibold italic text-gold text-xl tracking-tight select-none">
          Veil
        </a>

        {/* Desktop nav */}
        <div className="hidden md:flex items-center gap-7">
          {items.map(({ label, href }) =>
            href.startsWith('/') ? (
              <Link
                key={label}
                href={href}
                className="font-inter text-sm text-warm-grey hover:text-off-white transition-colors"
              >
                {label}
              </Link>
            ) : (
              <a
                key={label}
                href={href}
                className="font-inter text-sm text-warm-grey hover:text-off-white transition-colors"
              >
                {label}
              </a>
            )
          )}
        </div>

        {/* Desktop CTAs */}
        <div className="hidden md:flex items-center gap-2.5">
          <LocaleSwitcher locale={locale} />
          <a href="https://veil-2ap8.vercel.app" className="font-inter text-sm text-warm-grey hover:text-off-white transition-colors px-3 py-1.5">
            {t.nav.docs}
          </a>
          <a href="#early-access" className="btn-gold !py-2 !px-5 !text-sm">
            {t.nav.getEarlyAccess}
          </a>
        </div>

        {/* Mobile toggle */}
        <button
          className="md:hidden text-warm-grey hover:text-off-white p-1.5"
          onClick={() => setOpen((v) => !v)}
          aria-label="Toggle menu"
        >
          <svg width="20" height="20" viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round">
            {open
              ? <><path d="M4 4l12 12M16 4 4 16" /></>
              : <><path d="M3 5h14M3 10h14M3 15h14" /></>
            }
          </svg>
        </button>
      </div>

      {/* Mobile menu */}
      {open && (
        <div className="md:hidden border-t border-white/[0.06] bg-near-black/95 px-6 py-5 flex flex-col gap-4">
          {items.map(({ label, href }) =>
            href.startsWith('/') ? (
              <Link key={label} href={href}
                className="font-inter text-sm text-warm-grey"
                onClick={() => setOpen(false)}
              >
                {label}
              </Link>
            ) : (
              <a key={label} href={href}
                className="font-inter text-sm text-warm-grey"
                onClick={() => setOpen(false)}
              >
                {label}
              </a>
            )
          )}
          <LocaleSwitcher locale={locale} />
          <a href="#early-access" className="btn-gold mt-2 justify-center" onClick={() => setOpen(false)}>
            {t.nav.getEarlyAccess}
          </a>
        </div>
      )}
    </nav>
  )
}

/* ── Language switcher ────────────────────────────────────────────────── */
function LocaleSwitcher({ locale }: { locale: Locale }) {
  const target: Locale = locale === 'es' ? 'en' : 'es'
  const labels: Record<Locale, string> = { en: 'EN', es: 'ES' }

  return (
    <Link
      href={localePath(target, '/')}
      hrefLang={target}
      aria-label={target === 'es' ? 'Ver en español' : 'View in English'}
      className="font-inter text-xs uppercase tracking-widest text-warm-grey hover:text-off-white transition-colors border border-warm-grey/25 rounded-pill px-3 py-1.5"
    >
      {labels[target]}
    </Link>
  )
}

/* ════════════════════════════════════════════════════════════════════════
   1. HERO
════════════════════════════════════════════════════════════════════════ */
function Hero({ t }: { t: Messages }) {
  return (
    <section className="relative min-h-screen bg-near-black flex items-center justify-center overflow-hidden">
      {/* Animated gradient orbs */}
      <div className="hero-orb-gold" />
      <div className="hero-orb-teal" />

      <div className="relative z-10 text-center px-6 max-w-4xl mx-auto pt-24">
        {/* Anton accent — punchy, ALL CAPS, short */}
        <motion.p
          initial={{ opacity: 0, y: 14 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.5, delay: 0.15 }}
          className="font-anton uppercase text-gold text-xs tracking-[0.32em] mb-7"
        >
          {t.hero.tagline}
        </motion.p>

        {/* Lora SemiBold Italic H1 */}
        <motion.h1
          initial={{ opacity: 0, y: 28 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.75, delay: 0.35 }}
          className="font-lora font-semibold italic text-off-white text-4xl sm:text-5xl md:text-6xl lg:text-[72px] leading-[1.08] tracking-tight mb-6"
        >
          {t.hero.title1}{' '}
          <H>{t.hero.title2}</H>,<br className="hidden sm:block" />
          {' '}{t.hero.title3}
        </motion.h1>

        {/* Inter body */}
        <motion.p
          initial={{ opacity: 0, y: 18 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.65, delay: 0.6 }}
          className="font-inter text-warm-grey text-lg md:text-xl max-w-xl mx-auto mb-10 leading-relaxed"
        >
          {t.hero.subtitle}
        </motion.p>

        {/* CTAs */}
        <motion.div
          initial={{ opacity: 0, y: 14 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.55, delay: 0.82 }}
          className="flex flex-col sm:flex-row gap-3 justify-center items-center"
        >
          <a href="#early-access" className="btn-gold">{t.hero.cta1}</a>
          <a href="https://veil-2ap8.vercel.app" className="btn-ghost">{t.hero.cta2}</a>
        </motion.div>

        {/* Built-on-Stellar badge */}
        <motion.div
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          transition={{ delay: 1.15, duration: 0.7 }}
          className="mt-16"
        >
          <span className="inline-flex items-center gap-2 font-inter text-xs text-warm-grey border border-warm-grey/25 rounded-pill px-4 py-1.5">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none">
              <circle cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="1.5" />
              <path d="M12 6v6l4 2" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
            </svg>
            {t.hero.builtOn}
          </span>
        </motion.div>
      </div>
    </section>
  )
}

/* ════════════════════════════════════════════════════════════════════════
   2. HOW IT WORKS
════════════════════════════════════════════════════════════════════════ */
function HowItWorks({ t }: { t: Messages }) {
  const steps = [
    { num: '01', Icon: Shield,      ...t.howItWorks.steps.register },
    { num: '02', Icon: Fingerprint, ...t.howItWorks.steps.approve },
    { num: '03', Icon: CheckCircle, ...t.howItWorks.steps.verified },
  ]

  return (
    <section id="how-it-works" className="bg-off-white section-pad">
      <div className="max-w-6xl mx-auto">
        {/* Section header */}
        <motion.div
          initial="hidden"
          whileInView="show"
          viewport={vp}
          variants={stagger}
          className="text-center mb-16"
        >
          <motion.p
            variants={fadeUp}
            className="font-anton uppercase text-near-black text-[11px] tracking-[0.3em] mb-5"
          >
            {t.howItWorks.sectionLabel}
          </motion.p>
          <motion.h2
            variants={fadeUp}
            className="font-lora font-semibold italic text-near-black text-display-sm md:text-display leading-tight"
          >
            {t.howItWorks.title1}{' '}<H dark>{t.howItWorks.title2}</H>
          </motion.h2>
        </motion.div>

        {/* Step cards */}
        <motion.div
          initial="hidden"
          whileInView="show"
          viewport={vp}
          variants={stagger}
          className="grid md:grid-cols-3 gap-5"
        >
          {steps.map((step) => (
            <motion.div key={step.num} variants={fadeUp} className="card-light p-8">
              {/* Gold number badge */}
              <div className="w-10 h-10 rounded-full bg-gold flex items-center justify-center mb-6">
                <span className="font-anton text-near-black text-[13px]">{step.num}</span>
              </div>

              {/* Teal icon */}
              <step.Icon size={22} strokeWidth={1.5} className="text-teal mb-4" />

              {/* Lora headline */}
              <h3 className="font-lora font-semibold text-near-black text-xl mb-3">
                {step.title}
              </h3>

              {/* Inter body */}
              <p className="font-inter text-near-black/60 text-sm leading-relaxed">
                {step.body}
              </p>
            </motion.div>
          ))}
        </motion.div>
      </div>
    </section>
  )
}

/* ════════════════════════════════════════════════════════════════════════
   4. DEVELOPER QUICKSTART
════════════════════════════════════════════════════════════════════════ */
function DevQuickstart({ t }: { t: Messages }) {
  return (
    <section id="developers" className="bg-warm-grey section-pad">
      <div className="max-w-4xl mx-auto">
        <motion.div
          initial="hidden"
          whileInView="show"
          viewport={vp}
          variants={stagger}
        >
          {/* Anton label */}
          <motion.p
            variants={fadeUp}
            className="font-anton uppercase text-near-black text-[11px] tracking-[0.3em] mb-5"
          >
            {t.devQuickstart.sectionLabel}
          </motion.p>

          {/* Lora subhead */}
          <motion.h2
            variants={fadeUp}
            className="font-lora font-semibold italic text-near-black text-display-sm md:text-display leading-tight mb-4"
          >
            {t.devQuickstart.title1}{' '}
            <H dark>{t.devQuickstart.title2}</H>
            {' '}{t.devQuickstart.title3}
          </motion.h2>

          {/* Inter intro */}
          <motion.p
            variants={fadeUp}
            className="font-inter text-near-black/60 text-base md:text-lg leading-relaxed mb-10 max-w-2xl"
          >
            {t.devQuickstart.description}
          </motion.p>

          {/* Code block */}
          <motion.div variants={fadeUp}>
            <CodeBlock />
          </motion.div>

          {/* Gold doc link */}
          <motion.a
            variants={fadeUp}
            href="https://veil-2ap8.vercel.app"
            className="inline-flex items-center gap-2 mt-8 font-inter font-semibold text-near-black text-sm hover:text-navy transition-colors"
          >
            <span className="hl-dark">{t.devQuickstart.viewDocs}</span>
            <ExternalLink size={14} />
          </motion.a>
        </motion.div>
      </div>
    </section>
  )
}

/* ════════════════════════════════════════════════════════════════════════
   5. BUILT ON STELLAR
════════════════════════════════════════════════════════════════════════ */
function BuiltOnStellar({ t }: { t: Messages }) {
  return (
    <section id="ecosystem" className="bg-off-white section-pad">
      <div className="max-w-4xl mx-auto">
        <motion.div
          initial="hidden"
          whileInView="show"
          viewport={vp}
          variants={stagger}
          className="text-center"
        >
          {/* Navy headline — Lora */}
          <motion.h2
            variants={fadeUp}
            className="font-lora font-semibold italic text-navy text-display-sm md:text-display leading-tight mb-6"
          >
            {t.ecosystem.title1}<br />
            <H dark>{t.ecosystem.title2}</H>
          </motion.h2>

          {/* Inter body */}
          <motion.p
            variants={fadeUp}
            className="font-inter text-near-black/60 text-base md:text-lg leading-relaxed max-w-2xl mx-auto mb-10"
          >
            {t.ecosystem.description}
          </motion.p>

          {/* Stellar badge — Navy pill, Gold border */}
          <motion.div variants={fadeUp} className="flex justify-center">
            <span
              className="inline-flex items-center gap-2 font-inter font-medium text-sm px-5 py-2.5 rounded-pill border-2"
              style={{
                background: '#002E5D',
                borderColor: '#FDDA24',
                color: '#F6F7F8',
              }}
            >
              <svg width="16" height="16" viewBox="0 0 24 24" fill="#FDDA24">
                <path d="M12 2l3.09 6.26L22 9.27l-5 4.87 1.18 6.88L12 17.77l-6.18 3.25L7 14.14 2 9.27l6.91-1.01L12 2z" />
              </svg>
              {t.ecosystem.poweredBy}
            </span>
          </motion.div>
        </motion.div>
      </div>
    </section>
  )
}

/* ════════════════════════════════════════════════════════════════════════
   6. EARLY ACCESS CTA
════════════════════════════════════════════════════════════════════════ */
function EarlyAccess({ t }: { t: Messages }) {
  const [email, setEmail] = useState('')
  const [submitted, setSubmitted] = useState(false)
  const [submitting, setSubmitting] = useState(false)
  const [submitError, setSubmitError] = useState<string | null>(null)

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!email.trim()) return
    setSubmitting(true)
    setSubmitError(null)
    try {
      const { error } = await supabase.from('waitlist').insert({ email: email.trim().toLowerCase() })
      if (error) {
        if (error.code === '23505') {
          // Unique constraint — already signed up
          setSubmitted(true)
        } else {
          throw error
        }
      } else {
        setSubmitted(true)
      }
    } catch {
      setSubmitError(t.earlyAccess.error)
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <section id="early-access" className="section-pad" style={{ background: '#FDDA24' }}>
      <div className="max-w-3xl mx-auto text-center">
        <motion.div
          initial="hidden"
          whileInView="show"
          viewport={vp}
          variants={stagger}
        >
          {/* Anton label */}
          <motion.p
            variants={fadeUp}
            className="font-anton uppercase text-near-black/60 text-[11px] tracking-[0.3em] mb-5"
          >
            {t.earlyAccess.sectionLabel}
          </motion.p>

          {/* Lora H2 — Near-Black text on Gold */}
          <motion.h2
            variants={fadeUp}
            className="font-lora font-semibold italic text-near-black text-display-sm md:text-display leading-tight mb-4"
          >
            {t.earlyAccess.title1}<br />
            {t.earlyAccess.title2}
          </motion.h2>

          <motion.p
            variants={fadeUp}
            className="font-inter text-near-black/65 text-base md:text-lg mb-10 max-w-xl mx-auto leading-relaxed"
          >
            {t.earlyAccess.description}
          </motion.p>

          {/* Email form */}
          {!submitted ? (
            <motion.form
              variants={fadeUp}
              onSubmit={handleSubmit}
              className="flex flex-col sm:flex-row gap-3 justify-center max-w-md mx-auto"
            >
              <input
                type="email"
                required
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                placeholder={t.earlyAccess.emailPlaceholder}
                className="flex-1 px-5 py-3 rounded-pill bg-near-black/10 border border-near-black/20 font-inter text-near-black placeholder:text-near-black/40 text-sm outline-none focus:border-near-black/50 transition-colors"
              />
              <button type="submit" className="btn-navy whitespace-nowrap" disabled={submitting}>
                {submitting ? t.earlyAccess.joining : t.earlyAccess.joinWaitlist}
              </button>
              {submitError && (
                <p className="text-xs text-red-400 text-center mt-1">{submitError}</p>
              )}
            </motion.form>
          ) : (
            <motion.div
              initial={{ opacity: 0, scale: 0.95 }}
              animate={{ opacity: 1, scale: 1 }}
              className="font-inter font-semibold text-near-black text-lg"
            >
              {t.earlyAccess.success}
            </motion.div>
          )}

          {/* Subtext */}
          <motion.p
            variants={fadeUp}
            className="font-inter text-near-black/50 text-xs mt-5"
          >
            {t.earlyAccess.subtext}
          </motion.p>
        </motion.div>
      </div>
    </section>
  )
}

/* ════════════════════════════════════════════════════════════════════════
   7. FOOTER
════════════════════════════════════════════════════════════════════════ */
function Footer({ t, locale }: { t: Messages; locale: Locale }) {
  const links = [
    { label: t.footer.docs,    href: 'https://veil-2ap8.vercel.app' },
    { label: t.footer.github,  href: 'https://github.com/Miracle656/veil' },
    { label: t.footer.twitter, href: '#' },
    { label: t.footer.stellar, href: 'https://stellar.org' },
  ]

  return (
    <footer className="bg-near-black border-t border-white/[0.06] px-6 py-14">
      <div className="max-w-6xl mx-auto flex flex-col md:flex-row items-center justify-between gap-8">

        {/* Wordmark — Lora, Gold */}
        <a
          href={localePath(locale, '/')}
          className="font-lora font-semibold italic text-gold text-2xl tracking-tight select-none"
          style={{ minWidth: 'max-content' }}
        >
          Veil
        </a>

        {/* Nav links */}
        <nav className="flex flex-wrap justify-center gap-6">
          {links.map((link) => (
            <a
              key={link.label}
              href={link.href}
              target={link.href.startsWith('http') ? '_blank' : undefined}
              rel={link.href.startsWith('http') ? 'noopener noreferrer' : undefined}
              className="font-inter text-sm text-warm-grey hover:text-off-white transition-colors"
            >
              {link.label}
            </a>
          ))}
        </nav>

        {/* Caption */}
        <p className="font-inter text-xs text-warm-grey/40 text-center md:text-right">
          {t.footer.poweredBy}
        </p>
      </div>
    </footer>
  )
}

/* ════════════════════════════════════════════════════════════════════════
   LANDING PAGE
════════════════════════════════════════════════════════════════════════ */
export default function LandingPage({ locale }: { locale: Locale }) {
  const t = getMessages(locale)

  return (
    <div lang={locale}>
      <HtmlLang locale={locale} />
      <Navbar t={t} locale={locale} />
      <main>
        <Hero t={t} />
        <HowItWorks t={t} />
        <WhyVeil t={t} />
        <DevQuickstart t={t} />
        <BuiltOnStellar t={t} />
        <EarlyAccess t={t} />
      </main>
      <Footer t={t} locale={locale} />
    </div>
  )
}
