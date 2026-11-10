/**
 * Where the Veil Masquerade collection lives, per network.
 *
 * Same shape as `./namesContractId.ts`, and for the same reason: the shop page
 * and anything that later reads the collection server-side must get the same
 * answer, and an address duplicated across two callers is an address that will
 * eventually differ between them.
 */

/**
 * Deployed 2026-11-10 from wasm e7980246fbc5f32d50d1763ae3dd1426b5adb97fbb43bd47ae072161a3ff2c7f.
 *
 * Baked in rather than left to configuration, following `namesContractId`: a
 * fresh clone should show the collection without secret config, and an
 * environment variable still wins for a deployment pointed elsewhere.
 */
export const MAINNET_MASQUERADE_CONTRACT_ID: string | null =
  'CA5TXFITGGMG6HG6FJIHWOTXSZ43EIR4F5UCTAAY5FJWB5FWBG5Z3WPN'

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
