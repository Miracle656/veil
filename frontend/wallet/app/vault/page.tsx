'use client'

import { FormEvent, useCallback, useEffect, useMemo, useState } from 'react'
import { Keypair } from '@stellar/stellar-sdk'
import { useRouter } from 'next/navigation'

import { ThemeToggle } from '@/components/ThemeToggle'
import { VeilMark } from '@/components/ui/VeilMark'
import { useInactivityLock } from '@/hooks/useInactivityLock'
import { requirePasskey } from '@/lib/passkeyAuth'
import { beginTx, endTx } from '@/lib/txState'
import {
  cancelVaultWithdrawal,
  deployAndInitializeVault,
  depositToVault,
  executeVaultWithdrawal,
  fetchVaultDetails,
  queueVaultWithdrawal,
  type VaultDetails,
  type VaultWithdrawal,
} from '@/lib/vault'
import { walletLocal, walletSession } from '@/lib/walletStorage'

const VAULT_STORAGE_KEY = 'veil_vault_contract'

type DelayUnit = 'hours' | 'days'

function getStoredSignerSecret(): string | null {
  return walletSession.getItem('veil_signer_secret')
    || walletLocal.getItem('veil_signer_secret')
}

function formatDelay(seconds: number): string {
  if (seconds % 86_400 === 0) {
    const days = seconds / 86_400
    return `${days} day${days === 1 ? '' : 's'}`
  }
  if (seconds % 3_600 === 0) {
    const hours = seconds / 3_600
    return `${hours} hour${hours === 1 ? '' : 's'}`
  }
  return `${seconds.toLocaleString()} seconds`
}

function formatTimestamp(timestamp: number): string {
  return new Date(timestamp * 1_000).toLocaleString()
}

function formatCountdown(unlockAt: number, now: number): string {
  const remaining = Math.max(0, unlockAt - now)
  if (remaining === 0) return 'Ready to execute'

  const days = Math.floor(remaining / 86_400)
  const hours = Math.floor((remaining % 86_400) / 3_600)
  const minutes = Math.floor((remaining % 3_600) / 60)
  const seconds = remaining % 60

  if (days > 0) return `${days}d ${hours}h ${minutes}m`
  if (hours > 0) return `${hours}h ${minutes}m ${seconds}s`
  return `${minutes}m ${seconds}s`
}

function withdrawalStatus(withdrawal: VaultWithdrawal, now: number): string {
  if (withdrawal.executed) return 'Executed'
  if (withdrawal.cancelled) return 'Cancelled'
  if (now >= withdrawal.unlockAt) return 'Ready'
  return 'Time-locked'
}

