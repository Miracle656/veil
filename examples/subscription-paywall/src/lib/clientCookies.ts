import { WALLET_COOKIE } from './constants'

const WALLET_COOKIE_MAX_AGE = 60 * 60 * 24 * 30 // 30 days

/** Persist the connected wallet address in a cookie so the server can gate routes. */
export function setWalletCookie(address: string): void {
  document.cookie = `${WALLET_COOKIE}=${address}; path=/; max-age=${WALLET_COOKIE_MAX_AGE}; samesite=lax`
}

/** Remove the wallet cookie (e.g. on disconnect). */
export function clearWalletCookie(): void {
  document.cookie = `${WALLET_COOKIE}=; path=/; max-age=0; samesite=lax`
}
