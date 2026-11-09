/**
 * Buying a Veil name.
 *
 * `register(buyer, name, years)` on the names registry does two things in one
 * transaction: it moves `price × years` of USDC from the buyer to the Veil
 * treasury, and it mints the name to the buyer. There is no pending state and
 * no refund path — either both happen or neither does.
 *
 * The buyer is the Veil wallet, a `C…` contract account, so `require_auth()`
 * runs `__check_auth` and the purchase needs a passkey signature. That whole
 * sequence lives in `./walletInvoke.ts`.
 *
 * ## A contract holds USDC without a trustline
 *
 * A classic `G…` account needs a trustline before it can hold USDC. A contract
 * does not: the Stellar Asset Contract keeps balances for contract addresses in
 * its own storage. So the only pre-flight check that matters here is *balance*,
 * and `usdcBalance()` reads it from the SAC rather than from Horizon — a
 * Horizon account lookup for a `C…` address returns nothing at all.
 */

import {
  Account,
  Contract,
  Keypair,
  TransactionBuilder,
  nativeToScVal,
  rpc as SorobanRpc,
  scValToNative,
} from '@stellar/stellar-sdk'
import type { WebAuthnSignature } from '@veil/sdk'

import { inclusionFee } from './fees'
import { namesContractIdFor } from './namesContractId'
import { invokeAsWallet, type AuthEntrySigner } from './walletInvoke'
import { getNetwork } from './network'

/** The registry on whichever network the browser is pointed at. */
function namesContractId(): string | null {
  return namesContractIdFor(getNetwork().name)
}

/** USDC carries seven decimal places, like every Stellar asset. */
const STROOPS = 10_000_000n

/** The USDC Stellar Asset Contract, per network. */
export function getUsdcSacId(): string | null {
  const net = getNetwork()
  const id =
    net.name === 'mainnet'
      ? process.env.NEXT_PUBLIC_USDC_SAC_MAINNET?.trim()
        // Mainnet USDC (issuer GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN),
        // derived with `stellar contract id asset` and confirmed against the
        // Veil treasury's own trustline.
        || 'CCW67TSZV3SSS2HXMBQ5JFGCKJNXKZM7UQUWUZPUTHXSTZLEO7SJMI75'
      : process.env.NEXT_PUBLIC_USDC_SAC_TESTNET?.trim()
        || 'CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA'
  return id && id.length > 0 ? id : null
}

/** A simulation-only source account. Never signs, never needs to exist. */
function probeAccount(): Account {
  return new Account(Keypair.random().publicKey(), '0')
}

/** Read a contract's return value by simulating a call. Null on any failure. */
async function simulateRead(
  rpc: SorobanRpc.Server,
  contractId: string,
  method: string,
  args: ReturnType<typeof nativeToScVal>[],
  networkPassphrase: string,
): Promise<unknown | null> {
  try {
    const tx = new TransactionBuilder(probeAccount(), {
      fee: inclusionFee(),
      networkPassphrase,
    })
      .addOperation(new Contract(contractId).call(method, ...args))
      .setTimeout(30)
      .build()

    const sim = await rpc.simulateTransaction(tx)
    if (SorobanRpc.Api.isSimulationError(sim)) return null
    const result = (sim as SorobanRpc.Api.SimulateTransactionSuccessResponse).result
    if (!result?.retval) return null
    return scValToNative(result.retval)
  } catch {
    return null
  }
}

/**
 * The wallet's USDC balance in stroops, or null when it cannot be read.
 *
 * Null is deliberately not zero: "we could not check" and "you have nothing"
 * lead to different UI, and showing *insufficient funds* because an RPC call
 * failed would send someone off to top up an account that is already funded.
 */
export async function usdcBalance(walletAddress: string): Promise<bigint | null> {
  const sacId = getUsdcSacId()
  if (!sacId) return null

  const net = getNetwork()
  const rpc = new SorobanRpc.Server(net.rpcUrl)
  const value = await simulateRead(
    rpc,
    sacId,
    'balance',
    [nativeToScVal(walletAddress, { type: 'address' })],
    net.networkPassphrase,
  )
  return typeof value === 'bigint' ? value : null
}

/**
 * What the registry itself says a registration costs, in USDC stroops.
 *
 * The client can compute this from the length bands, and `lib/names.ts` does
 * so the page can price a name as it is typed. This asks the contract instead,
 * because the contract is what will actually take the money — if the two ever
 * disagree, the number shown at the moment of payment should be the one that
 * is about to be charged.
 */
export async function quoteFromChain(name: string, years: number): Promise<bigint | null> {
  const contractId = namesContractId()
  if (!contractId) return null

  const net = getNetwork()
  const rpc = new SorobanRpc.Server(net.rpcUrl)
  const value = await simulateRead(
    rpc,
    contractId,
    'quote',
    [nativeToScVal(name, { type: 'string' }), nativeToScVal(years, { type: 'u32' })],
    net.networkPassphrase,
  )
  return typeof value === 'bigint' ? value : null
}

