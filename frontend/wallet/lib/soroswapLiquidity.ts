/**
 * #1308 — Soroswap liquidity, beside the swap path (#793) and sharing its
 * router configuration.
 *
 * Adding liquidity is what mints an LP token; removing it burns one. Both are
 * built by the same Soroswap client the swap screen uses, and both are signed
 * through the wallet's existing Soroban path (`signAndSubmitSorobanXdr`), so
 * there is no second router address and no second signing flow.
 *
 * Everything here quotes the pool the wallet actually found. A pair with no
 * pool is reported as such — never invented, never substituted — and a pool
 * whose tokens are not the SACs derived from the assets' code:issuer is
 * refused, for the same reason a mismatch quote is refused in swapAssets.ts.
 *
 * The amounts are stroops (bigint). Ratios come from the pool's reserves; the
 * LP minted is `amount / reserve * total supply`, which is the same
 * proportional maths the mobile pools screen quotes for the same inputs.
 */

import {
  Account,
  Address,
  BASE_FEE,
  Operation,
  TransactionBuilder,
  rpc as SorobanRpc,
  scValToNative,
} from '@stellar/stellar-sdk'
import {
  SoroswapSDK,
  SupportedProtocols,
  type AddLiquidityRequest,
  type RemoveLiquidityRequest,
} from '@soroswap/sdk'
import { getSoroswapClient, getSoroswapNetwork } from '@/lib/soroswap'
import type { SwapAsset } from '@/lib/swapAssets'

/** 0.5% — the same default the swap screen uses, and the mobile pools screen. */
export const DEFAULT_LIQUIDITY_SLIPPAGE_BPS = 50

export const LIQUIDITY_SLIPPAGE_OPTIONS = [
  { label: '0.1%', bps: 10 },
  { label: '0.5%', bps: 50 },
  { label: '1.0%', bps: 100 },
] as const

const BPS = 10_000

export const IMPERMANENT_LOSS_SENTENCE =
  'Impermanent loss: if the price of the two assets moves after you deposit, ' +
  'the value of your position can end up lower than simply holding both assets.'

/** One Soroswap AMM pool, normalised to the token order it was asked about. */
export interface SoroswapPoolView {
  address: string
  tokenA: string
  tokenB: string
  reserveA: bigint
  reserveB: bigint
  /** LP token total supply, when the pool record carries it (`reserveLp`). */
  lpSupply: bigint | null
}

export type PoolLookup =
  | { ok: true; pool: SoroswapPoolView }
  | { ok: false; kind: 'unavailable' | 'none' | 'mismatch'; reason: string }

export function noSoroswapPoolMessage(a: string, b: string): string {
  return (
    `No Soroswap pool exists for ${a} / ${b}. Veil does not create or guess a pool — ` +
    'choose a pair the wallet already holds assets for.'
  )
}

function toBigInt(value: unknown): bigint | null {
  if (typeof value === 'bigint') return value
  if (typeof value === 'number' && Number.isFinite(value)) return BigInt(Math.trunc(value))
  if (typeof value === 'string' && /^\d+$/.test(value.trim())) return BigInt(value.trim())
  return null
}

/**
 * The pool record for exactly the pair asked about. A record for other tokens
 * is a mismatch, not a pool: the wallet derives every token by code:issuer and
 * refuses to supply liquidity to a contract it did not ask about.
 */
export function parseSoroswapPool(
  raw: unknown,
  tokenA: string,
  tokenB: string,
): SoroswapPoolView | null {
  if (!raw || typeof raw !== 'object') return null
  const record = raw as Record<string, unknown>
  if (typeof record.protocol === 'string' && record.protocol !== SupportedProtocols.SOROSWAP) return null
  if (typeof record.address !== 'string' || !record.address) return null

  const recordA = record.tokenA
  const recordB = record.tokenB
  if (typeof recordA !== 'string' || typeof recordB !== 'string') return null

  let reserveA = toBigInt(record.reserveA)
  let reserveB = toBigInt(record.reserveB)
  if (!reserveA || !reserveB) return null

  if (recordA === tokenA && recordB === tokenB) {
    // already in the requested order
  } else if (recordA === tokenB && recordB === tokenA) {
    ;[reserveA, reserveB] = [reserveB, reserveA]
  } else {
    return null
  }

  if (reserveA <= 0n || reserveB <= 0n) return null

  const lpSupply = toBigInt(record.reserveLp)

  return {
    address: record.address,
    tokenA,
    tokenB,
    reserveA,
    reserveB,
    lpSupply: lpSupply && lpSupply > 0n ? lpSupply : null,
  }
}

