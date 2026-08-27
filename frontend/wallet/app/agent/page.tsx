'use client'

import { PageHeader } from '@/components/ui/primitives'
import { useState, useEffect, useRef, useCallback } from 'react'
import { useRouter } from 'next/navigation'
import { Keypair } from '@stellar/stellar-sdk'
import { useInactivityLock } from '@/hooks/useInactivityLock'
import { getNetwork } from '@/lib/network'
import { requirePasskey } from '@/lib/passkeyAuth'
import { walletLocal, walletSession } from '@/lib/walletStorage'

const network = getNetwork()

interface Message {
  role: 'user' | 'agent'
  content: string
  pendingTxXdr?: string
  pendingTxSummary?: string
}

// Agent output relays third-party data (transfer memos, token metadata, price
// payloads), so it is untrusted. Escape all HTML *before* applying the inline
// markup pass — the `**bold**` / `` `code` `` markers are not HTML-special, so
// they still match, and the only real tags produced are the ones injected here.
// Without the escape, a payload like `<img src=x onerror=...>` would execute in
// a wallet origin that holds the signing key.
function renderAgentMarkup(content: string): string {
  const escaped = content
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
  return escaped
    .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
    .replace(/`(.+?)`/g, '<code style="font-family:Inconsolata,monospace;background:rgba(255,255,255,0.08);padding:1px 5px;border-radius:4px;font-size:0.8125rem">$1</code>')
}

// ── User roles ───────────────────────────────────────────────────────────────
const ROLE_ICONS: Record<string, JSX.Element> = {
  trader: (
    <svg width="22" height="22" viewBox="0 0 24 24" fill="none">
      <path d="M7 10l5-5 5 5M17 14l-5 5-5-5" stroke="var(--gold)" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/>
    </svg>
  ),
  investor: (
    <svg width="22" height="22" viewBox="0 0 24 24" fill="none">
      <polyline points="22 7 13.5 15.5 8.5 10.5 2 17" stroke="var(--gold)" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/>
      <polyline points="16 7 22 7 22 13" stroke="var(--gold)" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/>
    </svg>
  ),
  saver: (
    <svg width="22" height="22" viewBox="0 0 24 24" fill="none">
      <path d="M19 21V5a2 2 0 00-2-2H7a2 2 0 00-2 2v16m14 0H5m14 0h2m-16 0H3" stroke="var(--gold)" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/>
      <path d="M9 7h6M9 11h6M9 15h4" stroke="var(--gold)" strokeWidth="2" strokeLinecap="round"/>
    </svg>
  ),
  explorer: (
    <svg width="22" height="22" viewBox="0 0 24 24" fill="none">
      <circle cx="11" cy="11" r="8" stroke="var(--gold)" strokeWidth="2"/>
      <path d="M21 21l-4.35-4.35" stroke="var(--gold)" strokeWidth="2" strokeLinecap="round"/>
    </svg>
  ),
}

const ROLES = [
  { value: 'trader',   label: 'Trader',   desc: 'I actively swap and trade assets' },
  { value: 'investor', label: 'Investor', desc: 'I hold long-term and look for yield' },
  { value: 'saver',    label: 'Saver',    desc: 'I save and send money to people' },
  { value: 'explorer', label: 'Explorer', desc: "I'm new and want to learn" },
]

const LANGUAGES = [
  'English', 'Spanish', 'French', 'Portuguese', 'Chinese', 'Japanese',
  'Korean', 'Arabic', 'Hindi', 'Russian', 'German', 'Turkish', 'Yoruba', 'Igbo', 'Swahili',
]

// ── Role-aware suggestions ───────────────────────────────────────────────────
const ROLE_SUGGESTIONS: Record<string, string[]> = {
  trader: ["What's my balance?", 'Best XLM/USDC rate?', 'Swap 100 XLM to USDC', 'Show recent trades'],
  investor: ["What's my balance?", 'Best XLM/USDC rate?', 'Show my portfolio', 'Any yield opportunities?'],
  saver: ["What's my balance?", 'Send 50 XLM', 'Show recent transfers', 'Who sent me XLM?'],
  explorer: ["What's my balance?", 'How do swaps work?', 'What can you do?', 'Show recent transfers'],
}

const DEFAULT_SUGGESTIONS = [
  "What's my balance?",
  'Swap 100 XLM to USDC',
  'Show recent transfers',
  'Best XLM/USDC rate?',
]

export interface UserProfile {
  name?: string
  language?: string
  persona?: string
  role?: string
}

