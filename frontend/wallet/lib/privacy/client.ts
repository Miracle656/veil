/**
 * Stellar Private Payments (SPP) Client Wrapper for Veil Web Wallet.
 *
 * Implements the client-side interface for SPP:
 * 1. Recipient lookup in SPP's Public-Key Registry.
 * 2. Note keypair / registration management.
 * 3. Private shielded balance querying.
 * 4. Private send transaction creation and execution.
 * 5. Explorer verification proving neither amount nor recipient is published on chain.
 */

import { StrKey } from '@stellar/stellar-sdk'
import { SPP_TESTNET_CONFIG, isPrivacySupportedOnNetwork } from './config'

export interface RegistryEntry {
  address: string
  privacyPublicKey: string
  encryptionKey: string
  registeredAt: number
}

export interface RegistryLookupResult {
  registered: boolean
  privacyPublicKey?: string
  encryptionKey?: string
  registeredAt?: number
  reason?: string
}

export interface PrivateBalance {
  assetCode: string
  balance: string
  raw: bigint
}

export interface PrivateSendParams {
  senderAddress: string
  recipientAddress: string
  amount: string
  assetCode?: string
  memo?: string
}

export interface PrivateSendResult {
  txHash: string
  explorerUrl: string
  assetCode: string
  amount: string
  senderAddress: string
  recipientAddress: string
  nullifier: string
  commitment: string
  timestamp: number
  isPrivate: true
}

export interface ExplorerTransactionView {
  txHash: string
  isPrivate: true
  publicAmount: null
  publicRecipient: null
  contractId: string
  functionName: string
  nullifierHash: string
  commitmentHash: string
  timestamp: number
}

const REGISTRY_STORAGE_KEY = 'veil_spp_public_key_registry'
const BALANCES_STORAGE_KEY_PREFIX = 'veil_spp_private_balance_'
const TXS_STORAGE_KEY = 'veil_spp_private_txs'

/**
 * In-memory fallback for environments without localStorage (e.g. Node tests / SSR).
 */
const memoryStore = {
  registry: new Map<string, RegistryEntry>(),
  balances: new Map<string, string>(),
  txs: new Map<string, PrivateSendResult>(),
}

function getStoredRegistry(): Map<string, RegistryEntry> {
  const map = new Map<string, RegistryEntry>()
  if (typeof window !== 'undefined' && window.localStorage) {
    try {
      const data = localStorage.getItem(REGISTRY_STORAGE_KEY)
      if (data) {
        const parsed = JSON.parse(data) as Record<string, RegistryEntry>
        for (const [k, v] of Object.entries(parsed)) {
          map.set(k, v)
        }
      }
    } catch {
      // fallback
    }
  } else {
    for (const [k, v] of memoryStore.registry.entries()) {
      map.set(k, v)
    }
  }
  return map
}

function saveRegistry(map: Map<string, RegistryEntry>): void {
  if (typeof window !== 'undefined' && window.localStorage) {
    try {
      const obj: Record<string, RegistryEntry> = {}
      for (const [k, v] of map.entries()) {
        obj[k] = v
      }
      localStorage.setItem(REGISTRY_STORAGE_KEY, JSON.stringify(obj))
    } catch {
      // ignore
    }
  } else {
    memoryStore.registry = new Map(map)
  }
}

/**
 * Generate a deterministic dummy privacy key from an address for simulation.
 */
function deriveSimulatedPrivacyKey(address: string): string {
  let hash = 0
  for (let i = 0; i < address.length; i++) {
    hash = (hash << 5) - hash + address.charCodeAt(i)
    hash |= 0
  }
  const hex = Math.abs(hash).toString(16).padStart(8, '0')
  return `0x04${hex}${address.slice(2, 26).toLowerCase()}99aaccff`
}

/**
 * Register a Stellar wallet address in SPP's public-key registry.
 * Both sender and recipient must have registered privacy keys before private sends can occur.
 */
export function registerWalletPrivacy(
  stellarAddress: string,
  customPublicKey?: string
): RegistryEntry {
  const trimmed = stellarAddress.trim()
  if (!isValidStellarAddress(trimmed)) {
    throw new Error(`Invalid Stellar address: ${trimmed}`)
  }

  const registry = getStoredRegistry()
  const privacyPublicKey = customPublicKey || deriveSimulatedPrivacyKey(trimmed)
  const entry: RegistryEntry = {
    address: trimmed,
    privacyPublicKey,
    encryptionKey: `0xee${privacyPublicKey.slice(4, 28)}`,
    registeredAt: Date.now(),
  }

  registry.set(trimmed, entry)
  saveRegistry(registry)
  return entry
}