/**
 * Find the Soroswap pool for a pair, by the SACs derived from each asset's
 * code:issuer. `none` means the pair has no pool; that is a finished answer,
 * not a reason to try a different pair behind the user's back.
 */
export async function getSoroswapLiquidityPool(
  tokenA: string,
  tokenB: string,
  aLabel: string,
  bLabel: string,
): Promise<PoolLookup> {
  const client = getSoroswapClient()
  if (!client) {
    return {
      ok: false,
      kind: 'unavailable',
      reason: 'Soroswap liquidity is not configured in this build (no API key).',
    }
  }

  let pools: unknown
  try {
    pools = await client.getPoolByTokens(
      tokenA,
      tokenB,
      getSoroswapNetwork(),
      [SupportedProtocols.SOROSWAP],
    )
  } catch (err) {
    console.warn('[soroswap-liquidity] getPoolByTokens failed:', err)
    return { ok: false, kind: 'unavailable', reason: 'Soroswap could not be reached.' }
  }

  if (!Array.isArray(pools) || pools.length === 0) {
    return { ok: false, kind: 'none', reason: noSoroswapPoolMessage(aLabel, bLabel) }
  }

  for (const raw of pools) {
    const pool = parseSoroswapPool(raw, tokenA, tokenB)
    if (pool) return { ok: true, pool }
  }

  return {
    ok: false,
    kind: 'mismatch',
    reason:
      'Soroswap returned a pool for different tokens than the pair requested, so it was discarded.',
  }
}

export interface LpPosition {
  poolAddress: string
  tokenA: string
  tokenB: string
  totalSupply: bigint
  userLp: bigint
}

/**
 * One entry of `GET /liquidity/positions`. The API names the nested record
 * `poolInfo`; the SDK's type calls it `poolInformation`, so both are read.
 */
export function parseSoroswapPosition(raw: unknown): LpPosition | null {
  if (!raw || typeof raw !== 'object') return null
  const record = raw as Record<string, unknown>
  const info = (record.poolInfo ?? record.poolInformation) as Record<string, unknown> | undefined
  if (!info || typeof info !== 'object') return null

  const tokenAddress = (token: unknown): string | null => {
    if (typeof token === 'string') return token
    if (token && typeof token === 'object') {
      const address = (token as { address?: unknown }).address
      if (typeof address === 'string') return address
    }
    return null
  }

  const tokenA = tokenAddress(info.tokenA)
  const tokenB = tokenAddress(info.tokenB)
  const totalSupply = toBigInt(info.totalSupply)
  const userLp = toBigInt(record.userPosition)
  if (typeof info.address !== 'string' || !tokenA || !tokenB || !totalSupply || userLp === null) {
    return null
  }

  return {
    poolAddress: info.address,
    tokenA,
    tokenB,
    totalSupply,
    userLp,
  }
}

export async function getSoroswapPositions(address: string): Promise<LpPosition[]> {
  const client = getSoroswapClient()
  if (!client) return []
  try {
    const raw = await client.getUserPositions(address, getSoroswapNetwork())
    if (!Array.isArray(raw)) return []
    return raw.map(parseSoroswapPosition).filter((p): p is LpPosition => p !== null)
  } catch (err) {
    console.warn('[soroswap-liquidity] getUserPositions failed:', err)
    return []
  }
}

/**
 * The pool contract is itself the LP token, so its `total_supply` is the
 * denominator of the pool share. Read only when neither the pool record nor a
 * position carried it — never estimated, because a share computed against a
 * guessed supply is a fabricated number over someone's money.
 */
export async function readLpTotalSupply(params: {
  poolAddress: string
  sourceAddress: string
  rpcUrl: string
  networkPassphrase: string
}): Promise<bigint | null> {
  try {
    const server = new SorobanRpc.Server(params.rpcUrl)
    const account = new Account(params.sourceAddress, '0')
    const tx = new TransactionBuilder(account, {
      fee: BASE_FEE,
      networkPassphrase: params.networkPassphrase,
    })
      .addOperation(
        Operation.invokeContractFunction({
          contract: params.poolAddress,
          function: 'total_supply',
          args: [],
        }),
      )
      .setTimeout(30)
      .build()

    const sim = await server.simulateTransaction(tx)
    if (SorobanRpc.Api.isSimulationError(sim)) return null
    const retval = sim.result?.retval
    if (!retval) return null
    const native = scValToNative(retval)
    return toBigInt(native)
  } catch (err) {
    console.warn('[soroswap-liquidity] total_supply read failed:', err)
    return null
  }
}

