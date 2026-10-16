'use client'

import { TransactionBuilder, hash } from '@stellar/stellar-sdk'
import { ensureFeePayer } from '@/lib/feePayer'
import { getNetwork } from '@/lib/network'
import { getConfiguredBootnodeUrl, getSppConfig } from './config'
import { resolveBootnodeWithFallback } from './bootnode'

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
  recipientLookup: (address: string) => Promise<RecipientRegistration>
  stop: () => void
}

/**
 * What the SPP public-key registry says about one address (V137).
 *
 * `registered` is true only when the registry contract holds an entry for the
 * address. `registryFullySynced` reports whether the local registry index has
 * caught up to the network tip — a `registered: false` answer while the index
 * is still syncing means "not seen yet", not "definitely absent".
 */
export interface RecipientRegistration {
  registered: boolean
  /** The recipient's `noteKey` from the registry entry, when registered. */
  noteKey?: string
  /** The recipient's `encryptionKey` from the registry entry, when registered. */
  encryptionKey?: string
  /** Ledger the registry entry was last modified on, when registered. */
  ledger?: number
  /** Whether the local registry index is caught up to the network tip. */
  registryFullySynced: boolean
}

/**
 * The transaction hash of a completed pool execution, or throws.
 *
 * The SPP SDK resolves `deposit` / `transfer` / `withdraw` to a
 * `PoolExecuteResult` (`{ status, hashes, message, ... }`), not to a hash
 * string — `String(result)` would render `[object Object]`. The hash is the
 * first entry of `hashes`, and it only exists when `status === 'ok'`.
 */
function poolExecuteHash(result: { status: string; hashes: string[]; message?: string }): string {
  if (result.status !== 'ok' || !result.hashes.length) {
    throw new Error(result.message || 'The private transaction was not accepted by the pool.')
  }
  return result.hashes[0]
}

function toBigInt(value: bigint | number | string): bigint {
  if (typeof value === 'bigint') return value
  if (typeof value === 'number') return BigInt(Math.trunc(value))
  return BigInt(value)
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
    // Probe Veil's own archive and fall back to Nethermind's when it is
    // unreachable (#719). Resolving here rather than trusting the static
    // config is what makes the BootnodeBanner's claim true: the banner
    // reports the outcome of this same cached probe, so without it the
    // UI could say "using Nethermind" while the client used a dead URL.
    bootnodeUrl: await resolveBootnodeWithFallback(getConfiguredBootnodeUrl()),
  })

  const signer = await getSigner()
  // `userAddress` is deliberately omitted: SPP resolves it from
  // `signer.getPublicKey()` and defaults `signerAddress` to it. Passing the
  // wallet's `C…` contract address here while signing with the `G…` spending
  // account would pair an address with a key that cannot authorise for it.
  const account = await client.account({ networkPassphrase: network.networkPassphrase }, signer as any)

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
      return poolExecuteHash(await pool.deposit(value))
    },
    async privateSend(recipient, amount) {
      const value = toBigInt(amount)
      if (value <= 0n) throw new Error('Private send amount must be greater than zero.')
      return poolExecuteHash(await pool.transfer(recipient, value))
    },
    async unshield(amount, recipient) {
      const value = toBigInt(amount)
      if (value <= 0n) throw new Error('Unshield amount must be greater than zero.')
      return poolExecuteHash(await pool.withdraw(value, recipient ?? undefined))
    },
    async recipientLookup(address) {
      const lookup = await client.recipientLookup(address)
      const entry = lookup.entry
      return {
        registered: entry !== undefined && entry !== null,
        noteKey: entry?.noteKey,
        encryptionKey: entry?.encryptionKey,
        ledger: entry?.ledger,
        registryFullySynced: lookup.registryFullySynced,
      }
    },
    stop() {
      client.stopBackgroundSync()
    },
  }
}

export async function getPrivacyClient(): Promise<PrivacyClient> {
  // Cache the successful client only. A rejected promise left in place would
  // make every later retry re-throw the first failure (an unfunded fee payer,
  // say) until the page is reloaded.
  clientPromise ??= initClient().catch((error) => {
    clientPromise = null
    throw error
  })
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
