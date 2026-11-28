'use client'

/**
 * Assistant allowance.
 *
 * This page used to show a per-transaction and a daily limit that were saved
 * in the browser and read by nothing. It now shows the real thing: an
 * allowance granted on chain, which the wallet contract itself enforces
 * (lib/assistantAllowance.ts), and the top-ups the assistant pays from it
 * (lib/assistantTopUp.ts).
 */
import { useCallback, useEffect, useState } from 'react'
import { useRouter } from 'next/navigation'

import { useInactivityLock } from '@/hooks/useInactivityLock'
import {
  ALLOWANCE_DAY_CHOICES,
  grantAssistantAllowance,
  grantProblem,
  readAssistantAllowance,
  stopAssistantAllowance,
  unitsToUsdc,
  type AssistantAllowance,
} from '@/lib/assistantAllowance'
import {
  afterProblem,
  afterSuccess,
  duePlans,
  loadPlans,
  newPlan,
  payTopUp,
  planProblem,
  savePlans,
  TOPUP_EVERY_DAYS,
  type TopUpPlan,
} from '@/lib/assistantTopUp'
import { isNairaNetwork } from '@/lib/ngn'
import { detectNetwork, MOBILE_NETWORKS } from '@/lib/nigerianNetworks'
import { walletSession } from '@/lib/walletStorage'

const label: React.CSSProperties = { fontSize: '0.8125rem', color: 'var(--warm-grey)', display: 'block', marginBottom: '0.5rem' }
const small: React.CSSProperties = { fontSize: '0.75rem', color: 'rgba(214,210,196,0.6)', lineHeight: 1.5 }
const heading: React.CSSProperties = { fontSize: '0.75rem', fontFamily: 'Anton, Impact, sans-serif', letterSpacing: '0.08em', color: 'var(--warm-grey)', marginBottom: '0.9rem' }
const mono: React.CSSProperties = { fontFamily: 'Inconsolata, monospace', fontSize: '0.75rem', wordBreak: 'break-all', opacity: 0.75 }

const every = (days: number) => (days === 1 ? 'Every day' : days === 7 ? 'Every week' : 'Every 30 days')
const when = (ms: number) => new Date(ms).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' })
const message = (e: unknown) => (e instanceof Error ? e.message : String(e))

type Notice = { text: string; ok: boolean; hash?: string } | null