/** Decimal input in whole units to stroops, or null when malformed. */
export function parseAmountToStroops(value: string): bigint | null {
  const trimmed = value.trim()
  if (!/^\d+(\.\d{1,7})?$/.test(trimmed)) return null
  const [whole, fraction = ''] = trimmed.split('.')
  const stroops = BigInt(whole!) * 10_000_000n + BigInt(fraction.padEnd(7, '0'))
  return stroops > 0n ? stroops : null
}

export function formatStroops(value: bigint, maxFractionDigits = 7): string {
  const negative = value < 0n
  const abs = negative ? -value : value
  const whole = abs / 10_000_000n
  const fraction = (abs % 10_000_000n).toString().padStart(7, '0').slice(0, maxFractionDigits).replace(/0+$/, '')
  return `${negative ? '-' : ''}${whole.toString()}${fraction ? `.${fraction}` : ''}`
}

function floorDiv(a: bigint, b: bigint): bigint {
  return a / b
}

function ceilDiv(a: bigint, b: bigint): bigint {
  return (a + b - 1n) / b
}

export interface AddLiquidityQuote {
  amountA: bigint
  amountB: bigint
  /** The most B this deposit may take at the reviewed slippage. */
  maxB: bigint
  /** Router minimums for the transaction, from the reviewed amounts. */
  minA: bigint
  minB: bigint
  mintedLp: bigint | null
  shareBefore: number | null
  shareAfter: number | null
  /** B required per one A, from the pool reserves. */
  ratio: number
}

export type QuoteResult<T> = { ok: true; quote: T } | { ok: false; reason: string }

/**
 * Add-liquidity quote for `amountA`: B is derived from the pool's reserves,
 * because a Soroswap deposit has to arrive at the pool's current ratio. LP
 * minted is proportional to the share of reserve A being supplied.
 */
export function quoteAddLiquidity(
  pool: SoroswapPoolView,
  amountA: bigint,
  slippageBps: number,
  userLp: bigint,
  lpSupply: bigint | null,
): QuoteResult<AddLiquidityQuote> {
  if (amountA <= 0n) return { ok: false, reason: 'Enter an amount of the first asset.' }
  if (pool.reserveA <= 0n || pool.reserveB <= 0n) {
    return { ok: false, reason: 'This pool has no reserves to quote against.' }
  }
  if (!Number.isInteger(slippageBps) || slippageBps < 0 || slippageBps >= BPS) {
    return { ok: false, reason: 'Slippage must be between 0% and 100%.' }
  }

  const amountB = ceilDiv(amountA * pool.reserveB, pool.reserveA)
  const maxB = ceilDiv(amountB * BigInt(BPS + slippageBps), BigInt(BPS))
  const minA = floorDiv(amountA * BigInt(BPS - slippageBps), BigInt(BPS))
  const minB = floorDiv(amountB * BigInt(BPS - slippageBps), BigInt(BPS))

  let mintedLp: bigint | null = null
  let shareBefore: number | null = null
  let shareAfter: number | null = null
  if (lpSupply && lpSupply > 0n) {
    mintedLp = floorDiv(amountA * lpSupply, pool.reserveA)
    shareBefore = Number(userLp) / Number(lpSupply)
    shareAfter = Number(userLp + mintedLp) / Number(lpSupply + mintedLp)
  }

  return {
    ok: true,
    quote: {
      amountA,
      amountB,
      maxB,
      minA,
      minB,
      mintedLp,
      shareBefore,
      shareAfter,
      ratio: Number(pool.reserveB) / Number(pool.reserveA),
    },
  }
}

export interface RemoveLiquidityQuote {
  liquidity: bigint
  amountA: bigint
  amountB: bigint
  minA: bigint
  minB: bigint
  shareBurned: number
}

