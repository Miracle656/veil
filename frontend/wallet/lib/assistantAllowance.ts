/**
 * The assistant's allowance: a capped amount of USDC the assistant may spend
 * from the wallet without asking for the passkey each time.
 *
 * It is an on-chain allowance from the wallet (C…) to this browser's spending
 * account (G…), for USDC only, with an end date:
 *
 *  - Granting it takes the passkey, once.
 *  - After that the spending account can move USDC out of the wallet, and the
 *    wallet contract itself refuses anything over what is left or past the end
 *    date. The limit is not a setting in this app: the app cannot exceed it.
 *  - The money stays in the passkey-protected wallet until the moment a
 *    payment is made.
 *
 * What it cannot do, by the wallet contract's own rules (proven on a real
 * network, see docs/ALLOWANCE_SPEND.md): spend any other token, call anything
 * other than a token transfer, or be used by any other key.
 *
 * Taking it back: the wallet contract that is deployed cannot delete an
 * allowance. "Stop" replaces it with the smallest amount and an end date
 * already in the past, after which every payment through it is refused.
 */
import { Asset } from '@stellar/stellar-sdk'
import { encodeApproveArgs } from '@veil/sdk'

import { spendFromAllowance } from './allowanceSpend'
import { fetchAllowances, STOP_REPLACEMENT, trackPairs, type Allowance, type PairStore } from './allowances'
import { getNetwork, getUsdcIssuer } from './network'
import { buildSignAuthEntry, getFeePayerKeypair } from './passkeySigner'
import { invokeAsWallet } from './walletInvoke'

/** USDC has seven decimal places on Stellar. */
export const USDC_UNITS = 10_000_000n
/** The most one allowance may be for. A guard against a typo, not a product limit. */
export const MAX_ALLOWANCE_USDC = 500
export const ALLOWANCE_DAY_CHOICES = [1, 7, 30] as const
export const DAY_SECS = 86_400

/** The USDC token contract on the active network. */
export function usdcTokenId(): string {
  return new Asset('USDC', getUsdcIssuer()).contractId(getNetwork().networkPassphrase)
}

/** Whole USDC, as typed, to the token's smallest unit. Null when it is not a usable amount. */
export function usdcToUnits(input: string): bigint | null {
  const m = /^(\d{1,6})(?:\.(\d{1,7}))?$/.exec(input.trim())
  if (!m) return null
  const units = BigInt(m[1]) * USDC_UNITS + BigInt((m[2] ?? '').padEnd(7, '0'))
  return units > 0n ? units : null
}

/** The smallest unit back to a plain decimal string, without trailing zeros. */
export function unitsToUsdc(units: bigint): string {
  const whole = units / USDC_UNITS
  const frac = (units % USDC_UNITS).toString().padStart(7, '0').replace(/0+$/, '')
  return frac ? `${whole}.${frac}` : whole.toString()
}

/** Why an allowance of this size and length cannot be granted, or null. */
export function grantProblem(amountUsdc: string, days: number): string | null {
  const units = usdcToUnits(amountUsdc)
  if (units === null) return 'Enter an amount in USDC, like 5 or 2.50.'
  if (units > BigInt(MAX_ALLOWANCE_USDC) * USDC_UNITS) {
    return `Keep the allowance to ${MAX_ALLOWANCE_USDC} USDC or less.`
  }
  if (!Number.isInteger(days) || days < 1 || days > 90) return 'Choose how long it lasts, up to 90 days.'
  return null
}

export interface AssistantAllowance {
  /** What is left, in USDC's smallest unit. */
  remaining: bigint
  /** Unix seconds when it ends, or null if it never does. */
  expiry: bigint | null
  /** Whether a payment through it would be accepted right now. */
  usable: boolean
  status: Allowance['status']
}

/**
 * Read the allowance from the chain. Null when none was ever granted to this
 * browser's spending account. This is the wallet contract's own record, not a
 * figure the app keeps.
 */
export async function readAssistantAllowance(wallet: string): Promise<AssistantAllowance | null> {
  const spender = getFeePayerKeypair().publicKey()
  const [found] = await fetchAllowances(getNetwork().rpcUrl, wallet, [{ spender, token: usdcTokenId() }])
  if (!found) return null
  return {
    remaining: found.amount,
    expiry: found.expiry,
    status: found.status,
    usable: found.status === 'active' && found.amount > 0n,
  }
}

function approve(wallet: string, amount: bigint, expiry: bigint, label: string): Promise<string> {
  const network = getNetwork()
  const feePayer = getFeePayerKeypair()
  return invokeAsWallet({
    contractId: wallet,
    method: 'approve',
    args: encodeApproveArgs(feePayer.publicKey(), usdcTokenId(), amount, expiry),
    walletAddress: wallet,
    feePayerKeypair: feePayer,
    signAuthEntry: buildSignAuthEntry(),
    rpcUrl: network.rpcUrl,
    networkPassphrase: network.networkPassphrase,
    label,
  })
}

/**
 * Give the assistant an allowance. Asks for the passkey. Replaces any
 * allowance already there: the new amount and end date are the whole of it.
 */
export async function grantAssistantAllowance(
  wallet: string,
  amountUsdc: string,
  days: number,
  store: PairStore,
  nowSecs = Math.floor(Date.now() / 1000),
): Promise<string> {
  const problem = grantProblem(amountUsdc, days)
  if (problem) throw new Error(problem)
  const hash = await approve(wallet, usdcToUnits(amountUsdc)!, BigInt(nowSecs + days * DAY_SECS), 'assistant-allowance')
  // So it is listed under Settings › Spending permissions too.
  trackPairs(store, wallet, [{ spender: getFeePayerKeypair().publicKey(), token: usdcTokenId() }])
  return hash
}

/** Stop the allowance. Asks for the passkey. Every later payment through it is refused. */
export function stopAssistantAllowance(wallet: string): Promise<string> {
  return approve(wallet, STOP_REPLACEMENT.amount, STOP_REPLACEMENT.expiry ?? 0n, 'assistant-allowance-stop')
}

/**
 * Take `units` of USDC from the wallet into the spending account, under the
 * allowance. No passkey: the allowance is the approval. The wallet contract
 * refuses if it is more than what is left, or the allowance has ended.
 */
export function drawFromAllowance(wallet: string, units: bigint): Promise<string> {
  const network = getNetwork()
  const spender = getFeePayerKeypair()
  return spendFromAllowance(
    { wallet, token: usdcTokenId(), to: spender.publicKey(), amount: units },
    spender,
    { rpcUrl: network.rpcUrl, networkPassphrase: network.networkPassphrase },
  )
}
