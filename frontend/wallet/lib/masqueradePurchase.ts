/**
 * Buying a Veil Masquerade figure.
 *
 * `buy(buyer, token_id)` moves 5 USDC from the buyer to the Veil treasury and
 * mints that figure, in one transaction. No pending state, no refund path.
 *
 * The mechanics are the same as a name purchase and reuse the same plumbing
 * (`./walletInvoke.ts`, and the USDC helpers in `./namesPurchase.ts`): a `C…`
 * wallet authorises through `__check_auth` and a passkey, a platform-locked
 * wallet falls back to its `G…` fee-payer, and a contract holds USDC without a
 * trustline so the only pre-flight that matters is balance.
 *
 * ## Two things have to be true before the money moves
 *
 * The figure must be unsold, and the buyer must already hold a Veil name. Both
 * are read from the chain before offering a purchase rather than inferred from
 * the error afterwards, because the error cannot be trusted to mean what it
 * says — see `masqueradeErrorMessage`.
 */

import { Keypair, nativeToScVal, rpc as SorobanRpc } from '@stellar/stellar-sdk'

import { masqueradeContractIdFor } from './masqueradeContractId'
import { namesContractIdFor } from './namesContractId'
import { getNetwork } from './network'
import { COLLECTION_SIZE } from './masqueradeFigures'
import { usdcBalance } from './namesPurchase'
import { simulateRead } from './sorobanRead'
import { invokeAsFeePayer, invokeAsWallet, type AuthEntrySigner } from './walletInvoke'

/** What one figure costs, in USDC stroops. Mirrors `PRICE * UNIT`. */
export const FIGURE_PRICE_STROOPS = 50_000_000n

/** The collection on whichever network the browser is pointed at. */
export function masqueradeContractId(): string | null {
  return masqueradeContractIdFor(getNetwork().name)
}

/**
 * Which figures have already been sold.
 *
 * One call for all twenty, which is why the contract has `sold()` at all.
 * Twenty separate `is_sold` reads would be twenty answers from twenty
 * different moments, and the gap is long enough to offer something that has
 * just gone.
 *
 * Null means the question could not be answered — not that nothing is sold.
 * A shop that silently treats "could not read" as "everything is available"
 * invites a purchase that is going to fail.
 */
export async function soldFigures(): Promise<number[] | null> {
  const contractId = masqueradeContractId()
  if (!contractId) return null

  const net = getNetwork()
  const rpc = new SorobanRpc.Server(net.rpcUrl)
  const value = await simulateRead(rpc, contractId, 'sold', [], net.networkPassphrase)
  if (!Array.isArray(value)) return null
  return value.map(Number).filter((n) => Number.isInteger(n) && n >= 1 && n <= COLLECTION_SIZE)
}

/**
 * Does this address hold a Veil name?
 *
 * Asked of the names registry directly, the same way the collection contract
 * asks it. Null is "could not tell", which the page must not render as "you
 * need a name" — that sends someone to buy a name they may already have.
 */
export async function holdsAName(address: string): Promise<boolean | null> {
  const registry = namesContractIdFor(getNetwork().name)
  if (!registry) return null

  const net = getNetwork()
  const rpc = new SorobanRpc.Server(net.rpcUrl)
  const value = await simulateRead(
    rpc,
    registry,
    'balance',
    [nativeToScVal(address, { type: 'address' })],
    net.networkPassphrase,
  )
  if (typeof value === 'bigint') return value > 0n
  if (typeof value === 'number') return value > 0
  return null
}

/** How many figures this address holds. Null when it cannot be read. */
export async function figuresHeld(address: string): Promise<number | null> {
  const contractId = masqueradeContractId()
  if (!contractId) return null

  const net = getNetwork()
  const rpc = new SorobanRpc.Server(net.rpcUrl)
  const value = await simulateRead(
    rpc,
    contractId,
    'balance',
    [nativeToScVal(address, { type: 'address' })],
    net.networkPassphrase,
  )
  if (typeof value === 'bigint') return Number(value)
  if (typeof value === 'number') return value
  return null
}

/** What the contract itself says a figure costs, in stroops. */
export async function priceFromChain(): Promise<bigint | null> {
  const contractId = masqueradeContractId()
  if (!contractId) return null

  const net = getNetwork()
  const rpc = new SorobanRpc.Server(net.rpcUrl)
  const value = await simulateRead(rpc, contractId, 'price', [], net.networkPassphrase)
  return typeof value === 'bigint' ? value : null
}

/** Everything the shop needs about one address, read together. */
export interface BuyerState {
  /** Null when the registry could not be reached. */
  hasName: boolean | null
  /** USDC in the `C…` wallet, in stroops. Null when unreadable. */
  walletStroops: bigint | null
  /** USDC on the `G…` fee-payer, in stroops. */
  feePayerStroops: bigint
  /** Figures already held by the wallet. */
  held: number | null
  priceStroops: bigint
  /** Shortfall on the wallet contract; 0n when it can already pay. */
  topUpStroops: bigint
  /** True when wallet and fee-payer together still fall short. */
  short: boolean
}

