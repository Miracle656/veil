'use client'

import { useEffect, useState, useCallback } from 'react'
import { useRouter } from 'next/navigation'
import Link from 'next/link'
import {
  Keypair,
  Contract,
  Account,
  TransactionBuilder,
  BASE_FEE,
  rpc as SorobanRpc,
  nativeToScVal,
  scValToNative,
} from '@stellar/stellar-sdk'
import { network, getNativeAssetContractId } from '@/lib/network'

// Signer data returned by the wallet contract's get_signers.
// The contract stores the signer key as a 32-byte ed25519 public key and
// an optional per-key spend limit in stroops.
export interface SignerInfo {
  key: string
  spendLimitStroops: bigint | null
}

export interface SignersResult {
  signers: SignerInfo[]
}

// Decode the value returned by get_signers. The contract returns a
// Vec of tuples (key, spend_limit) where spend_limit is Option<u128>.
// We handle both the tuple and object shapes so the UI survives any
// serialization differences without lying about what the chain said.
export function decodeSigners(raw: unknown): SignerInfo[] {
  if (!Array.isArray(raw)) return []
  return raw.map((entry): SignerInfo => {
    let keyValue: unknown
    let limitValue: unknown = null
    if (Array.isArray(entry)) {
      keyValue = entry[0]
      limitValue = entry[1] ?? null
    } else if (entry && typeof entry === 'object') {
      const obj = entry as Record<string, unknown>
      keyValue = obj.key ?? obj.signer
      limitValue = obj.spend_limit ?? obj.spendLimit ?? null
    }
    return {
      key: normalizeKey(keyValue),
      spendLimitStroops: normalizeLimit(limitValue),
    }
  })
}

function normalizeKey(value: unknown): string {
  if (typeof value === 'string') return value
  if (value instanceof Uint8Array) return Buffer.from(value).toString('hex')
  if (Array.isArray(value)) return Buffer.from(value as number[]).toString('hex')
  return String(value)
}

function normalizeLimit(value: unknown): bigint | null {
  if (value === null || value === undefined) return null
  if (typeof value === 'bigint') return value
  if (typeof value === 'number') return BigInt(value)
  if (typeof value === 'string' && /^[0-9]+$/.test(value)) return BigInt(value)
  return null
}

// Removing the last signer would lock the wallet forever. The contract
// rejects it, but the UI must explain the reason before attempting anything.
export function canRemoveSigner(signers: SignerInfo[], key: string): {
  allowed: boolean
  reason?: string
} {
  if (!signers.some((s) => s.key === key)) {
    return { allowed: false, reason: 'This key is not a signer on this wallet.' }
  }
  if (signers.length <= 1) {
    return {
      allowed: false,
      reason:
        'This is the only signer. Removing it would lock the wallet and funds would be unrecoverable.',
    }
  }
  return { allowed: true }
}

export function formatSpendLimit(limitStroops: bigint | null): string {
  if (limitStroops === null) return 'Unlimited'
  const whole = limitStroops / 10_0000000n
  const frac = limitStroops % 10_0000000n
  return `${whole.toString()}.${frac.toString().padStart(7, '0')} XLM`
}

