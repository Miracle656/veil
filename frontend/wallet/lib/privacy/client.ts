'use client'

import { TransactionBuilder, hash } from '@stellar/stellar-sdk'
import { ensureFeePayer } from '@/lib/feePayer'
import { getNetwork } from '@/lib/network'
import { walletLocal, walletSession } from '@/lib/walletStorage'
import { getSppConfig } from './config'

export type PrivacyStatus = 'idle' | 'syncing' | 'ready' | 'error'

export interface PrivacyProgressEvent {
  flow: string
  stage: string
  message: string
  current?: number
  total?: number
}

export interface PrivacyClient {
  sync: () => Promise<void>
  privateBalance: () => Promise<bigint>
  shield: (amount: bigint | number | string) => Promise<string>
  privateSend: (recipient: string, amount: bigint | number | string) => Promise<string>
  unshield: (amount: bigint | number | string, recipient?: string) => Promise<string>
  stop: () => void
}

function toBigInt(value: bigint | number | string): bigint {
  if (typeof value === 'bigint') return value
  if (typeof value === 'number') return BigInt(Math.trunc(value))
  return BigInt(value)
}

function getWalletAddress(): string {
  return walletSession.getItem('invisible_wallet_address') || walletLocal.getItem('invisible_wallet_address') || ''
}

async function getSigner() {
  const keypair = await ensureFeePayer()
  if (!keypair) {
    throw new Error('No spending account is available for privacy operations. Fund your fee-payer first.')
  }

  return {
    async getPublicKey() {
      return keypair.publicKey()
    },
    async signMessage(message: string | Uint8Array) {
      const bytes = typeof message === 'string' ? new TextEncoder().encode(message) : message
      return keypair.sign(Buffer.from(bytes)).toString('base64')
    },
    async signTransaction(xdr: string, options?: { networkPassphrase?: string }) {
      const transaction = TransactionBuilder.fromXDR(
        xdr,
        options?.networkPassphrase ?? getNetwork().networkPassphrase,
      )
      transaction.sign(keypair)
      return { signedTxXdr: transaction.toXDR(), signerAddress: keypair.publicKey() }
    },
    async signAuthEntry(entry: string) {
      const signature = keypair.sign(hash(Buffer.from(entry, 'base64')))
      return { signedAuthEntry: signature.toString('base64'), signerAddress: keypair.publicKey() }
    },
  }
}

function getContractConfig(config: NonNullable<ReturnType<typeof getSppConfig>>) {
  const network = getNetwork()
  return {
    network: network.networkPassphrase,
    deployer: config.deployer,
    admin: config.admin,
    asp_membership: config.aspMembership,
    asp_non_membership: config.aspNonMembership,
    verifiers: { B: config.verifiers.standard, B_gvk_T: config.verifiers.traceable },
    public_key_registry: config.publicKeyRegistry,
    pools: config.pools.map((pool) => {
      const assetKind: 'native' | 'contract' = pool.assetKind === 'native' ? 'native' : 'contract'
      return {
        poolContractId: pool.id,
        tokenContractId: pool.tokenContractId,
        deploymentLedger: pool.deploymentLedger,
        enabled: true,
        policyFlags: [...pool.policyFlags],
        ...(pool.gvkMode ? { gvkMode: pool.gvkMode } : {}),
        asset: { kind: assetKind, code: 'XLM', symbol: 'XLM' },
      }
    }),
  }
}

let clientPromise: Promise<PrivacyClient> | null = null

async function initClient(): Promise<PrivacyClient> {
  if (typeof window === 'undefined') {
    throw new Error('Privacy is only available in the browser.')
  }

  const sppConfig = getSppConfig()
  if (!sppConfig) {
    throw new Error('SPP pool is not configured for this network yet.')
  }

  const module = await import('stellar-private-payments')
  const storage = await module.Storage.open()
  const network = getNetwork()
  const client = await module.Client.new({
    rpcUrl: network.rpcUrl,
    storage,
    contractConfig: getContractConfig(sppConfig),
    circuitsBaseUrl: `${window.location.origin}/spp/circuits/`,
    bootnodeUrl: sppConfig.bootnodeUrl,
  })

  const signer = await getSigner()
  const account = await client.account({ networkPassphrase: network.networkPassphrase, userAddress: getWalletAddress() }, signer as any)

  const pool = await account.pool({ poolContract: sppConfig.pools[0].id })

  return {
    async sync() {
      await client.sync()
    },
    async privateBalance() {
      return BigInt((await pool.balance()) ?? 0)
    },
    async shield(amount) {
      const value = toBigInt(amount)
      if (value <= 0n) throw new Error('Shield amount must be greater than zero.')
      return String(await pool.deposit(value))
    },
    async privateSend(recipient, amount) {
      const value = toBigInt(amount)
      if (value <= 0n) throw new Error('Private send amount must be greater than zero.')
      return String(await pool.transfer(recipient, value))
    },
    async unshield(amount, recipient) {
      const value = toBigInt(amount)
      if (value <= 0n) throw new Error('Unshield amount must be greater than zero.')
      return String(await pool.withdraw(value, recipient ?? undefined))
    },
    stop() {
      client.stopBackgroundSync()
    },
  }
}

export async function getPrivacyClient(): Promise<PrivacyClient> {
  clientPromise ??= initClient()
  return clientPromise
}

export function toUserFacingPrivacyError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error)
  const cleaned = message.replace(/^Error:\s*/, '').trim()
  if (!cleaned) return 'Privacy operation failed. Please try again.'

  if (cleaned.includes('SPP pool is not configured')) return 'Privacy is not enabled on this network yet.'
  if (cleaned.includes('No spending account is available')) return 'Your spending account is not ready yet. Fund it and try again.'
  if (cleaned.includes('RPC')) return 'Privacy could not reach the network. Please try again in a moment.'

  return cleaned
}

export function attachPrivacyProgress(handler: (event: PrivacyProgressEvent) => void) {
  const eventName = 'stellar-private-payments:tx-progress'
  const listener = ((event: Event) => {
    const detail = (event as CustomEvent<PrivacyProgressEvent>).detail
    if (detail) handler(detail)
  }) as EventListener

  window.addEventListener(eventName, listener)
  return () => window.removeEventListener(eventName, listener)
}
