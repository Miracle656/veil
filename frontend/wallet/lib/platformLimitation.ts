/**
 * Platform limitation copy and detection.
 *
 * Background:
 * A Veil wallet contract currently stores a single WebAuthn origin at init/deploy,
 * which __check_auth compares byte-for-byte. A wallet created or first spent on
 * the web is permanently bound to this website, and one created or first spent on
 * mobile is permanently bound to the mobile app.
 *
 * Contract issue #1003 tracks multi-origin support.
 *
 * REMOVE when contract issue #1003 ships.
 */

import { rpc as SorobanRpc, scValToNative, xdr } from '@stellar/stellar-sdk'
import { getDeploymentState, type DeploymentState } from './walletDeployment'

export const PLATFORM_NAME = 'this website'
export const OTHER_PLATFORM_NAME = 'the Veil mobile app'

/**
 * Shown on the wallet creation screen before a passkey is registered.
 */
export const WALLET_CREATION_LIMITATION_MESSAGE =
  'This wallet will work on this website only. Passkeys created here cannot sign transactions in the mobile app.'

/**
 * Shown on the review/confirm screen before the wallet's first spend,
 * which is the moment the contract is deployed and the platform origin becomes permanent.
 */
export const FIRST_SPEND_LIMITATION_MESSAGE =
  'This first spend permanently links your wallet to this website. You will not be able to sign transactions for this wallet from the mobile app.'

/**
 * Shown when sign-in or signing fails because the wallet was created/deployed on the other platform.
 */
export const WRONG_PLATFORM_ERROR_MESSAGE =
  'This wallet was created in the mobile app and cannot be signed here. To move these funds, open the Veil mobile app.'

/**
 * Returns true if an origin string corresponds to a native mobile app.
 */
export function isNativeOrigin(origin: string): boolean {
  return origin.startsWith('android:') || origin.startsWith('ios:')
}

/**
 * Returns true if an origin string corresponds to a web application.
 */
export function isWebOrigin(origin: string): boolean {
  return origin.startsWith('http://') || origin.startsWith('https://')
}

/**
 * On the web platform, a wallet origin is from the wrong platform if it is a native mobile origin.
 */
export function isWrongPlatformOrigin(contractOrigin: string): boolean {
  return isNativeOrigin(contractOrigin) || !isWebOrigin(contractOrigin)
}

/**
 * Reads the WebAuthn origin stored in the wallet contract instance on chain, if deployed.
 * Returns null if the wallet is undeployed, unreachable, or holds no stored origin.
 */
export async function fetchContractOrigin(
  rpcUrl: string,
  contractAddress: string | null,
): Promise<string | null> {
  if (!contractAddress || !contractAddress.startsWith('C')) return null
  try {
    const server = new SorobanRpc.Server(rpcUrl)
    const res = await server.getContractData(
      contractAddress,
      xdr.ScVal.scvLedgerKeyContractInstance(),
      SorobanRpc.Durability.Persistent,
    )
    if (!res || !res.val) return null
    const valAny = res.val as any
    const contractData = typeof valAny.contractData === 'function' ? valAny.contractData() : valAny
    if (!contractData) return null
    const contractVal = typeof contractData.val === 'function' ? contractData.val() : contractData
    if (!contractVal) return null
    const instance = typeof contractVal.instance === 'function' ? contractVal.instance() : null
    if (!instance) return null
    const storage = typeof instance.storage === 'function' ? instance.storage() : null
    if (!storage) return null

    for (const entry of storage) {
      const nativeKey = scValToNative(entry.key())
      const isOriginKey =
        (Array.isArray(nativeKey) && nativeKey.length === 1 && nativeKey[0] === 'Origin') ||
        nativeKey === 'Origin'

      if (isOriginKey) {
        const nativeVal = scValToNative(entry.val())
        if (typeof nativeVal === 'string') return nativeVal
        if (nativeVal instanceof Uint8Array || (typeof Buffer !== 'undefined' && Buffer.isBuffer(nativeVal))) {
          return new TextDecoder().decode(nativeVal)
        }
      }
    }
    return null
  } catch {
    return null
  }
}

const FIRST_SPEND_STORAGE_PREFIX = 'veil_first_spend_completed_'

/**
 * Check whether a wallet has never spent before.
 *
 * Returns true if the contract is not deployed yet and has no local record of having spent.
 * Once deployed or marked completed, returns false so it does not nag on every subsequent spend.
 */
export async function isFirstSpend(
  address: string | null,
  knownState?: DeploymentState,
): Promise<boolean> {
  if (!address) return false
  if (typeof window !== 'undefined') {
    const recorded = localStorage.getItem(`${FIRST_SPEND_STORAGE_PREFIX}${address}`)
    if (recorded === 'true') return false
  }

  const state = knownState ?? (await getDeploymentState(address))
  if (state === 'deployed') {
    markFirstSpendCompleted(address)
    return false
  }

  // Undeployed means it has never executed a contract transaction.
  return state === 'undeployed'
}

/**
 * Records that the first spend has occurred so we never show the warning again on subsequent spends.
 */
export function markFirstSpendCompleted(address: string | null): void {
  if (!address || typeof window === 'undefined') return
  try {
    localStorage.setItem(`${FIRST_SPEND_STORAGE_PREFIX}${address}`, 'true')
  } catch {
    // Storage quota or private mode - safe to ignore
  }
}