/** What burning `liquidity` LP returns, in both assets, before confirming. */
export function quoteRemoveLiquidity(
  pool: SoroswapPoolView,
  liquidity: bigint,
  slippageBps: number,
  lpSupply: bigint | null,
  userLp: bigint,
): QuoteResult<RemoveLiquidityQuote> {
  if (liquidity <= 0n) return { ok: false, reason: 'Enter a share of your position to remove.' }
  if (userLp <= 0n) return { ok: false, reason: 'This account holds no LP tokens in this pool.' }
  if (liquidity > userLp) {
    return { ok: false, reason: 'You cannot remove more LP tokens than this account holds.' }
  }
  if (!lpSupply || lpSupply <= 0n) {
    return { ok: false, reason: 'The pool’s LP supply could not be read, so the payout cannot be quoted.' }
  }
  if (!Number.isInteger(slippageBps) || slippageBps < 0 || slippageBps >= BPS) {
    return { ok: false, reason: 'Slippage must be between 0% and 100%.' }
  }

  const amountA = floorDiv(liquidity * pool.reserveA, lpSupply)
  const amountB = floorDiv(liquidity * pool.reserveB, lpSupply)
  const minA = floorDiv(amountA * BigInt(BPS - slippageBps), BigInt(BPS))
  const minB = floorDiv(amountB * BigInt(BPS - slippageBps), BigInt(BPS))

  return {
    ok: true,
    quote: {
      liquidity,
      amountA,
      amountB,
      minA,
      minB,
      shareBurned: Number(liquidity) / Number(lpSupply),
    },
  }
}

/**
 * Whether the pool moved past the slippage the user reviewed. The review is a
 * promise about the worst case: paying more B than `maxB` for an add, or
 * receiving less than `minA`/`minB` for a remove, is a breach and nothing is
 * submitted until the user reviews a fresh quote.
 */
export function addLiquiditySlippageBreach(
  reviewed: AddLiquidityQuote,
  currentAmountB: bigint,
  slippageBps: number,
): string | null {
  if (currentAmountB <= reviewed.maxB) return null
  return (
    `The pool now needs ${formatStroops(currentAmountB)} of the second asset, above the ` +
    `${formatStroops(reviewed.maxB)} you approved at ${slippageBps / 100}% slippage. ` +
    'Nothing was submitted — review a fresh quote.'
  )
}

export function removeLiquiditySlippageBreach(
  reviewed: RemoveLiquidityQuote,
  current: RemoveLiquidityQuote,
  slippageBps: number,
): string | null {
  if (current.amountA >= reviewed.minA && current.amountB >= reviewed.minB) return null
  return (
    `The pool moved: those LP tokens now return less than the minimum you approved at ` +
    `${slippageBps / 100}% slippage. Nothing was submitted — review a fresh quote.`
  )
}

export interface HeldBalance {
  code: string
  issuer: string | null
  balance: string
}

export function heldStroops(balances: HeldBalance[], asset: SwapAsset): bigint {
  const match = balances.find((b) =>
    asset.issuer
      ? b.code === asset.code && b.issuer === asset.issuer
      : b.code === 'XLM' && !b.issuer,
  )
  return match ? parseAmountToStroops(match.balance) ?? 0n : 0n
}

/**
 * The one-sided-balance explanation, shown as soon as a pair is picked rather
 * than as a failed simulation after the passkey prompt. A Soroswap deposit
 * needs both assets at the pool's ratio; holding one side is not a rejected
 * transaction, it is a missing ingredient, and saying so early is the point.
 */
export function liquidityBalanceIssue(params: {
  pairA: SwapAsset
  pairB: SwapAsset
  labelA: string
  labelB: string
  balances: HeldBalance[]
  requiredA?: bigint
  requiredB?: bigint
}): string | null {
  const { pairA, pairB, labelA, labelB, balances, requiredA, requiredB } = params
  const heldA = heldStroops(balances, pairA)
  const heldB = heldStroops(balances, pairB)

  if (heldA <= 0n && heldB <= 0n) {
    return `You hold neither ${labelA} nor ${labelB}. Adding liquidity needs both assets at the pool's ratio.`
  }
  if (heldA <= 0n) {
    return `You hold ${labelB} but no ${labelA}. A Soroswap pool takes both assets at its current ratio, so this add needs ${labelA} as well as ${labelB}.`
  }
  if (heldB <= 0n) {
    return `You hold ${labelA} but no ${labelB}. A Soroswap pool takes both assets at its current ratio, so this add needs ${labelB} as well as ${labelA}.`
  }
  if (requiredA !== undefined && requiredA > heldA) {
    return `This deposit needs ${formatStroops(requiredA)} ${labelA} at the pool's ratio, but you hold ${formatStroops(heldA)} ${labelA}.`
  }
  if (requiredB !== undefined && requiredB > heldB) {
    return (
      `This deposit needs ${formatStroops(requiredB)} ${labelB} at the pool's ratio, ` +
      `but you hold ${formatStroops(heldB)} ${labelB}. Lower the ${labelA} amount or add ${labelB} first.`
    )
  }
  return null
}