export default function DashboardPage() {
  const router = useRouter()

  const [address, setAddress] = useState<string | null>(null)
  const [xlmBalance, setXlmBalance] = useState<number | null>(null)
  const [loading, setLoading] = useState(true)
  const [copied, setCopied] = useState(false)

  const [signers, setSigners] = useState<SignerInfo[]>([])
  const [signersLoading, setSignersLoading] = useState(false)
  const [signersError, setSignersError] = useState<string | null>(null)
  const [newSignerKey, setNewSignerKey] = useState('')
  const [newSignerLimit, setNewSignerLimit] = useState('')
  const [pendingAction, setPendingAction] = useState<string | null>(null)
  const [actionError, setActionError] = useState<string | null>(null)

  const fetchBalance = useCallback(async (walletAddress: string) => {
    try {
      const rpcServer = new SorobanRpc.Server(network.rpcUrl)
      const sacAddress = getNativeAssetContractId()
      const sacContract = new Contract(sacAddress)

      // Use a dummy keypair — we're only simulating, not submitting
      const dummyKp = Keypair.random()
      const dummyAcct = new Account(dummyKp.publicKey(), '0')

      const tx = new TransactionBuilder(dummyAcct, {
        fee: BASE_FEE,
        networkPassphrase: network.networkPassphrase,
      })
        .addOperation(
          sacContract.call('balance', nativeToScVal(walletAddress, { type: 'address' }))
        )
        .setTimeout(30)
        .build()

      const sim = await rpcServer.simulateTransaction(tx)
      if (!SorobanRpc.Api.isSimulationError(sim)) {
        const result = (sim as SorobanRpc.Api.SimulateTransactionSuccessResponse).result
        if (result) {
          const stroops = scValToNative(result.retval) as bigint
          setXlmBalance(Number(stroops) / 10_0000000)
        } else {
          setXlmBalance(0)
        }
      } else {
        setXlmBalance(0)
      }
    } catch {
      setXlmBalance(0)
    } finally {
      setLoading(false)
    }
  }, [])

  const fetchSigners = useCallback(async (walletAddress: string) => {
    setSignersLoading(true)
    setSignersError(null)
    try {
      const rpcServer = new SorobanRpc.Server(network.rpcUrl)
      const walletContract = new Contract(walletAddress)
      const dummyKp = Keypair.random()
      const dummyAcct = new Account(dummyKp.publicKey(), '0')

      const tx = new TransactionBuilder(dummyAcct, {
        fee: BASE_FEE,
        networkPassphrase: network.networkPassphrase,
      })
        .addOperation(walletContract.call('get_signers'))
        .setTimeout(30)
        .build()

      const sim = await rpcServer.simulateTransaction(tx)
      if (SorobanRpc.Api.isSimulationError(sim)) {
        throw new Error('The wallet contract did not return its signers.')
      }
      const result = (sim as SorobanRpc.Api.SimulateTransactionSuccessResponse).result
      if (!result) {
        throw new Error('The wallet contract returned no signer data.')
      }
      const decoded = decodeSigners(scValToNative(result.retval))
      setSigners(decoded)
    } catch (err) {
      setSignersError(err instanceof Error ? err.message : 'Unable to load signers.')
    } finally {
      setSignersLoading(false)
    }
  }, [])

  useEffect(() => {
    const stored = localStorage.getItem('invisible_wallet_address')
    if (!stored) {
      router.replace('/')
      return
    }
    setAddress(stored)
    fetchBalance(stored)
    fetchSigners(stored)
  }, [router, fetchBalance, fetchSigners])

  function handleCopy() {
    if (!address) return
    navigator.clipboard.writeText(address)
    setCopied(true)
    setTimeout(() => setCopied(false), 2000)
  }

  function handleLogout() {
    localStorage.removeItem('invisible_wallet_address')
    localStorage.removeItem('invisible_wallet_key_id')
    localStorage.removeItem('invisible_wallet_public_key')
    localStorage.removeItem('veil_fee_payer_secret')
    router.replace('/')
  }

  // Add a signer to the wallet contract. The add_signer entry point takes
  // the signer's 32-byte ed25519 public key and an optional spend limit.
  async function handleAddSigner() {
    if (!address) return
    setActionError(null)
    const trimmed = newSignerKey.trim()
    if (!/^[0-9a-fA-F]{64}$/.test(trimmed)) {
      setActionError('Signer key must be a 64-character hex ed25519 public key.')
      return
    }
    if (signers.some((s) => s.key.toLowerCase() === trimmed.toLowerCase())) {
      setActionError('This key is already a signer on this wallet.')
      return
    }
    let limitStroops: bigint | null = null
    if (newSignerLimit.trim() !== '') {
      const parsed = Number(newSignerLimit)
      if (!Number.isFinite(parsed) || parsed < 0) {
        setActionError('Spend limit must be a non-negative number of XLM.')
        return
      }
      limitStroops = BigInt(Math.round(parsed * 10_000_000))
    }
    setPendingAction(`add:${trimmed.toLowerCase()}`)
    try {
      const rpcServer = new SorobanRpc.Server(network.rpcUrl)
      const walletContract = new Contract(address)
      const dummyKp = Keypair.random()
      const dummyAcct = new Account(dummyKp.publicKey(), '0')
      const limitScVal = limitStroops === null
        ? nativeToScVal(undefined, { type: 'u128' })
        : nativeToScVal(limitStroops, { type: 'u128' })
      const tx = new TransactionBuilder(dummyAcct, {
        fee: BASE_FEE,
        networkPassphrase: network.networkPassphrase,
      })
        .addOperation(
          walletContract.call(
            'add_signer',
            nativeToScVal(Buffer.from(trimmed, 'hex'), { type: 'bytes' }),
            limitScVal
          )
        )
        .setTimeout(30)
        .build()
      const sim = await rpcServer.simulateTransaction(tx)
      if (SorobanRpc.Api.isSimulationError(sim)) {
        throw new Error('The wallet contract rejected the new signer.')
      }
      setNewSignerKey('')
      setNewSignerLimit('')
      await fetchSigners(address)
    } catch (err) {
      setActionError(err instanceof Error ? err.message : 'Unable to add signer.')
    } finally {
      setPendingAction(null)
    }
  }

  // Remove a signer from the wallet contract. The last-signer guard runs
  // before we ever build a transaction, so the user gets the reason instead
  // of a contract failure.
  async function handleRemoveSigner(key: string) {
    if (!address) return
    setActionError(null)
    const guard = canRemoveSigner(signers, key)
    if (!guard.allowed) {
      setActionError(guard.reason ?? 'This signer cannot be removed.')
      return
    }
    setPendingAction(`remove:${key.toLowerCase()}`)
    try {
      const rpcServer = new SorobanRpc.Server(network.rpcUrl)
      const walletContract = new Contract(address)
      const dummyKp = Keypair.random()
      const dummyAcct = new Account(dummyKp.publicKey(), '0')
      const tx = new TransactionBuilder(dummyAcct, {
        fee: BASE_FEE,
        networkPassphrase: network.networkPassphrase,
      })
        .addOperation(
          walletContract.call(
            'remove_signer',
            nativeToScVal(Buffer.from(key, 'hex'), { type: 'bytes' })
          )
        )
        .setTimeout(30)
        .build()
      const sim = await rpcServer.simulateTransaction(tx)
      if (SorobanRpc.Api.isSimulationError(sim)) {
        throw new Error('The wallet contract rejected the signer removal.')
      }
      await fetchSigners(address)
    } catch (err) {
      setActionError(err instanceof Error ? err.message : 'Unable to remove signer.')
    } finally {
      setPendingAction(null)
    }
  }

  const shortAddress = address
    ? `${address.slice(0, 6)}…${address.slice(-6)}`
    : '—'

  const onlySigner = signers.length === 1

  return (
    <main className="flex min-h-screen flex-col flex-items-center justify-center gap-6 p-6">
      <div className="w-full max-w-sm space-4">
        <div className="flex items-center justify-between">
          <h1 className="text-xl font-bold">Dashboard</h1>
          <button
            onClick={handleLogout}
            className="text-xs text-gray-500 hover:text-gray-300 transition-colors"
          >
            Log out
          </button>
        </div>

        {/* Wallet address card */}
        <div className="rounded-2xl border border-gray-800 bg-gray-900 p-5 space-y-1">
          <p className="text-xs text-gray-500 uppercase tracking-wider">Wallet address</p>
          <button
            onClick={handleCopy}
            className="font-mono text-sm text-indigo-400 hover:text-indigo-300 transition-colors"
            title={address ?? ''}
          >
            {shortAddress} {copied ? '✓' : '⌘'}
          </button>
        </div>

        {/* Balance card */}
        <div className="rounded-2xl border border-gray-800 bg-gray-900 p-5 space-y-1">
          <p className="text-xs text-gray-500 uppercase tracking-wider">XLM balance</p>
          {loading ? (
            <p className="text-2xl font-bold text-gray-600 animate-pulse">—</p>
          ) : (
            <p className="text-2xl font-bold">
              {xlmBalance !== null ? xlmBalance.toFixed(7) : '0.0000000'}{' '}
              <span className="text-base font-normal text-gray-400">XLM</span>
            </p>
          )}
          <button
            onClick={() => address && fetchBalance(address)}
            className="text-xs text-gray-600 hover:text-gray-400 transition-colors"
          >
            Refresh
          </button>
        </div>

        {/* Signers card */}
        <div className="rounded-2xl border border-gray-800 bg-gray-900 p-5 space-y-3">
          <div className="flex items-center justify-between">
            <p className="text-xs text-gray-500 uppercase tracking-wider">Signers</p>
            <button
              onClick={() => address && fetchSigners(address)}
              className="text-xs text-gray-600 hover:text-gray-400 transition-colors"
            >
              Refresh
            </button>
          </div>

          {signersLoading ? (
            <p className="text-sm text-gray-600 animate-pulse">Loading signers…</p>
          ) : signersError ? (
            <p className="text-sm text-red-400">{signersError}</p>
          ) : signers.length === 0 ? (
            <p className="text-sm text-gray-600">No signers reported by the wallet contract.</p>
          ) : (
            <ul className="space-y-2">
              {signers.map((signer) => {
                const guard = canRemoveSigner(signers, signer.key)
                const isPending = pendingAction === `remove:${signer.key.toLowerCase()}`
                return (
                  <li
                    key={signer.key}
                    className="rounded-xl border border-gray-800 bg-black/30 p-3 space-y-1"
                  >
                    <div className="flex items-start justify-between gap-2">
                      <div className="min-w-0">
                        <p className="break-all font-mono text-xs text-gray-200">{signer.key}</p>
                        <p className="text-xs text-gray-500">
                          Spend limit: {formatSpendLimit(signer.spendLimitStroops)}
                        </p>
                      </div>
                      <button
                        onClick={() => handleRemoveSigner(signer.key)}
                        disabled={!guard.allowed || isPending}
                        title={guard.allowed ? 'Remove this signer' : guard.reason}
                        className="shrink-0 text-xs text-red-400 hover:text-red-300 disabled:text-gray-600 disabled:cursor-not-allowed transition-colors"
                      >
                        {isPending ? 'Removing…' : 'Remove'}
                      </button>
                    </div>
                    {!guard.allowed && guard.reason && (
                      <p className="text-xs text-amber-500">{guard.reason}</p>
                    )}
                  </li>
                )
              })}
            </ul>
          )}

          {onlySigner && (
            <p className="text-xs text-amber-500">
              This wallet has only one signer. Add another before removing this one, or the funds become unrecoverable.
            </p>
          )}

          <div className="border-t border-gray-800 pt-3 space-y-2">
            <p className="text-xs text-gray-500 uppercase tracking-wider">Add signer</p>
            <input
              value={newSignerKey}
              onChange={(e) => setNewSignerKey(e.target.value)}
              placeholder="ed25519 public key (64 hex chars)"
              className="w-full rounded-lg border border-gray-800 bg-black/40 px-3 py-2 font-mono text-xs text-gray-200 placeholder:text-gray-600 focus:outline-none focus:border-indigo-500"
            />
            <input
              value={newSignerLimit}
              onChange={(e) => setNewSignerLimit(e.target.value)}
              inputMode="decimal"
              placeholder="Spend limit in XLM (optional)"
              className="w-full rounded-lg border border-gray-800 bg-black/40 px-3 py-2 text-xs text-gray-200 placeholder:text-gray-600 focus:outline-none focus:border-indigo-500"
            />
            <button
              onClick={handleAddSigner}
              disabled={!address || pendingAction !== null}
              className="w-full rounded-lg border border-indigo-700 bg-indigo-900/40 px-3 py-2 text-xs font-semibold text-indigo-200 hover:bg-indigo-900/70 disabled:opacity-50 transition-colors"
            >
              {pendingAction?.startsWith('add:') ? 'Adding…' : 'Add signer'}
            </button>
            {actionError && <p className="text-xs text-red-400">{actionError}</p>}
          </div>
        </div>

        {/* Actions */}
        <div className="grid grid-cols-2 gap-3">
          <Link
            href="/send"
            className="rounded-xl border border-gray-700 bg-gray-900 px-4 py-3 text-center text-sm font-semibold hover:bg-gray-800 transition-colors"
          >
            Send
          </Link>
          <button
            onClick={() => address && fetchBalance(address)}
            className="rounded-xl border border-gray-700 bg-gray-900 px-4 py-3 text-sm font-semibold hover:bg-gray-800 transition-colors"
          >
            Refresh balance
          </button>
        </div>

        <p className="text-center text-xs text-gray-700">Stellar Testnet</p>
      </div>
    </main>
  )
}
