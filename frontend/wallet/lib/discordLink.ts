/**
 * Linking this wallet to a Discord account, to get roles in the Veil server.
 *
 * The web half of `frontend/mobile/lib/discordLink.ts`; the two build the same
 * statement and call the same backend routes.
 *
 * Pasting an address into Discord would prove nothing, since every address is
 * public. So the member asks the bot for a short code and the wallet's own
 * keys sign one statement: the passkey for the smart wallet, the fee-payer key
 * for the spending account.
 *
 * WHAT THE PASSKEY SIGNS. The same passkey authorises payments by signing a
 * 32-byte hash. So nothing here signs a value the server hands over: the text
 * is built in {@link linkStatement} from a fixed label and fields the page has
 * already shown, and its SHA-256 is what gets signed. A hash that starts from
 * that label cannot also be the hash of a transaction.
 */

import { hash, Keypair } from '@stellar/stellar-sdk'

import { ensureFeePayer, getFeePayerMode, peekFeePayerSecret } from './feePayer'
import { getNetworkName } from './network'
import { buildSignAuthEntry } from './passkeySigner'
import { walletLocal, walletSession } from './walletStorage'

const TIMEOUT_MS = 30_000

/** Letters and digits that cannot be mistaken for each other when typed. */
const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'
export const CODE_LENGTH = 8

/** Read a code the way a person types it: any case, spaces, a dash. */
export function normalizeLinkCode(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const cleaned = value.toUpperCase().replace(/[\s-]/g, '')
  if (cleaned.length !== CODE_LENGTH) return null
  return [...cleaned].every((char) => CODE_ALPHABET.includes(char)) ? cleaned : null
}

export function formatLinkCode(code: string): string {
  return `${code.slice(0, 4)}-${code.slice(4)}`
}

export interface LinkStatementFields {
  code: string
  discordUserId: string
  wallet: string | null
  spending: string | null
}

/** The exact text that is hashed and signed. Must match the backend's. */
export function linkStatement(fields: LinkStatementFields): string {
  return [
    'veil-discord-link:v1',
    `code=${fields.code}`,
    `discord=${fields.discordUserId}`,
    `wallet=${fields.wallet ?? ''}`,
    `spending=${fields.spending ?? ''}`,
  ].join('\n')
}

export function linkChallenge(fields: LinkStatementFields): Uint8Array {
  return new Uint8Array(hash(Buffer.from(linkStatement(fields), 'utf8')))
}

function base64Url(bytes: Uint8Array): string {
  return Buffer.from(bytes)
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '')
}

export class DiscordLinkError extends Error {
  constructor(
    message: string,
    readonly code: string,
  ) {
    super(message)
    this.name = 'DiscordLinkError'
  }
}

async function call<T>(path: string, init: { method?: string; body?: unknown } = {}): Promise<T> {
  const base = (process.env.NEXT_PUBLIC_WRAITH_URL ?? '').replace(/\/+$/, '')
  if (!base) throw new DiscordLinkError('Discord linking is not available here.', 'not_configured')

  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS)
  let response: Response
  try {
    response = await fetch(`${base}${path}`, {
      method: init.method ?? 'GET',
      signal: controller.signal,
      headers: init.body === undefined ? undefined : { 'Content-Type': 'application/json' },
      body: init.body === undefined ? undefined : JSON.stringify(init.body),
    })
  } catch {
    throw new DiscordLinkError('Could not reach Veil. Check your connection and try again.', 'network')
  } finally {
    clearTimeout(timer)
  }
  const body = (await response.json().catch(() => null)) as { error?: unknown; code?: unknown } | null
  if (!response.ok) {
    const message =
      typeof body?.error === 'string' && body.error ? body.error : 'Something went wrong. Nothing was linked.'
    throw new DiscordLinkError(message, typeof body?.code === 'string' ? body.code : `http_${response.status}`)
  }
  return body as T
}

export interface LinkCodeInfo {
  code: string
  discordUserId: string
  discordUsername: string
}

/** Ask the backend whose code this is, so the user can see it before signing. */
export async function lookUpLinkCode(code: string): Promise<LinkCodeInfo> {
  const info = await call<{ discordUserId?: unknown; discordUsername?: unknown }>(
    `/discord/link/${encodeURIComponent(code)}`,
  )
  if (typeof info.discordUserId !== 'string' || !/^\d{5,25}$/.test(info.discordUserId)) {
    throw new DiscordLinkError('That code could not be read. Get a new one in Discord.', 'bad_response')
  }
  return {
    code,
    discordUserId: info.discordUserId,
    discordUsername: typeof info.discordUsername === 'string' ? info.discordUsername : 'your account',
  }
}

