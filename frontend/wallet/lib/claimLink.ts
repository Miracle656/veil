import {
  Asset,
  Horizon,
  Keypair,
  Operation,
  StrKey,
  TransactionBuilder,
} from '@stellar/stellar-sdk'

import { getAssetIssuer, verifiedAsset } from './assets'
import { peekFeePayerKeypair } from './feePayer'
import { inclusionFee } from './fees'
import { horizonErrorMessage, isHorizonNotFound } from './horizonError'
import {
  getNetwork,
  getNetworkName,
  isNetworkAvailable,
  type VeilNetworkName,
} from './network'
import { hasTrustline, type HorizonBalanceLike } from './trustlines'

const MAX_CLAIM_NOTE_LENGTH = 80
const URL_SCHEME_RE =
  /\b(?:https?|ftp|mailto|tel|javascript|data|vbscript|file|veil|web\+stellar)\s*:|\/\/\S+/i
const WWW_HOST_RE = /\bwww\.[a-z0-9-]+/i
const BARE_DOMAIN_RE =
  /(?:^|[\s(@])(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+(?:[a-z]{2,24}|xn--[a-z0-9-]{2,})(?=$|[\s/:?#),.!])|[a-z0-9-][\u3002\uFF0E\uFF61][a-z]{2,}/i
const IP_LITERAL_RE = /\b(?:\d{1,3}\.){3}\d{1,3}\b|\[[0-9a-f:]+\]/i
const MARKUP_OR_ENTITY_RE = /[<>&`]|\[[^\]]*\]\([^)]*\)|!\[[^\]]*\]/
const CONTROL_CHARS_RE = /[\u0000-\u001F\u007F]/

export const ALREADY_CLAIMED_WEB_MESSAGE = 'This link has already been claimed.'
export const EXPIRED_AND_RECLAIMED_WEB_MESSAGE =
  'This link expired and was reclaimed by the sender.'
export const WEB_HISTORY_CHECK_FAILED_MESSAGE =
  'This balance is no longer active, and its claim history could not be checked. Check your connection and try again.'

export type WebClaimAssetVerification = {
  isVerifiedAsset: boolean
  verifiedAssetName: string | null
  verifiedIssuerName: string | null
}

export type WebClaimLinkInspection =
  | ({
      status: 'claimable'
      balanceId: string
      amount: string
      assetCode: string
      assetIssuer: string | null
      sponsor: string | null
      claimantAddresses: string[]
      expiresAt: number | null
      expired: boolean
      expiryLabel: string | null
      strandedSweepOnly?: boolean
    } & WebClaimAssetVerification)
  | {
      status: 'consumed'
      balanceId: string
      reclaimedBySender: boolean
      message: string
    }
  | {
      status: 'not_found'
      balanceId: string
      message: string
    }
  | {
      status: 'status_unknown'
      balanceId: string
      message: string
    }
  | {
      status: 'network_mismatch'
      balanceId: string
      linkNetwork: VeilNetworkName
      activeNetwork: VeilNetworkName
      canSwitch: boolean
      message: string
    }

export type WebClaimExecutionResult =
  | {
      status: 'claimed'
      txHash: string
      mergeTxHash?: string | null
      /** True only once Tx 2 (`accountMerge`) released the 1 XLM sponsored base reserve. */
      reserveReleased: boolean
      reserveReleaseTxHash?: string
      reserveReleaseError?: string
      amount: string
      assetCode: string
      assetIssuer: string | null
      destination: string
    }
  | {
      status: 'already_claimed'
      message: string
    }

export type WebReserveReleaseRetryResult =
  | {
      released: true
      txHash: string | null
    }
  | {
      released: false
      error: string
    }

/**
 * Extract `#s=<secret>` from `window.location.hash` (or any hash string)
 * purely client-side without touching query parameters.
 */
export function parseClaimSecretFromHash(hash: string | null | undefined): string | null {
  if (typeof hash !== 'string' || !hash) return null
  const trimmed = hash.startsWith('#') ? hash.slice(1) : hash
  if (!trimmed) return null
  for (const part of trimmed.split('&')) {
    if (!part) continue
    const eq = part.indexOf('=')
    const rawKey = eq === -1 ? part : part.slice(0, eq)
    const rawVal = eq === -1 ? '' : part.slice(eq + 1)
    try {
      const key = decodeURIComponent(rawKey)
      const val = decodeURIComponent(rawVal).trim()
      if (key === 's' && val) return val
    } catch {
      if (rawKey === 's' && rawVal.trim()) return rawVal.trim()
    }
  }
  return null
}

export function parseClaimLinkNetwork(raw: string | null | undefined): VeilNetworkName | null {
  if (!raw) return null
  const clean = raw.trim().toLowerCase()
  if (clean === 'mainnet' || clean === 'testnet') return clean
  return null
}

/**
 * Compare an asset's code AND issuer against `ASSET_REGISTRY` on `network`.
 * Anything outside the registry (including an impostor `USDC` issued by an
 * unknown `G…` address) returns `isVerifiedAsset: false`.
 */
export function resolveWebClaimAssetVerification(
  code: string,
  issuer: string | null,
  network: VeilNetworkName = getNetworkName(),
): WebClaimAssetVerification {
  if (code.toUpperCase() === 'XLM' && !issuer) {
    return {
      isVerifiedAsset: true,
      verifiedAssetName: 'Stellar Lumens',
      verifiedIssuerName: 'Stellar',
    }
  }
  if (!issuer) {
    return {
      isVerifiedAsset: false,
      verifiedAssetName: null,
      verifiedIssuerName: null,
    }
  }
  const registered = verifiedAsset(code, issuer, network)
  const canonicalIssuer = getAssetIssuer(code, network)
  if (registered && canonicalIssuer === issuer) {
    return {
      isVerifiedAsset: true,
      verifiedAssetName: registered.name,
      verifiedIssuerName: registered.issuerName,
    }
  }
  return {
    isVerifiedAsset: false,
    verifiedAssetName: null,
    verifiedIssuerName: null,
  }
}

/**
 * Sanitize an optional sender note from a claim URL query string.
 * Rejects URLs, domains, IP literals, control chars, and HTML/Markdown markup.
 */
export function sanitizeInboundClaimNote(rawNote: string | null | undefined): string | null {
  if (!rawNote) return null
  if (CONTROL_CHARS_RE.test(rawNote)) return null
  const trimmed = rawNote.trim()
  if (!trimmed || trimmed.length > MAX_CLAIM_NOTE_LENGTH) return null
  if (
    URL_SCHEME_RE.test(trimmed) ||
    WWW_HOST_RE.test(trimmed) ||
    BARE_DOMAIN_RE.test(trimmed) ||
    IP_LITERAL_RE.test(trimmed) ||
    MARKUP_OR_ENTITY_RE.test(trimmed)
  ) {
    return null
  }
  return trimmed
}

function parseHorizonAsset(raw: string): { code: string; issuer: string | null } {
  if (!raw || raw === 'native') return { code: 'XLM', issuer: null }
  const idx = raw.indexOf(':')
  if (idx === -1) return { code: raw, issuer: null }
  return { code: raw.slice(0, idx), issuer: raw.slice(idx + 1) || null }
}

function extractDeadlineUnix(claimants: unknown): number | null {
  if (!Array.isArray(claimants)) return null
  for (const c of claimants) {
    const notPred = (c as { predicate?: { not?: Record<string, unknown> } })?.predicate?.not
    if (!notPred) continue
    const epoch = notPred.abs_before_epoch ?? notPred.absBeforeEpoch
    if (epoch !== undefined && epoch !== null) {
      const n = Number(epoch)
      if (Number.isFinite(n) && n > 0) return Math.floor(n)
    }
    if (typeof notPred.abs_before === 'string') {
      const ms = Date.parse(notPred.abs_before)
      if (Number.isFinite(ms) && ms > 0) return Math.floor(ms / 1000)
    }
  }
  return null
}

function formatExpiryDuration(deltaSeconds: number): string {
  const abs = Math.max(0, Math.floor(Math.abs(deltaSeconds)))
  if (abs < 60) return 'less than a minute'
  if (abs < 3_600) return `${Math.floor(abs / 60)}m`
  if (abs < 86_400) return `${Math.floor(abs / 3_600)}h`
  return `${Math.floor(abs / 86_400)}d`
}

export function formatWebClaimExpiry(expiresAt: number, nowUnix = Math.floor(Date.now() / 1000)): string {
  const diff = expiresAt - nowUnix
  if (diff <= 0) {
    return `Expired ${formatExpiryDuration(diff)} ago — the sender can now reclaim this link`
  }
  return `Claim within ${formatExpiryDuration(diff)}`
}

type ClaimHistoryLookup =
  | { status: 'claimed'; claimant: string; sponsor: string | null }
  | { status: 'no_claim_in_history' }
  | { status: 'lookup_failed' }

async function lookupBalanceClaimHistory(
  server: Horizon.Server,
  balanceId: string,
): Promise<ClaimHistoryLookup> {
  try {
    const opsBuilder = (
      server as unknown as {
        operations?: () => {
          forClaimableBalance?: (id: string) => {
            order: (dir: 'asc' | 'desc') => {
              limit: (n: number) => {
                call: () => Promise<{ records?: Record<string, unknown>[] }>
              }
            }
          }
        }
      }
    ).operations?.()
    const forBalance = opsBuilder?.forClaimableBalance?.(balanceId)
    if (!forBalance) return { status: 'lookup_failed' }
    const page = await forBalance.order('desc').limit(10).call()
    const records = Array.isArray(page?.records) ? page.records : []
    let claimant: string | null = null
    let sponsor: string | null = null
    for (const rec of records) {
      if (rec.type === 'claim_claimable_balance' && !claimant) {
        claimant =
          typeof rec.claimant === 'string'
            ? rec.claimant
            : typeof rec.source_account === 'string'
              ? rec.source_account
              : null
      }
      if (rec.type === 'create_claimable_balance' && !sponsor) {
        sponsor = typeof rec.source_account === 'string' ? rec.source_account : null
      }
    }
    if (claimant) {
      return { status: 'claimed', claimant, sponsor }
    }
    return { status: 'no_claim_in_history' }
  } catch (err) {
    if (isHorizonNotFound(err)) {
      return { status: 'no_claim_in_history' }
    }
    return { status: 'lookup_failed' }
  }
}

function networkDisplayLabel(net: VeilNetworkName): string {
  return net === 'mainnet' ? 'Stellar Mainnet' : 'Stellar Testnet'
}

function summarizeStrandedEphemeral(
  account: Horizon.AccountResponse,
): { amount: string; assetCode: string; assetIssuer: string | null } | null {
  const balances = (account.balances ?? []) as HorizonBalanceLike[]
  for (const b of balances) {
    if (
      (b.asset_type === 'credit_alphanum4' || b.asset_type === 'credit_alphanum12') &&
      b.asset_code &&
      b.asset_issuer &&
      Number(b.balance ?? '0') > 0
    ) {
      return {
        amount: b.balance,
        assetCode: b.asset_code,
        assetIssuer: b.asset_issuer,
      }
    }
  }
  const native = balances.find((b) => b.asset_type === 'native')
  if (native && Number(native.balance ?? '0') > 0) {
    return {
      amount: native.balance,
      assetCode: 'XLM',
      assetIssuer: null,
    }
  }
  return null
}

/**
 * Read a claimable balance directly from Horizon:
 *  - checks `linkNetwork` against the active network before querying Horizon;
 *  - verifies the asset issuer against `ASSET_REGISTRY`;
 *  - if the balance is gone (`404`), checks history first and only treats a
 *    funded one-time account as sweepable when `claim_claimable_balance`
 *    history shows it claimed this balance;
 *  - reports `"already claimed"` ONLY when a `claim_claimable_balance`
 *    operation is present in Horizon history.
 */
export async function inspectWebClaimLink(
  balanceId: string,
  opts: {
    nowUnix?: number
    linkNetwork?: VeilNetworkName | null
    ephemeralSecret?: string | null
  } = {},
): Promise<WebClaimLinkInspection> {
  const cleanId = balanceId.trim()
  if (!cleanId) {
    throw new Error('Missing claimable balance ID in link.')
  }
  const activeNetwork = getNetworkName()
  if (opts.linkNetwork && opts.linkNetwork !== activeNetwork) {
    return {
      status: 'network_mismatch',
      balanceId: cleanId,
      linkNetwork: opts.linkNetwork,
      activeNetwork,
      canSwitch: isNetworkAvailable(opts.linkNetwork),
      message: `This link was created on ${networkDisplayLabel(opts.linkNetwork)}, while your wallet is set to ${networkDisplayLabel(activeNetwork)}. Switch networks to view and claim it.`,
    }
  }

  const nowUnix = opts.nowUnix ?? Math.floor(Date.now() / 1000)
  const { horizonUrl } = getNetwork()
  const server = new Horizon.Server(horizonUrl)

  try {
    const cbCall = (
      server as unknown as {
        claimableBalances: () => {
          claimableBalance: (id: string) => { call: () => Promise<Record<string, unknown>> }
        }
      }
    )
      .claimableBalances()
      .claimableBalance(cleanId)
    const record = await cbCall.call()
    const { code, issuer } = parseHorizonAsset(String(record.asset ?? 'native'))
    const amount = String(record.amount ?? '0')
    const sponsor = typeof record.sponsor === 'string' ? record.sponsor : null
    const claimantsRaw = Array.isArray(record.claimants) ? record.claimants : []
    const claimantAddresses = claimantsRaw
      .map((c) => (c as { destination?: unknown })?.destination)
      .filter((d): d is string => typeof d === 'string' && d.length > 0)
    const expiresAt = extractDeadlineUnix(claimantsRaw)
    const expired = expiresAt !== null && nowUnix >= expiresAt
    const verification = resolveWebClaimAssetVerification(code, issuer, activeNetwork)

    return {
      status: 'claimable',
      balanceId: cleanId,
      amount,
      assetCode: code,
      assetIssuer: issuer,
      sponsor,
      claimantAddresses,
      expiresAt,
      expired,
      expiryLabel: expiresAt !== null ? formatWebClaimExpiry(expiresAt, nowUnix) : null,
      ...verification,
    }
  } catch (err) {
    if (!isHorizonNotFound(err)) {
      throw err
    }

    const history = await lookupBalanceClaimHistory(server, cleanId)
    if (history.status === 'lookup_failed') {
      return {
        status: 'status_unknown',
        balanceId: cleanId,
        message: WEB_HISTORY_CHECK_FAILED_MESSAGE,
      }
    }
    if (history.status === 'no_claim_in_history') {
      return {
        status: 'not_found',
        balanceId: cleanId,
        message: `No claimable balance with this ID was found on ${networkDisplayLabel(activeNetwork)}. Check that the link is complete and that your wallet is set to the sender’s network.`,
      }
    }

    // If an earlier two-step attempt claimed this exact balance into the
    // link's one-time account and failed before sweeping, let a retry finish
    // sweeping those funds instead of stranding them behind "already claimed".
    const cleanSecret = opts.ephemeralSecret?.trim() || ''
    if (cleanSecret && StrKey.isValidEd25519SecretSeed(cleanSecret)) {
      const ephPub = Keypair.fromSecret(cleanSecret).publicKey()
      if (history.claimant === ephPub) {
        try {
          const ephAcct = await server.loadAccount(ephPub)
          const stranded = summarizeStrandedEphemeral(ephAcct)
          if (stranded) {
            const verification = resolveWebClaimAssetVerification(
              stranded.assetCode,
              stranded.assetIssuer,
              activeNetwork,
            )
            return {
              status: 'claimable',
              balanceId: cleanId,
              amount: stranded.amount,
              assetCode: stranded.assetCode,
              assetIssuer: stranded.assetIssuer,
              sponsor: history.sponsor,
              claimantAddresses: [ephPub],
              expiresAt: null,
              expired: false,
              expiryLabel: 'Claimed into one-time link account · tap below to sweep into your Spending account',
              strandedSweepOnly: true,
              ...verification,
            }
          }
        } catch (acctErr) {
          if (!isHorizonNotFound(acctErr)) {
            throw acctErr
          }
        }
      }
    }

    const reclaimedBySender = Boolean(
      history.claimant && history.sponsor && history.claimant === history.sponsor,
    )
    return {
      status: 'consumed',
      balanceId: cleanId,
      reclaimedBySender,
      message: reclaimedBySender
        ? EXPIRED_AND_RECLAIMED_WEB_MESSAGE
        : ALREADY_CLAIMED_WEB_MESSAGE,
    }
  }
}

function isOpDoesNotExistError(err: unknown): boolean {
  const doc = (
    err as {
      response?: {
        data?: {
          extras?: {
            result_codes?: {
              operations?: string[]
              inner_transaction?: { operations?: string[] }
            }
          }
        }
      }
    }
  )?.response?.data?.extras?.result_codes
  const ops = doc?.operations ?? []
  const innerOps = doc?.inner_transaction?.operations ?? []
  return ops.includes('op_does_not_exist') || innerOps.includes('op_does_not_exist')
}

async function waitForNextWebLedger(
  server: Horizon.Server,
  claimLedger: number | undefined,
): Promise<void> {
  if (typeof claimLedger !== 'number' || !Number.isFinite(claimLedger) || claimLedger <= 0) {
    return
  }
  const ledgersFn = (
    server as unknown as {
      ledgers?: () => {
        order: (dir: 'asc' | 'desc') => {
          limit: (n: number) => {
            call: () => Promise<{ records?: { sequence?: number }[] }>
          }
        }
      }
    }
  ).ledgers
  if (typeof ledgersFn !== 'function') return

  for (let attempt = 0; attempt < 12; attempt += 1) {
    try {
      const page = await ledgersFn.call(server).order('desc').limit(1).call()
      const latest = page?.records?.[0]?.sequence
      if (typeof latest === 'number' && latest > claimLedger) {
        return
      }
    } catch {
      return
    }
    await new Promise((resolve) => setTimeout(resolve, 1_200))
  }
}

function hasSweepingWorkForPayer(
  ephemeralAccount: Horizon.AccountResponse,
  payerPublicKey: string,
): boolean {
  if (summarizeStrandedEphemeral(ephemeralAccount) !== null) return true
  const sponsor = (ephemeralAccount as unknown as { sponsor?: string }).sponsor
  return sponsor === payerPublicKey
}

async function sweepFundedWebEphemeralAccount(params: {
  server: Horizon.Server
  networkPassphrase: string
  feeStr: string
  feePayer: Keypair
  payerAccount: Horizon.AccountResponse
  payerBalances: HorizonBalanceLike[]
  ephemeralKeypair: Keypair
  ephemeralAccount: Horizon.AccountResponse
}): Promise<WebClaimExecutionResult> {
  const {
    server,
    networkPassphrase,
    feeStr,
    feePayer,
    payerAccount,
    payerBalances,
    ephemeralKeypair,
    ephemeralAccount,
  } = params
  const destination = feePayer.publicKey()
  const ephPub = ephemeralKeypair.publicKey()
  const ephBalances = (ephemeralAccount.balances ?? []) as HorizonBalanceLike[]

  const builder = new TransactionBuilder(payerAccount, {
    fee: feeStr,
    networkPassphrase,
  })

  let sweptAssetCode = 'XLM'
  let sweptAssetIssuer: string | null = null
  let sweptAmount = '0'

  for (const b of ephBalances) {
    if (b.asset_type === 'native') {
      sweptAmount = b.balance ?? '0'
      continue
    }
    if (!b.asset_code || !b.asset_issuer) continue
    const creditAsset = new Asset(b.asset_code, b.asset_issuer)
    const hasPositiveBalance = Number(b.balance ?? '0') > 0
    if (hasPositiveBalance) {
      sweptAssetCode = b.asset_code
      sweptAssetIssuer = b.asset_issuer
      sweptAmount = b.balance
      if (!hasTrustline(payerBalances, b.asset_code, b.asset_issuer)) {
        builder.addOperation(Operation.changeTrust({ asset: creditAsset }))
      }
      builder.addOperation(
        Operation.payment({
          destination,
          asset: creditAsset,
          amount: b.balance,
          source: ephPub,
        }),
      )
    }
    builder.addOperation(
      Operation.changeTrust({
        asset: creditAsset,
        limit: '0',
        source: ephPub,
      }),
    )
  }

  builder.addOperation(
    Operation.accountMerge({
      destination,
      source: ephPub,
    }),
  )

  const sweepTx = builder.setTimeout(60).build()
  sweepTx.sign(feePayer)
  sweepTx.sign(ephemeralKeypair)
  const res = await server.submitTransaction(sweepTx)

  return {
    status: 'claimed',
    txHash: res.hash,
    mergeTxHash: res.hash,
    reserveReleased: true,
    reserveReleaseTxHash: res.hash,
    amount: sweptAmount,
    assetCode: sweptAssetCode,
    assetIssuer: sweptAssetIssuer,
    destination,
  }
}

function formatWebReserveReleaseError(err: unknown): string {
  const readable = horizonErrorMessage(err)
  if (readable) return readable
  if (err instanceof Error && err.message) return err.message
  return 'Could not release the 1 XLM sponsor reserve.'
}

async function submitWebReserveReleaseMerge(params: {
  server: Horizon.Server
  networkPassphrase: string
  feeStr: string
  feePayer: Keypair
  ephemeralKeypair: Keypair
  waitAfterLedger?: number
  checkAlreadyGoneOnError?: boolean
}): Promise<WebReserveReleaseRetryResult> {
  const {
    server,
    networkPassphrase,
    feeStr,
    feePayer,
    ephemeralKeypair,
    waitAfterLedger,
    checkAlreadyGoneOnError,
  } = params
  const destination = feePayer.publicKey()
  const ephPub = ephemeralKeypair.publicKey()

  try {
    if (typeof waitAfterLedger === 'number') {
      await waitForNextWebLedger(server, waitAfterLedger)
    }
    const refreshedPayer = await server.loadAccount(destination)
    const mergeTx = new TransactionBuilder(refreshedPayer, {
      fee: feeStr,
      networkPassphrase,
    })
      .addOperation(
        Operation.accountMerge({
          destination,
          source: ephPub,
        }),
      )
      .setTimeout(60)
      .build()
    mergeTx.sign(feePayer)
    mergeTx.sign(ephemeralKeypair)
    const mergeRes = await server.submitTransaction(mergeTx)
    return { released: true, txHash: mergeRes.hash }
  } catch (err) {
    if (checkAlreadyGoneOnError) {
      try {
        await server.loadAccount(ephPub)
      } catch (checkErr) {
        if (isHorizonNotFound(checkErr)) {
          return { released: true, txHash: null }
        }
      }
    }
    return { released: false, error: formatWebReserveReleaseError(err) }
  }
}

/**
 * Retry Tx 2 (`accountMerge`) on the web wallet to release the 1 XLM sponsored
 * base reserve held on the one-time claimant account after Tx 1 delivered funds.
 */
export async function retryWebReserveRelease(params: {
  ephemeralSecret: string
}): Promise<WebReserveReleaseRetryResult> {
  const feePayer = peekFeePayerKeypair()
  if (!feePayer) {
    return {
      released: false,
      error: 'The wallet is locked: unlock with your passkey to use your Spending account.',
    }
  }
  const cleanSecret = params.ephemeralSecret.trim()
  if (!StrKey.isValidEd25519SecretSeed(cleanSecret)) {
    return {
      released: false,
      error: 'The link bearer secret (#s=…) is missing. Reopen the original link to retry.',
    }
  }
  const { horizonUrl, networkPassphrase } = getNetwork()
  const server = new Horizon.Server(horizonUrl)
  return submitWebReserveReleaseMerge({
    server,
    networkPassphrase,
    feeStr: inclusionFee(),
    feePayer,
    ephemeralKeypair: Keypair.fromSecret(cleanSecret),
    checkAlreadyGoneOnError: true,
  })
}

/**
 * Claim a bearer link on the web wallet without stranding funds, exposing a
 * `1.5 XLM` bait-link window, or hitting Stellar's `op_seq_num_too_far` refusal
 * on same-ledger `createAccount` + `accountMerge`:
 *  - Tx 1 (atomic claim + immediate delivery): sponsors a `0-XLM` one-time
 *    account (`beginSponsoringFutureReserves` + `createAccount('0')` +
 *    `endSponsoringFutureReserves`), claims the balance, and immediately sends
 *    100% of the claimed XLM or issued asset into the user's Spending account
 *    (closing any temporary trustline in the same transaction).
 *  - Tx 2 (next-ledger reserve release): once the next ledger closes (~5s),
 *    merges the empty `0-XLM` one-time account to release the `1 XLM`
 *    sponsored base reserve; if interrupted, retry finishes the merge cleanly.
 */
export async function claimWebLink(params: {
  balanceId: string
  ephemeralSecret: string
  linkNetwork?: VeilNetworkName | null
}): Promise<WebClaimExecutionResult> {
  const feePayer = peekFeePayerKeypair()
  if (!feePayer) {
    throw new Error('The wallet is locked: unlock with your passkey to use your Spending account.')
  }

  const cleanSecret = params.ephemeralSecret.trim()
  if (!StrKey.isValidEd25519SecretSeed(cleanSecret)) {
    throw new Error(
      'This claim link is missing a valid bearer secret (#s=…). Open the full link shared with you.',
    )
  }
  const ephemeralKeypair = Keypair.fromSecret(cleanSecret)
  const ephPub = ephemeralKeypair.publicKey()

  const inspection = await inspectWebClaimLink(params.balanceId, {
    linkNetwork: params.linkNetwork ?? null,
    ephemeralSecret: cleanSecret,
  })
  if (
    inspection.status === 'network_mismatch' ||
    inspection.status === 'not_found' ||
    inspection.status === 'status_unknown'
  ) {
    throw new Error(inspection.message)
  }

  const { horizonUrl, networkPassphrase } = getNetwork()
  const server = new Horizon.Server(horizonUrl)
  const feeStr = inclusionFee()
  const destination = feePayer.publicKey()

  let payerAccount: Horizon.AccountResponse
  try {
    payerAccount = await server.loadAccount(destination)
  } catch (err) {
    if (isHorizonNotFound(err)) {
      throw new Error(
        'Your Spending account has no XLM on this network yet. Fund your Spending account first to cover the claim fee.',
      )
    }
    throw err
  }
  const payerBalances = (payerAccount.balances ?? []) as HorizonBalanceLike[]

  let ephemeralAccount: Horizon.AccountResponse | null = null
  try {
    ephemeralAccount = await server.loadAccount(ephPub)
  } catch (err) {
    if (!isHorizonNotFound(err)) {
      throw err
    }
  }

  if (inspection.status === 'consumed' || inspection.strandedSweepOnly) {
    if (ephemeralAccount && hasSweepingWorkForPayer(ephemeralAccount, destination)) {
      return sweepFundedWebEphemeralAccount({
        server,
        networkPassphrase,
        feeStr,
        feePayer,
        payerAccount,
        payerBalances,
        ephemeralKeypair,
        ephemeralAccount,
      })
    }
    return {
      status: 'already_claimed',
      message:
        inspection.status === 'consumed' ? inspection.message : ALREADY_CLAIMED_WEB_MESSAGE,
    }
  }

  if (
    inspection.claimantAddresses.length > 0 &&
    !inspection.claimantAddresses.includes(ephPub)
  ) {
    throw new Error('This link’s secret does not match the on-chain claimable balance.')
  }

  const nativeBal = Number(payerBalances.find((b) => b.asset_type === 'native')?.balance ?? '0')
  const nativeLiab = Number(
    payerBalances.find((b) => b.asset_type === 'native')?.selling_liabilities ?? '0',
  )
  const subentries = Number(
    (payerAccount as unknown as { subentry_count?: number }).subentry_count ?? 0,
  )
  const numSponsoring = Number(
    (payerAccount as unknown as { num_sponsoring?: number }).num_sponsoring ?? 0,
  )
  const numSponsored = Number(
    (payerAccount as unknown as { num_sponsored?: number }).num_sponsored ?? 0,
  )
  const ownReserve = Math.max(0, 2 + subentries + numSponsoring - numSponsored) * 0.5
  const spareXlm = Math.max(0, nativeBal - ownReserve - nativeLiab)

  const isNative = inspection.assetCode === 'XLM' && !inspection.assetIssuer
  const ephemeralExists = ephemeralAccount !== null

  if (!isNative && (!inspection.assetIssuer || !StrKey.isValidEd25519PublicKey(inspection.assetIssuer))) {
    throw new Error(`Invalid on-chain issuer for ${inspection.assetCode}.`)
  }
  const issuedAsset = isNative ? null : new Asset(inspection.assetCode, inspection.assetIssuer as string)
  const payerHasTrust = issuedAsset
    ? hasTrustline(payerBalances, issuedAsset.getCode(), issuedAsset.getIssuer())
    : true
  const ephemeralHasTrust =
    issuedAsset && ephemeralAccount
      ? hasTrustline(
          (ephemeralAccount.balances ?? []) as HorizonBalanceLike[],
          issuedAsset.getCode(),
          issuedAsset.getIssuer(),
        )
      : false

  const tempSponsoredXlm = ephemeralExists
    ? issuedAsset && !ephemeralHasTrust
      ? 0.5
      : 0
    : issuedAsset
      ? 1.5
      : 1
  const trustXlm = !payerHasTrust && issuedAsset ? 0.5 : 0
  const requiredSpare = tempSponsoredXlm + trustXlm + 0.05
  if (spareXlm < requiredSpare) {
    throw new Error(
      `Your Spending account needs at least ${requiredSpare.toFixed(2)} XLM above its reserve to claim ${inspection.assetCode} (${tempSponsoredXlm > 0 ? 'temporary reserve is released automatically right after claiming' : 'for trustline and fees'}).`,
    )
  }

  const claimBuilder = new TransactionBuilder(payerAccount, {
    fee: feeStr,
    networkPassphrase,
  })
  if (issuedAsset && !payerHasTrust) {
    claimBuilder.addOperation(Operation.changeTrust({ asset: issuedAsset }))
  }
  if (!ephemeralExists) {
    claimBuilder.addOperation(Operation.beginSponsoringFutureReserves({ sponsoredId: ephPub }))
    claimBuilder.addOperation(
      Operation.createAccount({
        destination: ephPub,
        startingBalance: '0',
      }),
    )
    if (issuedAsset) {
      claimBuilder.addOperation(Operation.changeTrust({ asset: issuedAsset, source: ephPub }))
    }
    claimBuilder.addOperation(Operation.endSponsoringFutureReserves({ source: ephPub }))
  } else if (issuedAsset && !ephemeralHasTrust) {
    claimBuilder.addOperation(Operation.beginSponsoringFutureReserves({ sponsoredId: ephPub }))
    claimBuilder.addOperation(Operation.changeTrust({ asset: issuedAsset, source: ephPub }))
    claimBuilder.addOperation(Operation.endSponsoringFutureReserves({ source: ephPub }))
  }

  claimBuilder
    .addOperation(
      Operation.claimClaimableBalance({
        balanceId: inspection.balanceId,
        source: ephPub,
      }),
    )
    .addOperation(
      Operation.payment({
        destination,
        asset: issuedAsset ?? Asset.native(),
        amount: inspection.amount,
        source: ephPub,
      }),
    )

  if (issuedAsset) {
    claimBuilder.addOperation(
      Operation.changeTrust({
        asset: issuedAsset,
        limit: '0',
        source: ephPub,
      }),
    )
  }

  const claimTx = claimBuilder.setTimeout(60).build()
  claimTx.sign(feePayer)
  claimTx.sign(ephemeralKeypair)

  let claimRes: Horizon.HorizonApi.SubmitTransactionResponse
  try {
    claimRes = await server.submitTransaction(claimTx)
  } catch (err) {
    if (isOpDoesNotExistError(err)) {
      return { status: 'already_claimed', message: ALREADY_CLAIMED_WEB_MESSAGE }
    }
    const readable = horizonErrorMessage(err)
    throw new Error(readable || (err instanceof Error ? err.message : 'Could not claim this link.'))
  }

  // Tx 2: release the 1 XLM sponsored base reserve once the ledger advances past `claimRes.ledger`.
  // Never swallow a failed merge silently — return structured status so the page
  // keeps `#s=` and the secret intact and lets the user retry releasing the reserve.
  const claimLedger = (claimRes as unknown as { ledger?: number }).ledger
  const release = await submitWebReserveReleaseMerge({
    server,
    networkPassphrase,
    feeStr,
    feePayer,
    ephemeralKeypair,
    waitAfterLedger: !ephemeralExists ? claimLedger : undefined,
  })

  return {
    status: 'claimed',
    txHash: claimRes.hash,
    mergeTxHash: release.released ? release.txHash : null,
    reserveReleased: release.released,
    ...(release.released && release.txHash ? { reserveReleaseTxHash: release.txHash } : {}),
    ...(!release.released ? { reserveReleaseError: release.error } : {}),
    amount: inspection.amount,
    assetCode: inspection.assetCode,
    assetIssuer: inspection.assetIssuer,
    destination,
  }
}
