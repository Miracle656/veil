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
 * Ask the contract whether this wallet could register this name, by simulating
 * the real `register` call.
 *
 * Simulation runs in *recording* auth mode, which does not execute
 * `__check_auth` — so this answers without prompting for a passkey, while
 * still exercising every check the real call makes: the charset and length
 * rules, the reserved list, whether the name is held or inside somebody's
 * recovery window, and whether the buyer can actually pay, since the USDC
 * transfer happens inside `register`.
 *
 * That is the whole reason to ask this way rather than reading `state(name)`.
 * `state` cannot see the reserved list — the contract exposes no getter for it
 * — and cannot see the buyer's balance at all, so a name could read as
 * available and still fail the moment somebody approved it with a fingerprint.
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

    const code = /Error\(Contract, #(\d+)\)/.exec(sim.error)?.[1]
    switch (code) {
      case '3':
      case '4':
      case '5':
      case '6':
      case '8':
        return 'invalid'
      case '7':
        return 'reserved'
      case '9': {
        // Held — but possibly by this very wallet, moments after buying it.
        // Reporting "belongs to another Veil wallet" for a name the user just
        // paid for is worse than saying nothing, so ask who holds it.
        const holder = await simulateRead(
          rpc,
          contractId,
          'resolve',
          [nativeToScVal(name, { type: 'string' })],
          net.networkPassphrase,
        )
        return holder === walletAddress ? 'yours' : 'taken'
      }
      case '10':
        return 'in_recovery'
      default:
        // A failed SAC transfer is the overwhelmingly likely other outcome,
        // and it is worth naming rather than lumping into "unknown": the user
        // can do something about it.
        return /insufficient|balance/i.test(sim.error) ? 'insufficient_funds' : 'unknown'
    }
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