export default function VaultPage() {
  const router = useRouter()
  useInactivityLock()

  const [contractId, setContractId] = useState<string | null>(null)
  const [details, setDetails] = useState<VaultDetails | null>(null)
  const [loading, setLoading] = useState(false)
  const [action, setAction] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const [now, setNow] = useState(() => Math.floor(Date.now() / 1_000))

  const [delayValue, setDelayValue] = useState('24')
  const [delayUnit, setDelayUnit] = useState<DelayUnit>('hours')
  const [existingContract, setExistingContract] = useState('')
  const [depositAmount, setDepositAmount] = useState('')
  const [recipient, setRecipient] = useState('')
  const [withdrawalAmount, setWithdrawalAmount] = useState('')

  useEffect(() => {
    const walletAddress = walletSession.getItem('invisible_wallet_address')
    if (!walletAddress) {
      router.replace('/lock')
      return
    }

    const storedContract = localStorage.getItem(VAULT_STORAGE_KEY)
    if (storedContract) setContractId(storedContract)
  }, [router])

  useEffect(() => {
    const timer = window.setInterval(
      () => setNow(Math.floor(Date.now() / 1_000)),
      1_000,
    )
    return () => window.clearInterval(timer)
  }, [])

  const loadDetails = useCallback(async (address?: string) => {
    const target = address || contractId
    if (!target) return

    setLoading(true)
    setError(null)
    try {
      const next = await fetchVaultDetails(target)
      setDetails(next)
    } catch (cause: unknown) {
      setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setLoading(false)
    }
  }, [contractId])

  useEffect(() => {
    if (contractId) void loadDetails()
  }, [contractId, loadDetails])

  const activeSigner = useMemo(() => {
    if (typeof window === 'undefined') return null
    const secret = getStoredSignerSecret()
    if (!secret) return null
    try {
      return Keypair.fromSecret(secret).publicKey()
    } catch {
      return null
    }
  }, [])

  const isOwner = !!details && details.config.owner === activeSigner

  async function confirmOwnerAction(): Promise<void> {
    const keyId = walletLocal.getItem('invisible_wallet_key_id')
    if (keyId && keyId !== 'recovery') {
      await requirePasskey()
    }
  }

  async function runAction(
    name: string,
    operation: () => Promise<string>,
    ownerAction = false,
  ): Promise<boolean> {
    beginTx()
    setAction(name)
    setError(null)
    setNotice(null)
    try {
      if (ownerAction) await confirmOwnerAction()
      const hash = await operation()
      setNotice(`Transaction confirmed: ${hash.slice(0, 12)}...`)
      await loadDetails()
      return true
    } catch (cause: unknown) {
      const message = cause instanceof Error ? cause.message : String(cause)
      setError(
        message.includes('NotAllowedError')
          ? 'Passkey verification was cancelled.'
          : message,
      )
      return false
    } finally {
      setAction(null)
      endTx()
    }
  }

  async function handleDeploy(): Promise<void> {
    const parsedDelay = Number(delayValue)
    if (!Number.isSafeInteger(parsedDelay) || parsedDelay <= 0) {
      setError('Enter a positive whole-number withdrawal delay.')
      return
    }

    const multiplier = delayUnit === 'days' ? 86_400 : 3_600
    await runAction('deploy', async () => {
      const address = await deployAndInitializeVault({
        delaySeconds: parsedDelay * multiplier,
      })
      localStorage.setItem(VAULT_STORAGE_KEY, address)
      setContractId(address)
      return address
    }, true)
  }

  async function handleAttach(): Promise<void> {
    setAction('attach')
    setError(null)
    try {
      const next = await fetchVaultDetails(existingContract)
      localStorage.setItem(VAULT_STORAGE_KEY, next.contractId)
      setDetails(next)
      setContractId(next.contractId)
      setExistingContract('')
    } catch (cause: unknown) {
      setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setAction(null)
    }
  }

  async function handleDeposit(event: FormEvent): Promise<void> {
    event.preventDefault()
    if (!contractId) return

    const succeeded = await runAction('deposit', () => depositToVault({
      contractId,
      amountXlm: depositAmount,
    }), true)
    if (succeeded) setDepositAmount('')
  }

  async function handleQueue(event: FormEvent): Promise<void> {
    event.preventDefault()
    if (!contractId) return

    const succeeded = await runAction('queue', () => queueVaultWithdrawal({
      contractId,
      to: recipient,
      amountXlm: withdrawalAmount,
    }), true)
    if (succeeded) {
      setRecipient('')
      setWithdrawalAmount('')
    }
  }

  function forgetVault(): void {
    if (!window.confirm('Remove this vault from this device? Funds remain on-chain.')) return
    localStorage.removeItem(VAULT_STORAGE_KEY)
    setContractId(null)
    setDetails(null)
    setNotice(null)
    setError(null)
  }

  return (
    <div className="wallet-shell">
      <nav className="wallet-nav">
        <button
          onClick={() => router.push('/dashboard')}
          style={navButtonStyle}
        >
          <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
            <path d="M10 3L5 8l5 5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/>
          </svg>
          Dashboard
        </button>
        <VeilMark size={22} />
        <ThemeToggle />
      </nav>

      <main className="wallet-main" style={{ paddingBottom: '3rem' }}>
        <div style={{ marginBottom: '1.5rem' }}>
          <p style={eyebrowStyle}>TIME-LOCKED SUB-ACCOUNT</p>
          <h1 style={headingStyle}>Vault</h1>
          <p style={descriptionStyle}>
            Hold XLM behind a withdrawal delay. Every transfer must be queued,
            remains cancellable, and can execute only after its timer expires.
          </p>
        </div>

        {error && (
          <div style={errorStyle}>{error}</div>
        )}
        {notice && (
          <div style={noticeStyle}>{notice}</div>
        )}

        {!contractId ? (
          <div style={{ display: 'flex', flexDirection: 'column', gap: '1rem' }}>
            <section className="card">
              <h2 style={sectionHeadingStyle}>Create a vault</h2>
              <p style={sectionCopyStyle}>
                The active Stellar account becomes the owner. The delay is fixed
                for this vault after deployment.
              </p>

              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '0.75rem', marginTop: '1rem' }}>
                <div>
                  <label style={labelStyle}>DELAY</label>
                  <input
                    className="input-field"
                    type="number"
                    min="1"
                    step="1"
                    value={delayValue}
                    onChange={(event) => setDelayValue(event.target.value)}
                  />
                </div>
                <div>
                  <label style={labelStyle}>UNIT</label>
                  <select
                    className="input-field"
                    value={delayUnit}
                    onChange={(event) => setDelayUnit(event.target.value as DelayUnit)}
                    style={{ background: 'var(--surface)' }}
                  >
                    <option value="hours">Hours</option>
                    <option value="days">Days</option>
                  </select>
                </div>
              </div>

              <button
                className="btn-gold"
                onClick={handleDeploy}
                disabled={action !== null}
                style={{ marginTop: '1rem' }}
              >
                {action === 'deploy' ? 'Deploying vault...' : 'Deploy vault'}
              </button>
            </section>

            <section className="card">
              <h2 style={sectionHeadingStyle}>Use an existing vault</h2>
              <p style={sectionCopyStyle}>
                Attach a vault already deployed on the selected Stellar network.
              </p>
              <input
                className="input-field mono"
                value={existingContract}
                onChange={(event) => setExistingContract(event.target.value.trim())}
                placeholder="C..."
                style={{ marginTop: '1rem' }}
              />
              <button
                className="btn-ghost"
                onClick={handleAttach}
                disabled={action !== null || existingContract.length === 0}
                style={{ marginTop: '0.75rem' }}
              >
                {action === 'attach' ? 'Checking vault...' : 'Attach vault'}
              </button>
            </section>
          </div>
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: '1rem' }}>
            <section className="card">
              <div style={{ display: 'flex', justifyContent: 'space-between', gap: '1rem', alignItems: 'flex-start' }}>
                <div style={{ minWidth: 0 }}>
                  <p style={labelStyle}>VAULT CONTRACT</p>
                  <p style={addressStyle}>{contractId}</p>
                </div>
                <button
                  onClick={forgetVault}
                  style={dangerLinkStyle}
                >
                  Remove
                </button>
              </div>

              {loading && !details ? (
                <div style={{ padding: '2rem 0', textAlign: 'center' }}>
                  <div className="spinner spinner-light" style={{ margin: '0 auto' }} />
                </div>
              ) : details && (
                <>
                  <div style={statsGridStyle}>
                    <Stat label="Total balance" value={`${details.balanceXlm} XLM`} />
                    <Stat label="Available" value={`${details.availableXlm} XLM`} />
                    <Stat label="Queued" value={`${details.reservedXlm} XLM`} />
                    <Stat label="Delay" value={formatDelay(details.config.delaySeconds)} />
                  </div>
                  <div style={{ marginTop: '1rem' }}>
                    <p style={labelStyle}>OWNER</p>
                    <p style={addressStyle}>{details.config.owner}</p>
                    {!isOwner && (
                      <p style={{ ...sectionCopyStyle, color: 'var(--teal)', marginTop: '0.5rem' }}>
                        This device is not using the owner account. Queue and cancel actions are disabled.
                      </p>
                    )}
                  </div>
                </>
              )}
            </section>

            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(260px, 1fr))', gap: '1rem' }}>
              <section className="card">
                <h2 style={sectionHeadingStyle}>Deposit XLM</h2>
                <p style={sectionCopyStyle}>Move XLM from the active account into this vault.</p>
                <form onSubmit={handleDeposit} style={{ marginTop: '1rem' }}>
                  <label style={labelStyle}>AMOUNT</label>
                  <input
                    className="input-field"
                    type="number"
                    min="0"
                    step="0.0000001"
                    value={depositAmount}
                    onChange={(event) => setDepositAmount(event.target.value)}
                    placeholder="0.00"
                  />
                  <button
                    className="btn-gold"
                    type="submit"
                    disabled={action !== null || !isOwner || depositAmount.length === 0}
                    style={{ marginTop: '0.75rem' }}
                  >
                    {action === 'deposit' ? 'Depositing...' : 'Deposit'}
                  </button>
                </form>
              </section>

              <section className="card">
                <h2 style={sectionHeadingStyle}>Queue withdrawal</h2>
                <p style={sectionCopyStyle}>The destination and amount cannot change after queueing.</p>
                <form onSubmit={handleQueue} style={{ marginTop: '1rem', display: 'flex', flexDirection: 'column', gap: '0.75rem' }}>
                  <div>
                    <label style={labelStyle}>DESTINATION</label>
                    <input
                      className="input-field mono"
                      value={recipient}
                      onChange={(event) => setRecipient(event.target.value.trim())}
                      placeholder="G... or C..."
                    />
                  </div>
                  <div>
                    <label style={labelStyle}>AMOUNT</label>
                    <input
                      className="input-field"
                      type="number"
                      min="0"
                      step="0.0000001"
                      value={withdrawalAmount}
                      onChange={(event) => setWithdrawalAmount(event.target.value)}
                      placeholder="0.00"
                    />
                  </div>
                  <button
                    className="btn-secondary"
                    type="submit"
                    disabled={
                      action !== null
                      || !isOwner
                      || recipient.length === 0
                      || withdrawalAmount.length === 0
                    }
                  >
                    {action === 'queue' ? 'Queueing...' : 'Queue withdrawal'}
                  </button>
                </form>
              </section>
            </div>

            <section>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '0.75rem' }}>
                <h2 style={sectionHeadingStyle}>Withdrawal queue</h2>
                <button
                  onClick={() => loadDetails()}
                  disabled={loading || action !== null}
                  style={refreshButtonStyle}
                >
                  {loading ? 'Refreshing...' : 'Refresh'}
                </button>
              </div>

              {!details || details.withdrawals.length === 0 ? (
                <div className="card" style={{ textAlign: 'center' }}>
                  <p style={sectionCopyStyle}>No withdrawals have been queued.</p>
                </div>
              ) : (
                <div style={{ display: 'flex', flexDirection: 'column', gap: '0.75rem' }}>
                  {details.withdrawals.map((withdrawal) => {
                    const pending = !withdrawal.cancelled && !withdrawal.executed
                    const ready = pending && now >= withdrawal.unlockAt
                    const status = withdrawalStatus(withdrawal, now)
                    const currentAction = action === `cancel-${withdrawal.id}`
                      || action === `execute-${withdrawal.id}`

                    return (
                      <article className="card" key={withdrawal.id}>
                        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: '0.75rem' }}>
                          <span style={idBadgeStyle}>Withdrawal #{withdrawal.id}</span>
                          <span style={{
                            ...statusBadgeStyle,
                            color: withdrawal.executed
                              ? 'var(--teal)'
                              : withdrawal.cancelled
                                ? 'rgba(246,247,248,0.4)'
                                : ready
                                  ? 'var(--gold)'
                                  : 'var(--off-white)',
                          }}>
                            {status}
                          </span>
                        </div>

                        <div style={{ display: 'grid', gap: '0.75rem', marginTop: '1rem' }}>
                          <InfoRow label="Amount" value={`${withdrawal.amountXlm} XLM`} />
                          <InfoRow label="Destination" value={withdrawal.to} mono />
                          <InfoRow label="Queued" value={formatTimestamp(withdrawal.queuedAt)} />
                          <InfoRow
                            label="Unlocks"
                            value={pending
                              ? `${formatTimestamp(withdrawal.unlockAt)} (${formatCountdown(withdrawal.unlockAt, now)})`
                              : formatTimestamp(withdrawal.unlockAt)}
                          />
                        </div>

                        {pending && (
                          <div style={{ display: 'grid', gridTemplateColumns: ready ? '1fr 1fr' : '1fr', gap: '0.75rem', marginTop: '1rem' }}>
                            <button
                              className="btn-ghost"
                              disabled={action !== null || !isOwner}
                              onClick={() => runAction(
                                `cancel-${withdrawal.id}`,
                                () => cancelVaultWithdrawal({
                                  contractId,
                                  withdrawalId: withdrawal.id,
                                }),
                                true,
                              )}
                            >
                              {action === `cancel-${withdrawal.id}` ? 'Cancelling...' : 'Cancel'}
                            </button>
                            {ready && (
                              <button
                                className="btn-secondary"
                                disabled={action !== null}
                                onClick={() => runAction(
                                  `execute-${withdrawal.id}`,
                                  () => executeVaultWithdrawal({
                                    contractId,
                                    withdrawalId: withdrawal.id,
                                  }),
                                )}
                              >
                                {action === `execute-${withdrawal.id}` ? 'Executing...' : 'Execute'}
                              </button>
                            )}
                          </div>
                        )}

                        {currentAction && (
                          <p style={{ ...sectionCopyStyle, marginTop: '0.75rem', textAlign: 'center' }}>
                            Waiting for Stellar confirmation...
                          </p>
                        )}
                      </article>
                    )
                  })}
                </div>
              )}
            </section>
          </div>
        )}
      </main>
    </div>
  )
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <p style={labelStyle}>{label.toUpperCase()}</p>
      <p style={{ fontFamily: 'Inconsolata, monospace', fontSize: '1rem', marginTop: '0.25rem' }}>{value}</p>
    </div>
  )
}