export function lpForPercent(userLp: bigint, percent: number): bigint {
  if (!Number.isFinite(percent) || percent <= 0) return 0n
  const clamped = Math.min(100, percent)
  // Basis points keep 0.01% steps without going through floating point for
  // amounts above Number.MAX_SAFE_INTEGER.
  const bps = BigInt(Math.round(clamped * 100))
  return floorDiv(userLp * bps, 10_000n)
}

/** 0.5 XLM in stroops: one Stellar base reserve. */
export const BASE_RESERVE_STROOPS = 5_000_000n

export interface AccountReserveFields {
  subentries: number
  /** Horizon `num_sponsored`: subentries another account pays the reserve for. */
  sponsoredByOthers?: number
  /** Horizon `num_sponsoring`: subentries this account pays the reserve for. */
  sponsoringOthers?: number
}

/**
 * The minimum XLM balance the account must keep: two base reserves for the
 * account itself, plus one per subentry (trustlines, offers, signers, data
 * entries), plus the ones it sponsors and minus the ones sponsored for it.
 * Horizon does not return this as a number on the account record, so it is
 * computed from the account's own fields rather than assumed.
 */
export function baseReserveStroops(fields: AccountReserveFields): bigint {
  const entries =
    2 +
    Math.max(0, Math.trunc(fields.subentries)) +
    Math.max(0, Math.trunc(fields.sponsoringOthers ?? 0)) -
    Math.max(0, Math.trunc(fields.sponsoredByOthers ?? 0))
  return BigInt(Math.max(2, entries)) * BASE_RESERVE_STROOPS
}

export interface XlmCapacity {
  balance: bigint
  reserve: bigint
  fee: bigint
  /** The most XLM a transaction may spend after the reserve and the fee. */
  spendable: bigint
}

export function xlmCapacity(
  fields: AccountReserveFields & { balance: bigint; fee: bigint },
): XlmCapacity {
  const reserve = baseReserveStroops(fields)
  const spendable = fields.balance - reserve - fields.fee
  return {
    balance: fields.balance,
    reserve,
    fee: fields.fee,
    spendable: spendable > 0n ? spendable : 0n,
  }
}

/**
 * Why a native-XLM deposit cannot be accepted, or null when it fits.
 *
 * A deposit that takes the whole XLM balance leaves nothing for the account's
 * base reserves or the network fee, so the account falls below its minimum
 * balance and the transaction fails after signing. This is checked before
 * signing, against the amount the router call will actually take.
 */
export function nativeXlmDepositIssue(params: {
  xlmAmount: bigint
  capacity: XlmCapacity
  label?: string
}): string | null {
  const { xlmAmount, capacity } = params
  if (xlmAmount <= 0n || xlmAmount <= capacity.spendable) return null
  const label = params.label ?? 'XLM'
  const feeClause =
    capacity.fee > 0n
      ? ` plus ${formatStroops(capacity.fee)} XLM for the network fee`
      : ''
  return (
    `This deposit would put ${formatStroops(xlmAmount)} XLM into the pool, but the account must ` +
    `keep ${formatStroops(capacity.reserve)} XLM in base reserves${feeClause}, leaving at most ` +
    `${formatStroops(capacity.spendable)} ${label} for the pool. Lower the amount — a deposit ` +
    'cannot take the whole XLM balance.'
  )
}

/** The simulated cost of a liquidity transaction, in stroops. */
export interface LiquidityFeeEstimate {
  inclusionFeeStroops: bigint
  minResourceFeeStroops: bigint
  totalStroops: bigint
}

export const FEE_UNAVAILABLE_SENTENCE =
  'Unavailable — the transaction could not be simulated, so the network fee cannot be shown.'

/**
 * Simulate the transaction the wallet is about to sign and read its cost from
 * the network: the transaction's own inclusion fee plus Soroban's minimum
 * resource fee. Returns null when the simulation does not answer, and the
 * caller says so rather than showing a constant.
 */