function getUserProfile(): UserProfile {
  if (typeof window === 'undefined') return {}
  try {
    const raw = localStorage.getItem('veil_user_profile')
    return raw ? JSON.parse(raw) : {}
  } catch { return {} }
}

function saveUserProfile(profile: UserProfile) {
  localStorage.setItem('veil_user_profile', JSON.stringify(profile))
}

function buildGreeting(profile: UserProfile, notification?: string | null): string {
  const name = profile.name ? `, ${profile.name}` : ''

  // If there's a pending notification (incoming funds), show that first
  if (notification) return notification

  switch (profile.role) {
    case 'trader':
      return `Hey${name}! Ready to trade? I can check live prices, find the best swap routes, and execute trades — all with your biometric approval.`
    case 'investor':
      return `Hey${name}! I can help you check your portfolio, find the best rates, and manage your positions. What would you like to review?`
    case 'saver':
      return `Hey${name}! Need to send or check on funds? I can show your balance, recent transfers, and help you send payments securely.`
    case 'explorer':
      return `Hey${name}! Welcome to Veil. I can help you check balances, explore prices, make swaps, and send payments. Ask me anything!`
    default:
      return `Hey${name}! I'm your Veil agent. I can check prices, view transfer history, and execute swaps — all with your approval. What would you like to do?`
  }
}

// ── Notification helpers ─────────────────────────────────────────────────────
function getPendingNotification(profile: UserProfile): string | null {
  if (typeof window === 'undefined') return null
  try {
    const raw = localStorage.getItem('veil_agent_notification')
    if (!raw) return null
    const notif = JSON.parse(raw)
    // Clear after reading
    localStorage.removeItem('veil_agent_notification')

    const name = profile.name ? `, ${profile.name}` : ''
    const amount = notif.amount ?? '?'
    const asset = notif.asset ?? 'XLM'
    const from = notif.from
      ? `${notif.from.slice(0, 6)}…${notif.from.slice(-6)}`
      : 'someone'

    switch (profile.role) {
      case 'trader':
        return `Hey${name}! You just received **${amount} ${asset}** from ${from}. Want to check the current rates and make a trade?`
      case 'investor':
        return `Hey${name}! **${amount} ${asset}** just landed in your wallet from ${from}. Would you like to explore yield opportunities or check market prices?`
      case 'saver':
        return `Hey${name}! You received **${amount} ${asset}** from ${from}. Your updated balance is ready — want to see it?`
      case 'explorer':
        return `Hey${name}! Good news — you just received **${amount} ${asset}** from ${from}. Want me to explain what you can do with it?`
      default:
        return `Hey${name}! You received **${amount} ${asset}** from ${from}. What would you like to do?`
    }
  } catch { return null }
}

