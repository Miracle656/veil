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

export default function DashboardPage() {
  const router = useRouter()

  const [address, setAddress] = useState<string | null>(null)
  const [xlmBalance, setXlmBalance] = useState<number | null>(null)
  const [loading, setLoading] = useState(true)
  const [copied, setCopied] = useState(false)

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
          setXlmBalance(Number(stroops) / 10_000_000)
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

  useEffect(() => {
    const stored = localStorage.getItem('invisible_wallet_address')
    if (!stored) {
      router.replace('/')
      return
    }
    setAddress(stored)
    fetchBalance(stored)
  }, [router, fetchBalance])

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

  const shortAddress = address
    ? `${address.slice(0, 6)}…${address.slice(-6)}`
    : '—'

  return (
    <main className="flex min-h-screen flex-col items-center justify-center gap-6 p-6">
      <div className="w-full max-w-sm space-y-4">
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
            {shortAddress} {copied ? '✓' : '⎘'}
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