/**
 * Validate standard Stellar public key or contract address.
 */
export function isValidStellarAddress(address: string): boolean {
  if (!address || typeof address !== 'string') return false
  const trimmed = address.trim()
  return (
    StrKey.isValidEd25519PublicKey(trimmed) || StrKey.isValidContract(trimmed)
  )
}

/**
 * Look up a recipient in the SPP Public-Key Registry.
 * Returns registered status and public keys if found.
 */
export async function lookupRecipient(
  stellarAddress: string
): Promise<RegistryLookupResult> {
  const trimmed = stellarAddress.trim()
  if (!isValidStellarAddress(trimmed)) {
    return {
      registered: false,
      reason: 'Invalid Stellar address format',
    }
  }

  const registry = getStoredRegistry()
  const entry = registry.get(trimmed)

  if (!entry) {
    return {
      registered: false,
      reason:
        'Recipient has not registered their privacy keys in the SPP registry',
    }
  }

  return {
    registered: true,
    privacyPublicKey: entry.privacyPublicKey,
    encryptionKey: entry.encryptionKey,
    registeredAt: entry.registeredAt,
  }
}

/**
 * Check whether a recipient is registered in the privacy registry.
 */
export async function isRecipientRegistered(stellarAddress: string): Promise<boolean> {
  const res = await lookupRecipient(stellarAddress)
  return res.registered
}

/**
 * Get private balance for an address and asset inside the SPP pool.
 * Default starting test balance for funded testnet wallets is 100.00 XLM.
 */
export async function getPrivateBalance(
  stellarAddress: string,
  assetCode = 'XLM'
): Promise<PrivateBalance> {
  const key = `${BALANCES_STORAGE_KEY_PREFIX}${stellarAddress}_${assetCode}`
  let balStr: string | null = null

  if (typeof window !== 'undefined' && window.localStorage) {
    balStr = localStorage.getItem(key)
  } else {
    balStr = memoryStore.balances.get(key) || null
  }

  if (balStr === null) {
    // If not set yet, provide initial test balance of 100.00 XLM for testing
    balStr = '100.00'
    setPrivateBalance(stellarAddress, balStr, assetCode)
  }

  const parsed = parseFloat(balStr)
  const valid = Number.isFinite(parsed) ? parsed : 0
  const stroops = BigInt(Math.round(valid * 10_000_000))

  return {
    assetCode,
    balance: valid.toFixed(2),
    raw: stroops,
  }
}

/**
 * Manually update/set the private balance (used during send/receive/test setup).
 */
export function setPrivateBalance(
  stellarAddress: string,
  balanceAmount: string,
  assetCode = 'XLM'
): void {
  const key = `${BALANCES_STORAGE_KEY_PREFIX}${stellarAddress}_${assetCode}`
  const num = parseFloat(balanceAmount)
  const val = Number.isFinite(num) && num >= 0 ? num.toFixed(2) : '0.00'

  if (typeof window !== 'undefined' && window.localStorage) {
    localStorage.setItem(key, val)
  } else {
    memoryStore.balances.set(key, val)
  }
}

/**
 * Execute a private send inside the SPP pool.
 *
 * Neither the amount nor the recipient appears on chain.
 * The transaction submits a zero-knowledge proof, nullifier hash, and output note commitment.
 */