export default function AgentPage() {
  const router = useRouter()
  useInactivityLock()

  const [showOnboarding, setShowOnboarding] = useState(false)
  const [onboardingStep, setOnboardingStep] = useState(0) // 0=name, 1=role, 2=language
  const [draft, setDraft] = useState<UserProfile>({ name: '', role: '', language: 'English' })

  // Check if onboarding needed
  useEffect(() => {
    const profile = getUserProfile()
    if (!profile.role) {
      setShowOnboarding(true)
      setDraft({ name: profile.name ?? '', role: '', language: profile.language ?? 'English' })
    }
  }, [])

  const [messages, setMessages] = useState<Message[]>(() => {
    const profile = getUserProfile()
    if (!profile.role) return [] // will be set after onboarding
    const notification = getPendingNotification(profile)
    return [{ role: 'agent', content: buildGreeting(profile, notification) }]
  })
  const [input, setInput] = useState('')
  const [isThinking, setIsThinking] = useState(false)
  const [pendingTxXdr, setPendingTxXdr] = useState<string | null>(null)
  const [pendingTxSummary, setPendingTxSummary] = useState<string | null>(null)
  const [approving, setApproving] = useState(false)
  const wsRef = useRef<WebSocket | null>(null)
  const bottomRef = useRef<HTMLDivElement>(null)
  const inputRef = useRef<HTMLInputElement>(null)

  const walletAddress =
    typeof window !== 'undefined'
      ? (walletSession.getItem('invisible_wallet_address') ?? '')
      : ''

  // Always derive fee-payer public key from the secret — never from the cached
  // veil_signer_public_key, which can be stale and cause address/signer mismatch (400).
  const feePayerAddress = (() => {
    if (typeof window === 'undefined') return ''
    try {
      const secret = walletSession.getItem('veil_signer_secret')
        ?? walletLocal.getItem('veil_signer_secret')
      if (!secret) return ''
      return Keypair.fromSecret(secret).publicKey()
    } catch { return '' }
  })()

  const reconnectTimer = useRef<ReturnType<typeof setTimeout> | null>(null)

  const connect = useCallback(() => {
    const wsUrl = process.env.NEXT_PUBLIC_AGENT_WS_URL ?? 'ws://localhost:3001'
    const ws = new WebSocket(wsUrl)
    wsRef.current = ws

    ws.onclose = () => {
      reconnectTimer.current = setTimeout(connect, 2000)
    }

    ws.onmessage = (event) => {
      const data = JSON.parse(event.data)

      if (data.type === 'thinking') {
        setIsThinking(true)
        return
      }

      if (data.type === 'response') {
        setIsThinking(false)
        const msg: Message = { role: 'agent', content: data.message }
        if (data.pendingTxXdr) {
          msg.pendingTxXdr = data.pendingTxXdr
          msg.pendingTxSummary = data.pendingTxSummary
          setPendingTxXdr(data.pendingTxXdr)
          setPendingTxSummary(data.pendingTxSummary ?? null)
        }
        setMessages((prev) => [...prev, msg])
        return
      }

      if (data.type === 'error') {
        setIsThinking(false)
        setMessages((prev) => [
          ...prev,
          { role: 'agent', content: `Something went wrong: ${data.message}` },
        ])
      }
    }
  }, [])

  useEffect(() => {
    connect()
    return () => {
      if (reconnectTimer.current) clearTimeout(reconnectTimer.current)
      wsRef.current?.close()
    }
  }, [connect])

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [messages, isThinking])

  const sendMessage = useCallback(() => {
    const text = input.trim()
    if (!text || isThinking || !wsRef.current) return

    setMessages((prev) => [...prev, { role: 'user', content: text }])
    setInput('')

    // If fee-payer key was cleared (cache clear), warn the user before sending
    if (!feePayerAddress) {
      setMessages((prev) => [
        ...prev,
        {
          role: 'agent',
          content:
            'Your signing key is missing — this usually happens after clearing browser storage.\n\nGo to the **Dashboard** and tap **Set up fee-payer** to restore it, then come back and try again.',
        },
      ])
      return
    }

    wsRef.current.send(
      JSON.stringify({ type: 'chat', walletAddress, feePayerAddress, message: text, profile: getUserProfile() }),
    )
  }, [input, isThinking, walletAddress, feePayerAddress])

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      sendMessage()
    }
  }

  const approveTransaction = async () => {
    if (!pendingTxXdr) return
    const xdrToSubmit = pendingTxXdr
    setApproving(true)
    // Remove the approval card immediately so it can't be double-submitted
    setMessages((prev) =>
      prev.map((m) =>
        m.pendingTxXdr === xdrToSubmit
          ? { ...m, pendingTxXdr: undefined, pendingTxSummary: undefined }
          : m,
      ),
    )
    setPendingTxXdr(null)
    setPendingTxSummary(null)
    try {
      // Require biometric / passkey approval before signing
      await requirePasskey()

      const signerSecret =
        walletSession.getItem('veil_signer_secret') ??
        walletLocal.getItem('veil_signer_secret')

      if (!signerSecret) {
        setMessages((prev) => [
          ...prev,
          { role: 'agent', content: 'Signing key not found. Please return to the dashboard first.' },
        ])
        return
      }

      const { Keypair, TransactionBuilder, Horizon } = await import('@stellar/stellar-sdk')
      const feePayer = Keypair.fromSecret(signerSecret)
      const horizonServer = new Horizon.Server(network.horizonUrl)

      const tx = TransactionBuilder.fromXDR(xdrToSubmit, network.networkPassphrase)
      tx.sign(feePayer)

      const result = await horizonServer.submitTransaction(tx)

      setMessages((prev) => [
        ...prev,
        {
          role: 'agent',
          content: `Transaction submitted.\n\nHash: \`${result.hash}\`\n\nSettles in ~5 seconds.`,
        },
      ])
    } catch (err: any) {
      // Extract detailed Horizon error codes when available
      let detail = err?.message ?? 'Unknown error'
      try {
        const extras = err?.response?.data?.extras
        if (extras?.result_codes) {
          const codes = extras.result_codes
          const opCodes = codes.operations?.join(', ') ?? ''
          detail = `${codes.transaction ?? 'tx_failed'}${opCodes ? ` — ${opCodes}` : ''}`
        }
      } catch { /* use generic message */ }
      setMessages((prev) => [
        ...prev,
        { role: 'agent', content: `Transaction failed: ${detail}` },
      ])
    } finally {
      setApproving(false)
    }
  }

  const clearHistory = () => {
    if (!walletAddress || !wsRef.current) return
    wsRef.current.send(JSON.stringify({ type: 'clear_history', walletAddress }))
    const profile = getUserProfile()
    setMessages([{ role: 'agent', content: buildGreeting(profile) }])
  }

  // Finish onboarding → save profile, show greeting, enter chat
  const finishOnboarding = () => {
    const existing = getUserProfile()
    const merged: UserProfile = { ...existing, ...draft }
    saveUserProfile(merged)
    setShowOnboarding(false)
    const notification = getPendingNotification(merged)
    setMessages([{ role: 'agent', content: buildGreeting(merged, notification) }])
    // Mark notification as seen
    localStorage.setItem('veil_agent_last_visit', Date.now().toString())
  }

  const suggestions = ROLE_SUGGESTIONS[getUserProfile().role ?? ''] ?? DEFAULT_SUGGESTIONS

  // ── Onboarding screen ────────────────────────────────────────────────────
  if (showOnboarding) {
    return (
      <div className="wallet-shell">
        <header className="wallet-nav">
          <button
            onClick={() => router.back()}
            style={{ background: 'none', border: 'none', cursor: 'pointer', padding: '0.25rem', color: 'var(--warm-grey)', display: 'flex' }}
          >
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none">
              <path d="M19 12H5M12 19l-7-7 7-7" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/>
            </svg>
          </button>
          <span style={{ fontWeight: 600, fontSize: '0.9375rem' }}>Set Up Your Agent</span>
          <div style={{ width: '28px' }} />
        </header>

        <main className="wallet-main" style={{ display: 'flex', flexDirection: 'column', gap: '1.25rem', paddingTop: '2rem' }}>

          {/* Progress dots */}
          <div style={{ display: 'flex', justifyContent: 'center', gap: '0.5rem', marginBottom: '0.5rem' }}>
            {[0, 1, 2].map(i => (
              <div key={i} style={{
                width: '8px', height: '8px', borderRadius: '50%',
                background: i <= onboardingStep ? 'var(--gold)' : 'var(--border-dim)',
                transition: 'background 200ms',
              }} />
            ))}
          </div>

          {/* Step 0: Name */}
          {onboardingStep === 0 && (
            <>
              <div style={{ marginBottom: '1.75rem' }}>
          <PageHeader eyebrow="Assistant" title="Agent" />
        </div>
              <p style={{ fontSize: '0.875rem', color: 'rgba(246,247,248,0.5)', textAlign: 'center', lineHeight: 1.6 }}>
                Your agent will greet you by name and personalize conversations.
              </p>
              <input
                className="input-field"
                type="text"
                placeholder="Your name"
                value={draft.name ?? ''}
                onChange={e => setDraft(d => ({ ...d, name: e.target.value }))}
                autoFocus
                autoComplete="off"
                style={{ fontSize: '1rem', textAlign: 'center' }}
              />
              <button
                className="btn-gold"
                onClick={() => setOnboardingStep(1)}
              >
                {draft.name?.trim() ? 'Continue' : 'Skip'}
              </button>
            </>
          )}

          {/* Step 1: Role */}
          {onboardingStep === 1 && (
            <>
              <h2 style={{ fontFamily: 'Lora, Georgia, serif', fontWeight: 600, fontStyle: 'italic', fontSize: '1.75rem', textAlign: 'center' }}>
                How do you use your wallet?
              </h2>
              <p style={{ fontSize: '0.875rem', color: 'rgba(246,247,248,0.5)', textAlign: 'center', lineHeight: 1.6 }}>
                This helps your agent give smarter suggestions when you receive funds or ask for help.
              </p>
              <div style={{ display: 'flex', flexDirection: 'column', gap: '0.75rem' }}>
                {ROLES.map(r => (
                  <button
                    key={r.value}
                    onClick={() => setDraft(d => ({ ...d, role: r.value }))}
                    style={{
                      display: 'flex', alignItems: 'center', gap: '1rem',
                      padding: '1rem 1.25rem', borderRadius: '0.75rem',
                      cursor: 'pointer', textAlign: 'left',
                      border: draft.role === r.value ? '1.5px solid var(--gold)' : '1px solid var(--border-dim)',
                      background: draft.role === r.value ? 'rgba(253,218,36,0.06)' : 'transparent',
                      transition: 'all 120ms',
                    }}
                  >
                    <span style={{ flexShrink: 0, display: 'flex' }}>{ROLE_ICONS[r.value]}</span>
                    <div>
                      <div style={{ fontSize: '0.9375rem', fontWeight: 600, color: draft.role === r.value ? 'var(--gold)' : 'var(--off-white)' }}>
                        {r.label}
                      </div>
                      <div style={{ fontSize: '0.8125rem', color: 'var(--warm-grey)', marginTop: '0.125rem' }}>
                        {r.desc}
                      </div>
                    </div>
                    {draft.role === r.value && (
                      <svg width="18" height="18" viewBox="0 0 24 24" fill="none" style={{ marginLeft: 'auto', flexShrink: 0 }}>
                        <path d="M20 6L9 17l-5-5" stroke="var(--gold)" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"/>
                      </svg>
                    )}
                  </button>
                ))}
              </div>
              <div style={{ display: 'flex', gap: '0.75rem' }}>
                <button className="btn-ghost" onClick={() => setOnboardingStep(0)} style={{ flex: 1 }}>
                  Back
                </button>
                <button
                  className="btn-gold"
                  onClick={() => setOnboardingStep(2)}
                  disabled={!draft.role}
                  style={{ flex: 2 }}
                >
                  Continue
                </button>
              </div>
            </>
          )}

          {/* Step 2: Language */}
          {onboardingStep === 2 && (
            <>
              <h2 style={{ fontFamily: 'Lora, Georgia, serif', fontWeight: 600, fontStyle: 'italic', fontSize: '1.75rem', textAlign: 'center' }}>
                Preferred language
              </h2>
              <p style={{ fontSize: '0.875rem', color: 'rgba(246,247,248,0.5)', textAlign: 'center', lineHeight: 1.6 }}>
                Your agent will respond in this language.
              </p>
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: '0.5rem', justifyContent: 'center' }}>
                {LANGUAGES.map(lang => (
                  <button
                    key={lang}
                    onClick={() => setDraft(d => ({ ...d, language: lang }))}
                    style={{
                      padding: '0.5rem 0.875rem',
                      borderRadius: '2rem',
                      fontSize: '0.8125rem',
                      fontWeight: 500,
                      cursor: 'pointer',
                      border: draft.language === lang ? '1.5px solid var(--gold)' : '1px solid var(--border-dim)',
                      background: draft.language === lang ? 'rgba(253,218,36,0.1)' : 'var(--surface-md)',
                      color: draft.language === lang ? 'var(--gold)' : 'var(--off-white)',
                      transition: 'all 120ms',
                    }}
                  >
                    {lang}
                  </button>
                ))}
              </div>
              <div style={{ display: 'flex', gap: '0.75rem' }}>
                <button className="btn-ghost" onClick={() => setOnboardingStep(1)} style={{ flex: 1 }}>
                  Back
                </button>
                <button
                  className="btn-gold"
                  onClick={finishOnboarding}
                  style={{ flex: 2 }}
                >
                  Start chatting
                </button>
              </div>
            </>
          )}
        </main>
      </div>
    )
  }

  // ── Chat UI (redesigned) ─────────────────────────────────────────────────
  return (
    <div className="agent-chat">
      {/* Header — online status + agent identity */}
      <header className="agent-header">
        <button
          onClick={() => router.back()}
          className="agent-header__back"
          aria-label="Back"
        >
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none">
            <path d="M19 12H5M12 19l-7-7 7-7" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/>
          </svg>
        </button>

        <div className="agent-header__identity">
          <div className="agent-header__avatar">
            {/* Agent sparkle icon */}
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none">
              <path d="M12 2l2.4 7.2L22 12l-7.6 2.8L12 22l-2.4-7.2L2 12l7.6-2.8L12 2z" stroke="var(--gold)" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/>
            </svg>
            {/* Online indicator */}
            <span className="agent-header__online" />
          </div>
          <div className="agent-header__text">
            <div className="agent-header__name">Veil Agent</div>
            <div className="agent-header__status">Online · Claude · x402</div>
          </div>
        </div>

        <button
          onClick={clearHistory}
          className="agent-header__action"
          title="Clear history"
        >
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none">
            <path d="M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/>
            <path d="M3 3v5h5" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/>
          </svg>
        </button>
      </header>

      {/* Messages area */}
      <div className="agent-messages">
        {messages.map((msg, i) => (
          <div key={i} className={`agent-bubble-row ${msg.role === 'user' ? 'agent-bubble-row--user' : 'agent-bubble-row--agent'}`}>
            {/* Agent avatar — only on agent messages */}
            {msg.role === 'agent' && (
              <div className="agent-bubble__avatar">
                <svg width="12" height="12" viewBox="0 0 24 24" fill="none">
                  <path d="M12 2l2.4 7.2L22 12l-7.6 2.8L12 22l-2.4-7.2L2 12l7.6-2.8L12 2z" stroke="var(--lilac)" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/>
                </svg>
              </div>
            )}

            <div className={`agent-bubble ${msg.role === 'user' ? 'agent-bubble--user' : 'agent-bubble--agent'}`}>
              <div
                className="agent-bubble__content"
                dangerouslySetInnerHTML={{ __html: renderAgentMarkup(msg.content) }}
              />

              {/* Transaction approval card — inline, passkey-gated */}
              {msg.pendingTxXdr && (
                <div className="agent-tx-card">
                  <div className="agent-tx-card__header">
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none">
                      <rect x="3" y="11" width="18" height="11" rx="2" ry="2" stroke="var(--gold)" strokeWidth="2"/>
                      <path d="M7 11V7a5 5 0 0 1 10 0v4" stroke="var(--gold)" strokeWidth="2" strokeLinecap="round"/>
                    </svg>
                    <span className="agent-tx-card__label">Transaction ready</span>
                  </div>
                  {msg.pendingTxSummary && (
                    <div className="agent-tx-card__summary">
                      {msg.pendingTxSummary}
                    </div>
                  )}
                  <button
                    onClick={approveTransaction}
                    disabled={approving}
                    className="agent-tx-card__btn"
                  >
                    {approving ? (
                      <>
                        <span className="spinner" style={{ width: '14px', height: '14px' }} />
                        Verifying…
                      </>
                    ) : (
                      <>
                        <svg width="14" height="14" viewBox="0 0 24 24" fill="none">
                          <rect x="3" y="11" width="18" height="11" rx="2" ry="2" stroke="currentColor" strokeWidth="2"/>
                          <path d="M7 11V7a5 5 0 0 1 10 0v4" stroke="currentColor" strokeWidth="2" strokeLinecap="round"/>
                        </svg>
                        Approve &amp; Submit
                      </>
                    )}
                  </button>
                </div>
              )}
            </div>
          </div>
        ))}

        {/* Thinking dots */}
        {isThinking && (
          <div className="agent-bubble-row agent-bubble-row--agent">
            <div className="agent-bubble__avatar">
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none">
                <path d="M12 2l2.4 7.2L22 12l-7.6 2.8L12 22l-2.4-7.2L2 12l7.6-2.8L12 2z" stroke="var(--lilac)" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/>
              </svg>
            </div>
            <div className="agent-bubble agent-bubble--agent agent-bubble--thinking">
              {[0, 150, 300].map((delay) => (
                <span key={delay} className="agent-thinking-dot" style={{ animationDelay: `${delay}ms` }} />
              ))}
            </div>
          </div>
        )}

        <div ref={bottomRef} />
      </div>

      {/* Input area — suggestion chips + rounded input bar */}
      <div className="agent-input-area">
        {/* Suggestion chips — role-aware, horizontally scrollable */}
        <div className="agent-chips">
          {suggestions.map((s) => (
            <button
              key={s}
              className="agent-chip"
              onClick={() => { setInput(s); inputRef.current?.focus() }}
            >
              {s}
            </button>
          ))}
        </div>

        {/* Rounded input bar */}
        <div className="agent-input-bar">
          <input
            ref={inputRef}
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder="Ask me anything…"
            disabled={isThinking}
            className="agent-input"
          />
          <button
            onClick={sendMessage}
            disabled={!input.trim() || isThinking}
            className={`agent-send ${!input.trim() || isThinking ? 'agent-send--disabled' : ''}`}
            aria-label="Send message"
          >
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none">
              <path d="M22 2L11 13M22 2L15 22l-4-9-9-4 20-7z" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/>
            </svg>
          </button>
        </div>
      </div>

      <style>{`
        @keyframes agentBounce {
          0%, 80%, 100% { transform: translateY(0); opacity: 0.35; }
          40% { transform: translateY(-5px); opacity: 1; }
        }
      `}</style>
    </div>
  )
}
