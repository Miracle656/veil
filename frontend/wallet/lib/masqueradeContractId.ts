/**
 * Where the Veil Masquerade collection lives, per network.
 *
 * Same shape as `./namesContractId.ts`, and for the same reason: the shop page
 * and anything that later reads the collection server-side must get the same
 * answer, and an address duplicated across two callers is an address that will
 * eventually differ between them.
 */

/**
 * Not deployed yet.
 *
 * Null rather than a guessed or placeholder address. Everything downstream
 * treats null as "the collection is not available on this network" and says
 * so, which is recoverable; a wrong address would have the shop reading sold
 * state from a contract that is not this collection, and that is not.
 */
export const MAINNET_MASQUERADE_CONTRACT_ID: string | null = null

/** Testnet has no default, as with names: a rehearsal deployment goes stale. */
export const TESTNET_MASQUERADE_CONTRACT_ID: string | null = null

/** Resolve the collection address for a network name, or null when there is none. */
export function masqueradeContractIdFor(network: 'mainnet' | 'testnet'): string | null {
  const explicit =
    network === 'mainnet'
      ? process.env.NEXT_PUBLIC_MASQUERADE_CONTRACT_ID_MAINNET?.trim()
      : process.env.NEXT_PUBLIC_MASQUERADE_CONTRACT_ID_TESTNET?.trim()

  const shared = process.env.NEXT_PUBLIC_MASQUERADE_CONTRACT_ID?.trim()
  const fallback =
    network === 'mainnet' ? MAINNET_MASQUERADE_CONTRACT_ID : TESTNET_MASQUERADE_CONTRACT_ID

  const id = explicit || shared || fallback
  return id && id.length > 0 ? id : null
}