export default function AssistantAllowancePage() {
  const router = useRouter()
  useInactivityLock()

  const [wallet, setWallet] = useState<string | null>(null)
  const [allowance, setAllowance] = useState<AssistantAllowance | null | undefined>(undefined)
  const [loadProblem, setLoadProblem] = useState<string | null>(null)
  const [amount, setAmount] = useState('5')
  const [days, setDays] = useState<number>(7)
  const [busy, setBusy] = useState<string | null>(null)
  const [notice, setNotice] = useState<Notice>(null)

  const [plans, setPlans] = useState<TopUpPlan[]>([])
  const [phone, setPhone] = useState('')
  const [network, setNetwork] = useState(MOBILE_NETWORKS[0])
  const [ngn, setNgn] = useState('100')
  const [everyDays, setEveryDays] = useState<number>(7)

  const refresh = useCallback(async (address: string) => {
    try {
      setAllowance(await readAssistantAllowance(address))
      setLoadProblem(null)
    } catch (e) {
      // Not shown as "no allowance": the chain could not be read.
      setLoadProblem(`Could not read the allowance from the network. ${message(e)}`)
    }
  }, [])

  useEffect(() => {
    const address = walletSession.getItem('invisible_wallet_address')
    if (!address) { router.replace('/lock'); return }
    setWallet(address)
    setPlans(loadPlans(window.localStorage, address))
    void refresh(address)
  }, [router, refresh])

  const keepPlans = useCallback((next: TopUpPlan[]) => {
    if (!wallet) return
    savePlans(window.localStorage, wallet, next)
    setPlans(next)
  }, [wallet])

  const grant = async () => {
    if (!wallet) return
    const problem = grantProblem(amount, days)
    if (problem) { setNotice({ text: problem, ok: false }); return }
    setBusy('grant'); setNotice(null)
    try {
      const hash = await grantAssistantAllowance(wallet, amount, days, window.localStorage)
      setNotice({ text: `The assistant can now spend up to ${amount} USDC for ${days} day${days === 1 ? '' : 's'}.`, ok: true, hash })
      await refresh(wallet)
    } catch (e) {
      setNotice({ text: message(e), ok: false })
    } finally { setBusy(null) }
  }

  const stop = async () => {
    if (!wallet) return
    setBusy('stop'); setNotice(null)
    try {
      const hash = await stopAssistantAllowance(wallet)
      setNotice({ text: 'Stopped. The wallet will refuse any further payment from the allowance.', ok: true, hash })
      await refresh(wallet)
    } catch (e) {
      setNotice({ text: message(e), ok: false })
    } finally { setBusy(null) }
  }

  const addPlan = () => {
    const amountNgn = Number(ngn)
    const problem = planProblem(phone, network, amountNgn, everyDays)
    if (problem) { setNotice({ text: problem, ok: false }); return }
    const id = `${Date.now().toString(36)}-${Math.floor(Math.random() * 1e6).toString(36)}`
    keepPlans([...plans, newPlan(phone, network, amountNgn, everyDays, Date.now(), id)])
    setPhone('')
    setNotice({ text: 'Top-up saved. Press "Pay now" for the first one. After that it is paid when it falls due and you open this page.', ok: true })
  }

  const run = useCallback(async (plan: TopUpPlan, current: TopUpPlan[]): Promise<TopUpPlan[]> => {
    if (!wallet) return current
    setBusy(plan.id); setNotice(null)
    try {
      const done = await payTopUp(wallet, plan)
      setNotice({
        text: `Paid ₦${plan.amountNgn.toLocaleString('en-US')} of ${plan.network} airtime to ${plan.phone} with ${done.spentUsdc} USDC from the allowance.`,
        ok: true,
        hash: done.drawHash,
      })
      return current.map((p) => (p.id === plan.id ? afterSuccess(p, Date.now(), done.orderId) : p))
    } catch (e) {
      setNotice({ text: message(e), ok: false })
      return current.map((p) => (p.id === plan.id ? afterProblem(p, Date.now(), message(e)) : p))
    } finally {
      setBusy(null)
      void refresh(wallet)
    }
  }, [wallet, refresh])

  // Pay whatever has fallen due, one at a time, once per visit.
  const [ranDue, setRanDue] = useState(false)
  useEffect(() => {
    if (ranDue || !wallet || !allowance?.usable) return
    setRanDue(true)
    // A plan made in this visit is paid with the button, not behind the
    // person's back a second after they saved it.
    const due = duePlans(plans, Date.now()).filter((p) => p.lastRunAt !== undefined || p.lastProblem !== undefined)
    if (due.length === 0) return
    void (async () => {
      let current = plans
      for (const plan of due) current = await run(plan, current)
      keepPlans(current)
    })()
  }, [ranDue, wallet, allowance, plans, run, keepPlans])

  const payNow = async (plan: TopUpPlan) => keepPlans(await run(plan, plans))

  return (
    <div className="wallet-shell">
      <header className="wallet-nav">
        <button
          onClick={() => router.back()}
          aria-label="Back"
          style={{ background: 'none', border: 'none', cursor: 'pointer', padding: '0.25rem', color: 'var(--warm-grey)', display: 'flex' }}
        >
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" aria-hidden="true">
            <path d="M19 12H5M12 19l-7-7 7-7" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/>
          </svg>
        </button>
        <span style={{ fontWeight: 600, fontSize: '0.9375rem' }}>Assistant allowance</span>
        <div style={{ width: '28px' }} />
      </header>

      <main className="wallet-main" style={{ display: 'flex', flexDirection: 'column', gap: '1rem' }}>
        <div className="card">
          <p style={{ fontSize: '0.9375rem', fontWeight: 600, marginBottom: '0.5rem' }}>Let the assistant pay small amounts for you</p>
          <p style={small}>
            You approve an amount of USDC once, with your passkey. After that the assistant can pay from it
            without asking each time. Your wallet itself enforces the limit: it refuses anything over the
            amount, and everything after the end date. The rest of your money cannot be touched this way.
          </p>
        </div>

        {notice && (
          <div className="card" role={notice.ok ? 'status' : 'alert'} style={{ borderColor: notice.ok ? 'rgba(253,218,36,0.35)' : 'rgba(220,38,38,0.5)' }}>
            <p style={{ fontSize: '0.875rem', lineHeight: 1.5 }}>{notice.text}</p>
            {notice.hash && <p style={{ ...mono, marginTop: '0.5rem' }}>Transaction {notice.hash}</p>}
          </div>
        )}

        <div className="card">
          <div style={heading}>THE ALLOWANCE</div>
          {loadProblem && <p role="alert" style={{ ...small, color: 'rgba(248,113,113,0.95)' }}>{loadProblem}</p>}
          {!loadProblem && allowance === undefined && <p style={small}>Reading it from the network…</p>}
          {!loadProblem && allowance === null && <p style={small}>The assistant has no allowance. It cannot pay for anything on its own.</p>}
          {!loadProblem && allowance && (
            <div style={{ marginBottom: '1rem' }}>
              <p style={{ fontSize: '1.5rem', fontWeight: 600 }}>
                {allowance.usable ? `${unitsToUsdc(allowance.remaining)} USDC left` : 'Not active'}
              </p>
              <p style={small}>
                {allowance.status === 'expired' && 'It has ended. The wallet refuses payments from it.'}
                {allowance.status === 'used-up' && 'It is used up. The wallet refuses payments from it.'}
                {allowance.usable && allowance.expiry !== null && `Ends ${when(Number(allowance.expiry) * 1000)}.`}
                {allowance.usable && allowance.expiry === null && 'It has no end date.'}
              </p>
            </div>
          )}

          <label style={label} htmlFor="allow-amount">Amount (USDC)</label>
          <input id="allow-amount" className="input-field" inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value)} />
          <label style={{ ...label, marginTop: '1rem' }} htmlFor="allow-days">Lasts for</label>
          <select id="allow-days" className="input-field" value={days} onChange={(e) => setDays(Number(e.target.value))}>
            {ALLOWANCE_DAY_CHOICES.map((d) => <option key={d} value={d}>{d === 1 ? '1 day' : `${d} days`}</option>)}
          </select>
          <p style={{ ...small, marginTop: '0.6rem' }}>
            A new allowance replaces the one before it. It does not add to it.
          </p>
          <button className="btn-gold" style={{ marginTop: '1rem', width: '100%' }} onClick={grant} disabled={busy !== null}>
            {busy === 'grant' ? 'Waiting for your passkey…' : allowance?.usable ? 'Replace the allowance' : 'Give the allowance'}
          </button>
          {allowance?.usable && (
            <button className="btn-ghost" style={{ marginTop: '0.5rem', width: '100%' }} onClick={stop} disabled={busy !== null}>
              {busy === 'stop' ? 'Waiting for your passkey…' : 'Stop it now'}
            </button>
          )}
          <p style={{ ...small, marginTop: '0.8rem' }}>
            Stopping needs your passkey. A stopped or ended allowance stays listed under Spending permissions:
            this wallet cannot delete one, only make it unusable.
          </p>
        </div>

        <div className="card">
          <div style={heading}>AIRTIME TOP-UPS</div>
          {!isNairaNetwork() && <p style={small}>Airtime is available on mainnet only.</p>}
          {plans.length === 0 && <p style={small}>No top-ups yet.</p>}
          {plans.map((plan) => (
            <div key={plan.id} style={{ borderTop: '1px solid var(--border-dim)', padding: '0.8rem 0' }}>
              <p style={{ fontSize: '0.9375rem', fontWeight: 600 }}>
                ₦{plan.amountNgn.toLocaleString('en-US')} · {plan.network} · {plan.phone}
              </p>
              <p style={small}>
                {every(plan.everyDays)}. {plan.nextRunAt <= Date.now() ? 'Due now.' : `Next ${when(plan.nextRunAt)}.`}
                {plan.lastRunAt ? ` Last paid ${when(plan.lastRunAt)}.` : ''}
              </p>
              {plan.lastProblem && <p role="alert" style={{ ...small, color: 'rgba(248,113,113,0.95)' }}>Last attempt: {plan.lastProblem}</p>}
              <div style={{ display: 'flex', gap: '0.5rem', marginTop: '0.5rem' }}>
                <button className="btn-gold" onClick={() => void payNow(plan)} disabled={busy !== null || !allowance?.usable}>
                  {busy === plan.id ? 'Paying…' : 'Pay now'}
                </button>
                <button className="btn-ghost" onClick={() => keepPlans(plans.filter((p) => p.id !== plan.id))} disabled={busy !== null}>
                  Remove
                </button>
              </div>
            </div>
          ))}

          <div style={{ borderTop: '1px solid var(--border-dim)', marginTop: '0.5rem', paddingTop: '1rem' }}>
            <label style={label} htmlFor="plan-phone">Phone number</label>
            <input
              id="plan-phone" className="input-field" inputMode="numeric" autoComplete="off" value={phone}
              onChange={(e) => { setPhone(e.target.value); const n = detectNetwork(e.target.value); if (n) setNetwork(n) }}
            />
            <label style={{ ...label, marginTop: '1rem' }} htmlFor="plan-network">Network</label>
            <select id="plan-network" className="input-field" value={network} onChange={(e) => setNetwork(e.target.value)}>
              {MOBILE_NETWORKS.map((n) => <option key={n} value={n}>{n}</option>)}
            </select>
            <label style={{ ...label, marginTop: '1rem' }} htmlFor="plan-amount">Amount (₦)</label>
            <input id="plan-amount" className="input-field" inputMode="numeric" value={ngn} onChange={(e) => setNgn(e.target.value)} />
            <label style={{ ...label, marginTop: '1rem' }} htmlFor="plan-every">How often</label>
            <select id="plan-every" className="input-field" value={everyDays} onChange={(e) => setEveryDays(Number(e.target.value))}>
              {TOPUP_EVERY_DAYS.map((d) => <option key={d} value={d}>{every(d)}</option>)}
            </select>
            <button className="btn-ghost" style={{ marginTop: '1rem', width: '100%' }} onClick={addPlan} disabled={busy !== null}>
              Add this top-up
            </button>
          </div>
          <p style={{ ...small, marginTop: '0.8rem' }}>
            A top-up that has fallen due is paid when you open this page with your wallet unlocked. Nothing
            runs while the wallet is closed, and no key leaves this device. The list is kept in this browser only.
          </p>
        </div>

        <button className="btn-ghost" onClick={() => router.push('/settings/allowances')}>
          See all spending permissions
        </button>
      </main>
    </div>
  )
}