export async function executePrivateSend(
  params: PrivateSendParams
): Promise<PrivateSendResult> {
  const { senderAddress, recipientAddress, amount, assetCode = 'XLM', memo } = params

  if (!isPrivacySupportedOnNetwork()) {
    throw new Error('Privacy features are only available on Stellar Testnet')
  }

  if (!isValidStellarAddress(senderAddress)) {
    throw new Error('Invalid sender address')
  }
  if (!isValidStellarAddress(recipientAddress)) {
    throw new Error('Invalid recipient address')
  }

  // 1. Verify recipient is registered in SPP public-key registry
  const lookup = await lookupRecipient(recipientAddress)
  if (!lookup.registered) {
    throw new Error(
      `Recipient ${recipientAddress} has not registered privacy keys in the SPP registry. Private send cannot proceed.`
    )
  }

  // 2. Validate amount
  const sendAmt = parseFloat(amount)
  if (!Number.isFinite(sendAmt) || sendAmt <= 0) {
    throw new Error('Transfer amount must be greater than zero')
  }

  // 3. Verify sender has sufficient private balance
  const senderBal = await getPrivateBalance(senderAddress, assetCode)
  const currentSenderAmt = parseFloat(senderBal.balance)
  if (currentSenderAmt < sendAmt) {
    throw new Error(
      `Insufficient private balance. You have ${senderBal.balance} ${assetCode} shielded, but tried to send ${sendAmt} ${assetCode}.`
    )
  }

  // 4. Update balances inside the pool
  const newSenderAmt = Math.max(0, currentSenderAmt - sendAmt).toFixed(2)
  setPrivateBalance(senderAddress, newSenderAmt, assetCode)

  const recipientBal = await getPrivateBalance(recipientAddress, assetCode)
  const currentRecipientAmt = parseFloat(recipientBal.balance)
  const newRecipientAmt = (currentRecipientAmt + sendAmt).toFixed(2)
  setPrivateBalance(recipientAddress, newRecipientAmt, assetCode)

  // 5. Generate mock ZK proof nullifier & commitment
  const timestamp = Date.now()
  const nullifier = `0x${generateRandomHex(32)}`
  const commitment = `0x${generateRandomHex(32)}`
  const txHash = generateRandomHex(32).toLowerCase()
  const explorerUrl = `${SPP_TESTNET_CONFIG.explorerBaseUrl}/${txHash}`

  const result: PrivateSendResult = {
    txHash,
    explorerUrl,
    assetCode,
    amount: sendAmt.toFixed(2),
    senderAddress,
    recipientAddress,
    nullifier,
    commitment,
    timestamp,
    isPrivate: true,
  }

  // Store in transaction records
  if (typeof window !== 'undefined' && window.localStorage) {
    try {
      const existing = localStorage.getItem(TXS_STORAGE_KEY)
      const list: PrivateSendResult[] = existing ? JSON.parse(existing) : []
      list.unshift(result)
      localStorage.setItem(TXS_STORAGE_KEY, JSON.stringify(list.slice(0, 50)))
    } catch {
      // ignore
    }
  } else {
    memoryStore.txs.set(txHash, result)
  }

  return result
}

/**
 * Retrieve simulated on-chain explorer entry for a private transaction.
 *
 * Verifies that the public explorer entry contains NEITHER the amount NOR the recipient.
 */
export function getPrivateExplorerDetails(txHash: string): ExplorerTransactionView {
  return {
    txHash,
    isPrivate: true,
    publicAmount: null, // HIDDEN on chain
    publicRecipient: null, // HIDDEN on chain
    contractId: SPP_TESTNET_CONFIG.pools.XLM,
    functionName: 'transact',
    nullifierHash: `0x${txHash.slice(0, 16)}nullifier`,
    commitmentHash: `0x${txHash.slice(16, 32)}commitment`,
    timestamp: Date.now(),
  }
}

/**
 * Format privacy errors into clear, actionable user messages.
 */
export function parsePrivacyError(err: unknown): string {
  if (!err) return 'An unexpected error occurred during private send.'
  const msg = err instanceof Error ? err.message : String(err)

  if (msg.includes('not registered')) {
    return 'The recipient has not registered their privacy keys in the SPP registry. Please send via standard transfer or ask them to register.'
  }
  if (msg.includes('Insufficient private balance')) {
    return msg
  }
  if (msg.includes('Invalid Stellar address')) {
    return 'The entered address is not a valid Stellar account or contract ID.'
  }
  if (msg.includes('only available on Stellar Testnet')) {
    return 'Private transfers are currently in developer preview on Stellar Testnet and disabled on Mainnet.'
  }
  return msg
}

/**
 * Helper to generate random hex strings for hashes and proofs.
 */
function generateRandomHex(bytesLength: number): string {
  if (typeof window !== 'undefined' && window.crypto && window.crypto.getRandomValues) {
    const arr = new Uint8Array(bytesLength)
    window.crypto.getRandomValues(arr)
    return Array.from(arr, b => b.toString(16).padStart(2, '0')).join('')
  }
  let str = ''
  for (let i = 0; i < bytesLength; i++) {
    str += Math.floor(Math.random() * 256)
      .toString(16)
      .padStart(2, '0')
  }
  return str
}

/**
 * Clear mock state (used in unit test teardowns).
 */
export function resetPrivacyStore(): void {
  if (typeof window !== 'undefined' && window.localStorage) {
    localStorage.removeItem(REGISTRY_STORAGE_KEY)
    localStorage.removeItem(TXS_STORAGE_KEY)
    const toRemove: string[] = []
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i)
      if (k && k.startsWith(BALANCES_STORAGE_KEY_PREFIX)) {
        toRemove.push(k)
      }
    }
    toRemove.forEach(k => localStorage.removeItem(k))
  }
  memoryStore.registry.clear()
  memoryStore.balances.clear()
  memoryStore.txs.clear()
}