export interface LinkableAccounts {
  /** The smart wallet, when this browser holds a passkey for it. */
  wallet: string | null
  /** The fee-payer account, when its key is in this browser. */
  spending: string | null
  /**
   * True when the wallet has a spending account whose key is not in this tab
   * yet. Most wallets keep that key out of permanent storage and rebuild it
   * from the passkey, so a tab opened from Discord starts without it.
   */
  spendingLocked: boolean
}

/**
 * What this browser can sign for. A wallet made on a phone and opened here
 * has no usable passkey in the browser; its spending account can still be
 * linked, and the wallet itself is linked from the phone.
 */
export function getLinkableAccounts(): LinkableAccounts {
  const address =
    walletLocal.getItem('invisible_wallet_address') ?? walletSession.getItem('invisible_wallet_address')
  const hasPasskey = Boolean(
    walletLocal.getItem('invisible_wallet_key_id') && walletLocal.getItem('invisible_wallet_public_key'),
  )
  const secret = peekFeePayerSecret()
  let spending: string | null = null
  try {
    spending = secret ? Keypair.fromSecret(secret).publicKey() : null
  } catch {
    spending = null
  }
  const wallet = address && address.startsWith('C') && hasPasskey ? address : null
  return {
    wallet,
    spending,
    // Only a wallet that already has a spending account. This page must never
    // be the thing that creates one.
    spendingLocked: spending === null && wallet !== null && getFeePayerMode() !== null,
  }
}

/**
 * Rebuild the spending key from the passkey, so the spending account can be
 * linked too. That is where names and Veil-ians bought on the web are held, so
 * leaving it out costs the member those roles.
 *
 * One passkey prompt. Returns the accounts unchanged when the key cannot be
 * rebuilt: the wallet can still be linked on its own.
 */
export async function unlockSpending(accounts: LinkableAccounts): Promise<LinkableAccounts> {
  if (!accounts.spendingLocked) return accounts
  try {
    const keypair = await ensureFeePayer()
    if (!keypair) return accounts
    return { ...accounts, spending: keypair.publicKey(), spendingLocked: false }
  } catch {
    return accounts
  }
}

export function canLinkOnThisNetwork(): boolean {
  return getNetworkName() === 'mainnet'
}

export interface LinkResult {
  roles: string[]
  incomplete: boolean
  inServer: boolean
}

/** Null means the passkey prompt was dismissed: nothing was sent. */
export async function linkDiscord(info: LinkCodeInfo, accounts: LinkableAccounts): Promise<LinkResult | null> {
  if (!accounts.wallet && !accounts.spending) {
    throw new DiscordLinkError('There is no wallet in this browser to link.', 'no_wallet')
  }
  const challenge = linkChallenge({
    code: info.code,
    discordUserId: info.discordUserId,
    wallet: accounts.wallet,
    spending: accounts.spending,
  })

  let spendingSignature: string | undefined
  if (accounts.spending) {
    const secret = peekFeePayerSecret()
    const keypair = secret ? Keypair.fromSecret(secret) : null
    if (!keypair || keypair.publicKey() !== accounts.spending) {
      throw new DiscordLinkError('The spending key in this browser could not be read.', 'no_spending_key')
    }
    spendingSignature = base64Url(new Uint8Array(keypair.sign(Buffer.from(challenge))))
  }

  let passkey: Record<string, string> | undefined
  if (accounts.wallet) {
    let assertion
    try {
      assertion = await buildSignAuthEntry()(challenge)
    } catch (error) {
      // The browser reports a dismissed prompt as NotAllowedError.
      if (error instanceof DOMException && error.name === 'NotAllowedError') return null
      throw error
    }
    if (!assertion) return null
    passkey = {
      publicKey: base64Url(assertion.publicKey),
      authData: base64Url(assertion.authData),
      clientDataJSON: base64Url(assertion.clientDataJSON),
      signature: base64Url(assertion.signature),
    }
  }

  const result = await call<{ roles?: unknown; incomplete?: unknown; inServer?: unknown }>('/discord/link', {
    method: 'POST',
    body: { code: info.code, wallet: accounts.wallet, spending: accounts.spending, passkey, spendingSignature },
  })
  return {
    roles: Array.isArray(result.roles) ? result.roles.filter((role): role is string => typeof role === 'string') : [],
    incomplete: result.incomplete === true,
    inServer: result.inServer !== false,
  }
}