/**
 * Read both balances, the name gate and the price in one pass.
 *
 * The name is checked against the **wallet contract**, because that is the
 * address `buy` is called for. A fee-payer purchase checks its own address —
 * see `buyFigureAsFeePayer`, which is a different buyer as far as the gate is
 * concerned.
 */
export async function readBuyerState(
  walletAddress: string,
  feePayerAddress: string,
): Promise<BuyerState> {
  const [hasName, wallet, feePayer, held, price] = await Promise.all([
    holdsAName(walletAddress),
    usdcBalance(walletAddress),
    usdcBalance(feePayerAddress),
    figuresHeld(walletAddress),
    priceFromChain(),
  ])

  const priceStroops = price ?? FIGURE_PRICE_STROOPS
  const feePayerStroops = feePayer ?? 0n
  const topUpStroops =
    wallet === null || wallet >= priceStroops ? 0n : priceStroops - wallet

  return {
    hasName,
    walletStroops: wallet,
    feePayerStroops,
    held,
    priceStroops,
    topUpStroops,
    // Unreadable is not short: saying "insufficient funds" to a funded wallet
    // because an RPC call failed sends someone to top up an account that is
    // already full. That exact bug shipped once on the names page.
    short: wallet !== null && topUpStroops > feePayerStroops,
  }
}

export interface BuyFigureParams {
  /** The `C…` Veil wallet buying the figure. */
  walletAddress: string
  /** Which figure, 1..20. */
  tokenId: number
  /** Pays the network fee; not the USDC, which comes from the wallet. */
  feePayerKeypair: Keypair
  signAuthEntry: AuthEntrySigner
}

/** Buy a figure with the wallet contract. Resolves with the transaction hash. */
export async function buyFigure(params: BuyFigureParams): Promise<string> {
  const contractId = masqueradeContractId()
  if (!contractId) {
    throw new Error('The Masquerade collection is not deployed on this network yet.')
  }

  const net = getNetwork()
  return invokeAsWallet({
    contractId,
    method: 'buy',
    args: [
      nativeToScVal(params.walletAddress, { type: 'address' }),
      nativeToScVal(params.tokenId, { type: 'u32' }),
    ],
    walletAddress: params.walletAddress,
    feePayerKeypair: params.feePayerKeypair,
    signAuthEntry: params.signAuthEntry,
    rpcUrl: net.rpcUrl,
    networkPassphrase: net.networkPassphrase,
    label: 'masquerade',
  })
}

/**
 * Buy a figure with the fee-payer `G…` account instead of the wallet contract.
 *
 * For a wallet that can never be signed from this platform — see
 * `registerNameAsFeePayer` for why that state exists and why it cannot be
 * recovered from in the browser.
 *
 * The gate moves with the buyer: the figure goes to the `G…`, so it is the
 * `G…` that must hold a name. For a wallet that bought its name this way too,
 * that is already the case.
 */
export async function buyFigureAsFeePayer(params: {
  feePayerKeypair: Keypair
  tokenId: number
}): Promise<string> {
  const contractId = masqueradeContractId()
  if (!contractId) {
    throw new Error('The Masquerade collection is not deployed on this network yet.')
  }

  const net = getNetwork()
  return invokeAsFeePayer({
    contractId,
    method: 'buy',
    args: [
      nativeToScVal(params.feePayerKeypair.publicKey(), { type: 'address' }),
      nativeToScVal(params.tokenId, { type: 'u32' }),
    ],
    feePayerKeypair: params.feePayerKeypair,
    rpcUrl: net.rpcUrl,
    networkPassphrase: net.networkPassphrase,
    label: 'masquerade',
  })
}

/**
 * The collection's own error codes.
 *
 * Deliberately **not** exported as a lookup the UI applies blindly. A failing
 * `buy` runs code in three contracts — this one, the USDC SAC, and the wallet's
 * `__check_auth` — and they all number their errors from 1. The SAC's
 * `BalanceError` is 10 and the wallet's `OriginMismatch` is 9; on the names
 * page an unguarded mapping of that kind told buyers a free name was taken.
 *
 * So these are only consulted when the frame says the error came from the
 * collection, and the fallback is honest about not knowing.
 */
const MASQUERADE_ERRORS: Record<number, string> = {
  1: 'The collection is already set up.',
  2: 'The collection has not been set up yet.',
  3: 'There is no such figure — the collection is numbered 1 to 20.',
  4: 'Somebody already bought that figure.',
  5: 'You need a Veil name before you can buy a figure.',
}

/**
 * Turn a thrown Soroban error into something a buyer can act on.
 *
 * Returns null when the code cannot be attributed to this collection, which
 * leaves the caller showing the raw failure rather than a confident wrong
 * explanation.
 */
export function masqueradeErrorMessage(err: unknown, collectionId?: string | null): string | null {
  const text = err instanceof Error ? err.message : String(err ?? '')
  const match = /Error\(Contract, #(\d+)\)/.exec(text)
  if (!match) return null

  const code = Number(match[1])
  const id = collectionId ?? masqueradeContractId()

  // If the message names a contract and it is not this one, the code is not
  // ours to interpret.
  const contracts = text.match(/C[A-Z2-7]{55}/g)
  if (contracts && id && !contracts.includes(id)) return null

  return MASQUERADE_ERRORS[code] ?? null
}