export async function simulateLiquidityFee(params: {
  xdr: string
  networkPassphrase: string
  rpcUrl: string
}): Promise<LiquidityFeeEstimate | null> {
  try {
    const transaction = TransactionBuilder.fromXDR(params.xdr, params.networkPassphrase)
    const inner = 'innerTransaction' in transaction ? transaction.innerTransaction : transaction
    const inclusionFeeStroops = BigInt(inner.fee)
    const server = new SorobanRpc.Server(params.rpcUrl)
    const sim = await server.simulateTransaction(transaction)
    if (SorobanRpc.Api.isSimulationError(sim)) return null
    const minResourceFeeStroops = toBigInt(sim.minResourceFee)
    if (minResourceFeeStroops === null) return null
    return {
      inclusionFeeStroops,
      minResourceFeeStroops,
      totalStroops: inclusionFeeStroops + minResourceFeeStroops,
    }
  } catch (err) {
    console.warn('[soroswap-liquidity] fee simulation failed:', err)
    return null
  }
}

/** The fee line on the review step: the simulated total, or an honest refusal. */
export function formatNetworkFee(estimate: LiquidityFeeEstimate | null): string {
  if (!estimate) return FEE_UNAVAILABLE_SENTENCE
  return `${formatStroops(estimate.totalStroops)} XLM`
}

function errorReason(err: unknown): string {
  if (typeof err === 'string') return err
  if (err instanceof Error) return err.message
  if (err && typeof err === 'object') {
    const message = (err as Record<string, unknown>).message
    if (typeof message === 'string') return message
    if (Array.isArray(message)) return message.join('; ')
  }
  return 'Soroswap could not build this liquidity transaction.'
}

export type BuiltLiquidity = {
  xdr: string
  minAmountA: bigint | null
  minAmountB: bigint | null
  poolAddress: string | null
}

export type BuildLiquidityResult =
  | { ok: true; built: BuiltLiquidity }
  | { ok: false; reason: string }

/**
 * The official SoroswapRouter contract ids, by the network the wallet is on.
 *
 * These are public on-chain contract addresses, published by Soroswap in
 * `soroswap/core` (`public/mainnet.contracts.json` and
 * `public/testnet.contracts.json`) and listed on
 * docs.soroswap.finance/amm/technical-reference/deployed-addresses. Both were
 * cross-checked against `api.soroswap.finance/api/<network>/router`. They are
 * deliberately literal: the point of pinning them is that no API response and
 * no returned transaction can change which contract the wallet signs for. A
 * network that is not in this table is refused, not guessed at.
 */
export const SOROSWAP_ROUTER_IDS = {
  mainnet: 'CAG5LRYQ5JVEUI5TEID72EYOVX44TTUJT5BQR2J6J77FH65PCCFAJDDH',
  testnet: 'CCJUD55AG6W5HAI5LRVNKAE5WDP5XGZBUDS5WNTIVDU7O264UZZE7BRD',
} as const

export type PinnedSoroswapNetwork = keyof typeof SOROSWAP_ROUTER_IDS

/** The pinned Soroswap router for a network name, or null when it is not pinned. */
export function pinnedSoroswapRouter(network: string): string | null {
  return network === 'mainnet' || network === 'testnet' ? SOROSWAP_ROUTER_IDS[network] : null
}

/**
 * What the user approved on the review step, in the terms the router call
 * itself uses, so the transaction the API returned can be checked against it.
 *
 * `network` is the wallet's active network name; the router id is looked up
 * from it, never from the transaction or an API response. `amountA`/`amountB`
 * are the most the reviewed deposit may take — B is the slippage maximum,
 * because the review allows the pool to move up to that bound — and
 * `liquidity` is the most LP a reviewed withdrawal may burn.
 */
export type LiquidityTransactionExpectation =
  | {
      action: 'add_liquidity'
      network: string
      tokenA: string
      tokenB: string
      /** The account that must own the LP position and the tokens. */
      to: string
      minAmountA: bigint
      minAmountB: bigint
      amountA: bigint
      amountB: bigint
    }
  | {
      action: 'remove_liquidity'
      network: string
      tokenA: string
      tokenB: string
      /** The account that must own the LP position and the tokens. */
      to: string
      minAmountA: bigint
      minAmountB: bigint
      liquidity: bigint
    }

/**
 * The argument positions of the Soroswap router's liquidity calls, from the
 * router interface (docs.soroswap.finance, SoroswapRouter):
 *
 * add_liquidity(token_a, token_b, amount_a_desired, amount_b_desired,
 *               amount_a_min, amount_b_min, to, deadline)
 * remove_liquidity(token_a, token_b, liquidity, amount_a_min, amount_b_min,
 *                  to, deadline)
 */