function InfoRow({ label, value, mono = false }: { label: string; value: string; mono?: boolean }) {
  return (
    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: '1rem' }}>
      <span style={{ fontSize: '0.75rem', color: 'rgba(246,247,248,0.4)', flexShrink: 0 }}>{label}</span>
      <span style={{
        fontSize: '0.8125rem',
        fontFamily: mono ? 'Inconsolata, monospace' : 'Inter, sans-serif',
        textAlign: 'right',
        wordBreak: 'break-all',
      }}>
        {value}
      </span>
    </div>
  )
}

const navButtonStyle = {
  background: 'none',
  border: 'none',
  cursor: 'pointer',
  color: 'var(--off-white)',
  display: 'flex',
  alignItems: 'center',
  gap: '0.375rem',
  fontSize: '0.875rem',
}

const eyebrowStyle = {
  fontSize: '0.6875rem',
  fontFamily: 'Anton, Impact, sans-serif',
  color: 'var(--gold)',
  letterSpacing: '0.1em',
  marginBottom: '0.5rem',
}

const headingStyle = {
  fontFamily: 'Lora, Georgia, serif',
  fontWeight: 600,
  fontStyle: 'italic',
  fontSize: '1.75rem',
}

const descriptionStyle = {
  fontSize: '0.875rem',
  color: 'rgba(246,247,248,0.5)',
  lineHeight: 1.6,
  marginTop: '0.5rem',
}

