/**
 * Where the Veil Names registry lives, per network.
 *
 * One module because two very different callers need the same answer: the
 * federation endpoint resolves names on the server, and the `/names` page buys
 * them in the browser. A contract address duplicated across those two is a
 * contract address that will eventually differ between them.
 *
 * The mainnet default is baked in, following `factoryContractId` in
 * `./network.ts`: a fresh clone should resolve and sell names without secret
 * config, and an environment variable still wins for a deployment pointed
 * somewhere else.
 */

/** Deployed 2026-11-08 from commit 09fc5e49, with all 40 reserved names set. */
export const MAINNET_NAMES_CONTRACT_ID = 'CA7BWBV2L67YVIZWJKLYT3RRCTFCZPN6L5SXYQ4YELWP56E34JFNOEP4'

/**
 * Testnet has no default. The testnet instance is a rehearsal deployment that
 * gets replaced whenever the contract changes, and a stale baked-in address
 * would have the page quoting prices from a contract nobody is maintaining.
 */
export const TESTNET_NAMES_CONTRACT_ID: string | null = null

/**
 * Resolve the registry address for a network name.
 *
 * Returns null when there is none, which callers must treat as "cannot tell"
 * rather than "no such name" — `available` is the one answer that costs
 * somebody money when it is wrong.
 */
export function namesContractIdFor(network: 'mainnet' | 'testnet'): string | null {
  const explicit =
    network === 'mainnet'
      ? process.env.NEXT_PUBLIC_NAMES_CONTRACT_ID_MAINNET?.trim()
      : process.env.NEXT_PUBLIC_NAMES_CONTRACT_ID_TESTNET?.trim()

  const shared = process.env.NEXT_PUBLIC_NAMES_CONTRACT_ID?.trim()
  const fallback = network === 'mainnet' ? MAINNET_NAMES_CONTRACT_ID : TESTNET_NAMES_CONTRACT_ID

  const id = explicit || shared || fallback
  return id && id.length > 0 ? id : null
}