const LIQUIDITY_ARG_LAYOUT = {
  add_liquidity: { count: 8, desiredA: 2, desiredB: 3, minA: 4, minB: 5, to: 6 },
  remove_liquidity: { count: 7, liquidity: 2, minA: 3, minB: 4, to: 5 },
} as const

function addressArg(value: unknown): string | null {
  try {
    const native = scValToNative(value as never)
    return typeof native === 'string' && native.length > 0 ? native : null
  } catch {
    return null
  }
}

function intArg(value: unknown): bigint | null {
  try {
    return toBigInt(scValToNative(value as never))
  } catch {
    return null
  }
}

/**
 * Check the transaction Soroswap returned against the reviewed quote BEFORE it
 * is signed. The API builds and returns a transaction the wallet signs as it
 * comes, so this is the only place the reviewed promise is enforced on the
 * bytes that will actually be submitted: the call must be the pinned router
 * for the wallet's network, be the liquidity function for this pair, pay the
 * user's own account, take no more than the reviewed amounts, and hold
 * minimums no lower than the review step showed.
 *
 * Returns null when the transaction passes, or a user-facing reason when it
 * must not be signed.
 */
export function verifyLiquidityTransaction(params: {
  xdr: string
  networkPassphrase: string
  expected: LiquidityTransactionExpectation
}): string | null {
  const { expected } = params
  const router = pinnedSoroswapRouter(expected.network)
  if (!router) {
    return (
      `Veil has no pinned Soroswap router for ${expected.network || 'an unknown network'}, ` +
      'so this liquidity call cannot be checked. Nothing was signed.'
    )
  }

  let transaction
  try {
    transaction = TransactionBuilder.fromXDR(params.xdr, params.networkPassphrase)
  } catch {
    return 'Soroswap returned a transaction that could not be decoded. Nothing was signed.'
  }

  const inner = 'innerTransaction' in transaction ? transaction.innerTransaction : transaction
  const operations = inner.operations
  if (operations.length !== 1 || operations[0]?.type !== 'invokeHostFunction') {
    return 'Soroswap returned a transaction that is not a single liquidity call. Nothing was signed.'
  }

  const hostFunction = operations[0].func
  if (hostFunction.switch().name !== 'hostFunctionTypeInvokeContract') {
    return 'Soroswap returned a transaction that does not call the liquidity router. Nothing was signed.'
  }
  const call = hostFunction.invokeContract()

  let contractId: string
  try {
    contractId = Address.fromScAddress(call.contractAddress()).toString()
  } catch {
    return 'Soroswap returned a liquidity call whose contract address could not be read. Nothing was signed.'
  }
  if (contractId !== router) {
    return (
      `Soroswap returned a call to ${contractId}, not the pinned ${expected.network} Soroswap ` +
      `router ${router}. Nothing was signed.`
    )
  }

  const functionName = call.functionName().toString()
  if (functionName !== expected.action) {
    return `Soroswap returned a ${functionName} call instead of ${expected.action}. Nothing was signed.`
  }

  const layout = LIQUIDITY_ARG_LAYOUT[expected.action]
  const args = call.args()
  if (args.length !== layout.count) {
    return `Soroswap returned ${functionName} with ${args.length} arguments, which is not the router interface. Nothing was signed.`
  }

  const tokenA = addressArg(args[0])
  const tokenB = addressArg(args[1])
  if (tokenA !== expected.tokenA || tokenB !== expected.tokenB) {
    return 'Soroswap built the liquidity call for different assets than the pair you reviewed. Nothing was signed.'
  }

  const to = addressArg(args[layout.to])
  if (to !== expected.to) {
    return `Soroswap built the liquidity call for ${to ?? 'an unreadable account'} instead of your account. Nothing was signed.`
  }

  const minA = intArg(args[layout.minA])
  const minB = intArg(args[layout.minB])
  if (minA === null || minB === null) {
    return 'Soroswap returned a liquidity call whose minimums could not be read. Nothing was signed.'
  }
  if (minA < expected.minAmountA || minB < expected.minAmountB) {
    return (
      `Soroswap returned minimums of ${formatStroops(minA)} / ${formatStroops(minB)}, below the ` +
      `${formatStroops(expected.minAmountA)} / ${formatStroops(expected.minAmountB)} you approved. ` +
      'Nothing was signed — review a fresh quote.'
    )
  }

  if (expected.action === 'add_liquidity') {
    const desiredA = intArg(args[LIQUIDITY_ARG_LAYOUT.add_liquidity.desiredA])
    const desiredB = intArg(args[LIQUIDITY_ARG_LAYOUT.add_liquidity.desiredB])
    if (desiredA === null || desiredB === null) {
      return 'Soroswap returned a liquidity call whose amounts could not be read. Nothing was signed.'
    }
    if (desiredA > expected.amountA || desiredB > expected.amountB) {
      return (
        `Soroswap would take ${formatStroops(desiredA)} / ${formatStroops(desiredB)}, more than the ` +
        `${formatStroops(expected.amountA)} / ${formatStroops(expected.amountB)} you reviewed. ` +
        'Nothing was signed — review a fresh quote.'
      )
    }
  } else {
    const liquidity = intArg(args[LIQUIDITY_ARG_LAYOUT.remove_liquidity.liquidity])
    if (liquidity === null) {
      return 'Soroswap returned a liquidity call whose LP amount could not be read. Nothing was signed.'
    }
    if (liquidity > expected.liquidity) {
      return (
        `Soroswap would burn ${formatStroops(liquidity)} LP tokens, more than the ` +
        `${formatStroops(expected.liquidity)} you reviewed. Nothing was signed — review a fresh quote.`
      )
    }
  }

  return null
}