const sectionHeadingStyle = {
  fontFamily: 'Lora, Georgia, serif',
  fontWeight: 600,
  fontStyle: 'italic',
  fontSize: '1.125rem',
}

const sectionCopyStyle = {
  fontSize: '0.8125rem',
  color: 'rgba(246,247,248,0.45)',
  lineHeight: 1.5,
  marginTop: '0.375rem',
}

const labelStyle = {
  display: 'block',
  fontSize: '0.6875rem',
  fontFamily: 'Anton, Impact, sans-serif',
  color: 'rgba(246,247,248,0.4)',
  letterSpacing: '0.07em',
  marginBottom: '0.375rem',
}

const addressStyle = {
  fontFamily: 'Inconsolata, monospace',
  fontSize: '0.75rem',
  color: 'var(--gold)',
  wordBreak: 'break-all' as const,
}

const statsGridStyle = {
  display: 'grid',
  gridTemplateColumns: 'repeat(auto-fit, minmax(120px, 1fr))',
  gap: '1rem',
  marginTop: '1.25rem',
  padding: '1rem',
  borderRadius: '12px',
  background: 'rgba(255,255,255,0.02)',
  border: '1px solid var(--border-dim)',
}

const errorStyle = {
  padding: '0.875rem 1rem',
  marginBottom: '1rem',
  borderRadius: '12px',
  background: 'rgba(255,100,100,0.08)',
  border: '1px solid rgba(255,100,100,0.2)',
  color: 'rgb(255,140,140)',
  fontSize: '0.8125rem',
}

const noticeStyle = {
  padding: '0.875rem 1rem',
  marginBottom: '1rem',
  borderRadius: '12px',
  background: 'rgba(0,167,181,0.08)',
  border: '1px solid rgba(0,167,181,0.2)',
  color: 'var(--teal)',
  fontSize: '0.8125rem',
}

const dangerLinkStyle = {
  background: 'none',
  border: 'none',
  color: 'rgb(255,130,130)',
  fontSize: '0.75rem',
  cursor: 'pointer',
}

const refreshButtonStyle = {
  background: 'none',
  border: 'none',
  color: 'var(--gold)',
  fontSize: '0.75rem',
  cursor: 'pointer',
}

const idBadgeStyle = {
  fontSize: '0.6875rem',
  fontWeight: 600,
  padding: '0.25rem 0.625rem',
  borderRadius: '100px',
  background: 'rgba(246,247,248,0.07)',
}

const statusBadgeStyle = {
  fontSize: '0.75rem',
  fontWeight: 600,
}