/** Stroops as a human USDC string, e.g. 50000000n -> "5". */
export function formatUsdc(stroops: bigint): string {
  const whole = stroops / STROOPS
  const frac = stroops % STROOPS
  if (frac === 0n) return whole.toString()
  return `${whole}.${frac.toString().padStart(7, '0').replace(/0+$/, '')}`
}

export type AffordCheck =
  | { ok: true; priceStroops: bigint; balanceStroops: bigint }
  | { ok: false; reason: 'no_registry' | 'unknown_price' | 'unknown_balance' | 'insufficient'; priceStroops?: bigint; balanceStroops?: bigint }

/**
 * Can this wallet pay for this name, for this term?
 *
 * Checked before the button is offered so the failure is a sentence in the UI
 * rather than a reverted transaction the user has already approved with their
 * fingerprint.
 */
export async function canAfford(
  walletAddress: string,
  name: string,
  years: number,
): Promise<AffordCheck> {
  if (!namesContractId()) return { ok: false, reason: 'no_registry' }

  const priceStroops = await quoteFromChain(name, years)
  if (priceStroops === null) return { ok: false, reason: 'unknown_price' }

  const balanceStroops = await usdcBalance(walletAddress)
  if (balanceStroops === null) return { ok: false, reason: 'unknown_balance', priceStroops }

  if (balanceStroops < priceStroops) {
    return { ok: false, reason: 'insufficient', priceStroops, balanceStroops }
  }
  return { ok: true, priceStroops, balanceStroops }
}

/** What the registry says about a name, read straight from the chain. */
export type ChainAvailability =
  | 'available'
  | 'yours'
  | 'taken'
  | 'reserved'
  | 'in_recovery'
  | 'insufficient_funds'
  | 'invalid'
  | 'unknown'

/**
 * Read a `register` failure for a name `state()` has already said is **Open**.
 *
 * Exported so the error-table collision stays pinned by a test. `register`
 * calls the USDC SAC, and the two contracts number their errors
 * independently: SAC `BalanceError` is 10 where veil-names `InRecovery` is 10,
 * and SAC `TrustlineMissingError` is 13 where veil-names `TermTooLong` is 13.
 * Trusting the code without knowing which contract raised it reported a free
 * name as lapsed.
 *
 * The caller has already established the name is Open, and veil-names raises
 * every one of its own register errors before reaching the transfer. So only
 * the shape, reserved and term codes can be its; anything else is the SAC
 * saying the buyer cannot pay.
 */
export function interpretOpenNameFailure(code: string | undefined): ChainAvailability {
  switch (code) {
    case '3':
    case '4':
    case '5':
    case '6':
    case '8':
      return 'invalid'
    case '7':
      return 'reserved'
    default:
      // Deliberately NOT 'insufficient_funds'. Everything left is some other
      // contract's error table, and guessing one reads as a confident,
      // checkable claim about the user's money that may simply be false.
      // The caller measures the balance instead.
      return 'unknown'
  }
}

/**
 * Ask the contract whether this wallet could register this name.
 *
 * Two calls, and the order matters.
 *
 * `state(name)` is asked **first** because it is unambiguous: Active, Recovery
 * or Open, decided by the registry alone with no payment involved.
 *
 * Only then is `register` simulated, for the things `state` cannot see — the
 * reserved list, which the contract exposes no getter for, and whether the
 * buyer can actually pay, since the USDC transfer happens inside `register`.
 * Simulation runs in recording auth mode, so it never prompts for a passkey.
 *
 * ## Why `register` alone is not enough
 *
 * Its failure carries `Error(Contract, #N)` — but **N belongs to whichever
 * contract raised it**, and `register` calls the USDC SAC. The two error tables
 * collide: SAC `BalanceError` is 10 and veil-names `InRecovery` is 10; SAC
 * `TrustlineMissingError` is 13 and veil-names `TermTooLong` is 13. Reading the
 * first code in the diagnostics reported a free name as lapsed, and told
 * somebody only its previous holder could take it back.
 *
 * `state` settles it. veil-names raises 3–10 before it ever reaches the
 * transfer, so once `state` says Open, codes 9 and 10 cannot have come from
 * veil-names — anything outside the shape, reserved and term codes is the SAC
 * saying the buyer cannot pay.
 */