function normaliseLiquidityResponse(raw: unknown): BuiltLiquidity | null {
  if (!raw || typeof raw !== 'object') return null
  const record = raw as Record<string, unknown>
  if (typeof record.xdr !== 'string' || !record.xdr) return null
  const minAmountA = toBigInt(record.minAmountA)
  const minAmountB = toBigInt(record.minAmountB)
  const poolInfo = record.poolInfo as Record<string, unknown> | undefined
  const poolAddress = poolInfo && typeof poolInfo.address === 'string' ? poolInfo.address : null
  return { xdr: record.xdr, minAmountA, minAmountB, poolAddress }
}

/**
 * Build the add-liquidity XDR from the amounts the user reviewed. The router,
 * network and client are the swap screen's — one configuration, not a copy.
 */
export async function buildAddLiquidityXdr(params: {
  tokenA: string
  tokenB: string
  amountA: bigint
  amountB: bigint
  to: string
  slippageBps: number
}): Promise<BuildLiquidityResult> {
  const client = getSoroswapClient()
  if (!client) {
    return { ok: false, reason: 'Soroswap liquidity is not configured in this build (no API key).' }
  }
  const request: AddLiquidityRequest = {
    assetA: params.tokenA,
    assetB: params.tokenB,
    amountA: params.amountA,
    amountB: params.amountB,
    to: params.to,
    slippageBps: String(params.slippageBps),
  }
  try {
    const raw = await client.addLiquidity(request, getSoroswapNetwork())
    const built = normaliseLiquidityResponse(raw)
    if (!built) return { ok: false, reason: 'Soroswap returned no transaction for this deposit.' }
    return { ok: true, built }
  } catch (err) {
    console.warn('[soroswap-liquidity] addLiquidity failed:', err)
    return { ok: false, reason: errorReason(err) }
  }
}

/** Build the remove-liquidity XDR from the payout the user reviewed. */
export async function buildRemoveLiquidityXdr(params: {
  tokenA: string
  tokenB: string
  liquidity: bigint
  amountA: bigint
  amountB: bigint
  to: string
  slippageBps: number
}): Promise<BuildLiquidityResult> {
  const client = getSoroswapClient()
  if (!client) {
    return { ok: false, reason: 'Soroswap liquidity is not configured in this build (no API key).' }
  }
  const request: RemoveLiquidityRequest = {
    assetA: params.tokenA,
    assetB: params.tokenB,
    liquidity: params.liquidity,
    amountA: params.amountA,
    amountB: params.amountB,
    to: params.to,
    slippageBps: String(params.slippageBps),
  }
  try {
    const raw = await client.removeLiquidity(request, getSoroswapNetwork())
    const built = normaliseLiquidityResponse(raw)
    if (!built) return { ok: false, reason: 'Soroswap returned no transaction for this withdrawal.' }
    return { ok: true, built }
  } catch (err) {
    console.warn('[soroswap-liquidity] removeLiquidity failed:', err)
    return { ok: false, reason: errorReason(err) }
  }
}