export async function checkNameAvailability(
  walletAddress: string,
  name: string,
  years: number,
): Promise<ChainAvailability> {
  const contractId = namesContractId()
  if (!contractId) return 'unknown'

  const net = getNetwork()
  const rpc = new SorobanRpc.Server(net.rpcUrl)

  // ── 1. Who holds it, if anyone ──────────────────────────────────────────
  const state = await simulateRead(
    rpc,
    contractId,
    'state',
    [nativeToScVal(name, { type: 'string' })],
    net.networkPassphrase,
  )

  // NameState: 0 Active, 1 Recovery, 2 Open.
  if (state === 0) {
    const holder = await simulateRead(
      rpc,
      contractId,
      'resolve',
      [nativeToScVal(name, { type: 'string' })],
      net.networkPassphrase,
    )
    return holder === walletAddress ? 'yours' : 'taken'
  }
  if (state === 1) return 'in_recovery'
  if (state !== 2) return 'unknown'

  // ── 2. Open. Reserved? Affordable? ──────────────────────────────────────
  try {
    const tx = new TransactionBuilder(probeAccount(), {
      fee: inclusionFee(),
      networkPassphrase: net.networkPassphrase,
    })
      .addOperation(
        new Contract(contractId).call(
          'register',
          nativeToScVal(walletAddress, { type: 'address' }),
          nativeToScVal(name, { type: 'string' }),
          nativeToScVal(years, { type: 'u32' }),
        ),
      )
      .setTimeout(30)
      .build()

    const sim = await rpc.simulateTransaction(tx)
    if (!SorobanRpc.Api.isSimulationError(sim)) return 'available'

    const verdict = interpretOpenNameFailure(
      /Error\(Contract, #(\d+)\)/.exec(sim.error)?.[1],
    )
    if (verdict !== 'unknown') return verdict

    // The simulation failed for a reason this module cannot name. Rather than
    // assert the likeliest one, read the balance and the price and compare
    // them — a measurement the page can state without hedging.
    const [balance, price] = await Promise.all([
      usdcBalance(walletAddress),
      quoteFromChain(name, years),
    ])
    if (balance !== null && price !== null && balance < price) return 'insufficient_funds'

    // Funded, and still refused. Surfacing the raw failure is the only honest
    // move: the user is told it could not be checked, and the reason is in the
    // console for whoever looks.
    // eslint-disable-next-line no-console
    console.warn('[names] register simulation failed for a funded wallet:', sim.error)
    return 'unknown'
  } catch {
    return 'unknown'
  }
}

export interface RegisterNameParams {
  /** The `C…` Veil wallet buying the name. */
  walletAddress: string
  /** Bare name, without the `*useveilapp.xyz` suffix. */
  name: string
  /** Term in years, 1 to 5. */
  years: number
  /** Pays the network fee; not the USDC, which comes from the wallet. */
  feePayerKeypair: Keypair
  signAuthEntry: AuthEntrySigner
}

/**
 * Buy a name. Resolves with the transaction hash.
 *
 * Throws with the contract's own meaning where there is one — `#7` is
 * reserved, `#9` is already taken, `#10` is inside another holder's recovery
 * window — because "transaction failed" tells someone nothing about whether
 * trying again could ever work.
 */
export async function registerName(params: RegisterNameParams): Promise<string> {
  const contractId = namesContractId()
  if (!contractId) {
    throw new Error('The Veil Names registry is not configured on this deployment.')
  }

  const net = getNetwork()
  return invokeAsWallet({
    contractId,
    method: 'register',
    args: [
      nativeToScVal(params.walletAddress, { type: 'address' }),
      nativeToScVal(params.name, { type: 'string' }),
      nativeToScVal(params.years, { type: 'u32' }),
    ],
    walletAddress: params.walletAddress,
    feePayerKeypair: params.feePayerKeypair,
    signAuthEntry: params.signAuthEntry,
    rpcUrl: net.rpcUrl,
    networkPassphrase: net.networkPassphrase,
    label: 'names',
  })
}

/** Contract error codes, mapped to what a buyer can do about them. */
export const NAME_ERROR_MESSAGES: Record<number, string> = {
  3: 'That name is too short — names are at least 3 characters.',
  4: 'That name is too long — names are at most 20 characters.',
  5: 'Names can only use lowercase letters, digits and underscore.',
  6: 'An underscore cannot start or end a name, and cannot be doubled.',
  7: 'That name is reserved and cannot be registered.',
  8: 'A term must be between 1 and 5 years.',
  9: 'Somebody already holds that name.',
  10: 'That name has lapsed but is still in its 90-day recovery window, so only its previous holder can take it.',
  13: 'That renewal would push the term past the 5-year maximum.',
}

/** Pull `Error(Contract, #N)` out of a thrown Soroban error, if present. */
export function nameErrorMessage(err: unknown): string | null {
  const text = err instanceof Error ? err.message : String(err ?? '')
  const match = /Error\(Contract, #(\d+)\)/.exec(text)
  if (!match) return null
  return NAME_ERROR_MESSAGES[Number(match[1])] ?? null
}
