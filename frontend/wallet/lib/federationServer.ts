/**
 * The server side of SEP-2 — what answers `name*useveilapp.xyz`.
 *
 * `frontend/wallet/lib/federation.ts` is the *client*: it reads a domain's
 * `stellar.toml`, finds `FEDERATION_SERVER`, and queries it. This module is
 * the other end, for our own domain.
 *
 * It exists because `public/.well-known/stellar.toml` already publishes
 *
 *     FEDERATION_SERVER = "https://app.useveilapp.xyz/api/federation"
 *
 * and that URL returned Next's HTML 404. Any wallet resolving a Veil name got
 * markup where it expected JSON — so Veil was advertising a federation server
 * it did not run.
 *
 * ## Where the answer comes from
 *
 * `contracts/veil-names` is the source of truth, not a database. Its `resolve`
 * already returns `None` for an expired name, so expiry needs no handling
 * here: a lapsed name stops resolving because the contract stops answering.
 * That is the whole point of the 90-day recovery window — a stale contact
 * fails for a quarter rather than silently paying whoever bought the name
 * next.
 *
 * Until that contract is deployed there is no registry to read, so every
 * lookup is an honest 404 rather than a fabricated answer.
 *
 * ## ⚠ A Veil name resolves to a `C…` address, and SEP-2 did not plan for that
 *
 * SEP-2 documents `account_id` as a Stellar public key, and a Veil wallet is a
 * contract account. A classic `payment` operation cannot address a `C…`
 * address at all, so a wallet that resolves a Veil name and then builds a
 * classic payment will fail — and CAP-84 `W…` addresses do not help, because a
 * muxed contract address is also not a classic payment destination.
 *
 * This module returns the contract address because that is where the money
 * actually lives; inventing a `G…` address would be worse. But it means a Veil
 * name is payable from Veil and from anything that speaks Soroban, and not
 * from an exchange. That is a product decision to resolve before names are
 * marketed as an address you can give anyone — see `docs/IDENTIFIER_ADDRESSES.md`.
 */

import { namesContractIdFor } from './namesContractId'

import {
  Account,
  BASE_FEE,
  Contract,
  nativeToScVal,
  Networks,
  rpc as SorobanRpc,
  scValToNative,
  TransactionBuilder,
} from '@stellar/stellar-sdk'

/**
 * Network config is read here rather than from `./network`.
 *
 * `lib/network.ts` imports `@veil/sdk`, whose entry point exports a React
 * hook, so anything importing it becomes a client module. Pulling it into this
 * route handler failed the wallet build outright:
 *
 *     You're importing a module that depends on `useEffect` into a React
 *     Server Component module.
 *
 * The values below mirror `NETWORKS` in that file for the two fields this
 * module needs, with one deliberate difference noted on `rpcUrl`.
 */
interface ServerNetwork {
  name: 'mainnet' | 'testnet'
  networkPassphrase: string
  rpcUrl: string
}

function serverNetwork(): ServerNetwork {
  // Mainnet unless told otherwise, which is the opposite of the browser's
  // default and deliberately so. `getNetwork()` can fall back to testnet
  // because a person switched networks in the UI and that choice lives in
  // localStorage. A federation server has no localStorage and no person: it
  // answers whoever published `FEDERATION_SERVER` in their stellar.toml, and
  // that file names the production domain. Defaulting to testnet here made
  // every lookup 404 against a registry that does not exist there, including
  // names that had just been bought on mainnet.
  const name = process.env.NEXT_PUBLIC_NETWORK === 'testnet' ? 'testnet' : 'mainnet'

  if (name === 'mainnet') {
    return {
      name,
      networkPassphrase: Networks.PUBLIC,
      // `resolveMainnetRpcUrl()` in ./network.ts returns the same-origin proxy
      // `/api/rpc/mainnet`, and an empty string when there is no `window` —
      // which is always, here. The proxy's own upstream is the server-side
      // `MAINNET_RPC_URL`, so this reads that directly rather than asking the
      // server to proxy to itself.
      rpcUrl:
        process.env.MAINNET_RPC_URL?.trim()
        || process.env.NEXT_PUBLIC_MAINNET_RPC_URL?.trim()
        || '',
    }
  }

  return {
    name,
    networkPassphrase: Networks.TESTNET,
    rpcUrl:
      process.env.NEXT_PUBLIC_SOROBAN_RPC_URL?.trim()
      || process.env.NEXT_PUBLIC_RPC_URL?.trim()
      || 'https://soroban-testnet.stellar.org',
  }
}

/** The domain Veil names are issued under, and the only one we answer for. */
export const HOME_DOMAIN = 'useveilapp.xyz'

/**
 * A name, as the registry stores it.
 *
 * Mirrors `validate_shape` in `contracts/veil-names/src/lib.rs`: 3–20
 * characters of lowercase ASCII, digits and underscore, with no leading,
 * trailing or doubled underscore. Checked here only to avoid a pointless RPC
 * round trip for something the registry could never hold — the contract is
 * still the authority, because anyone can invoke it directly.
 */
const NAME_SHAPE = /^(?!_)(?!.*__)[a-z0-9_]{3,20}(?<!_)$/

/** What a SEP-2 `type=name` query decomposed into, when it is one of ours. */
export interface ParsedFederationName {
  /** The bare name, lowercased — what the contract is keyed by. */
  name: string
  /** The domain as supplied, lowercased. */
  domain: string
}

/**
 * Split a `name*domain` query.
 *
 * Returns null when the query is not a federated address at all, when the
 * domain is not ours, or when the name could not be a registered one. A null
 * is a 404, never a 500: being asked about somebody else's domain is a normal
 * thing to be asked, not an error.
 */
export function parseFederationName(q: string): ParsedFederationName | null {
  const trimmed = (q || '').trim()
  if (!trimmed) return null

  const parts = trimmed.split('*')
  if (parts.length !== 2) return null

  const name = parts[0].toLowerCase()
  const domain = parts[1].toLowerCase()
  if (!name || !domain) return null

  if (domain !== HOME_DOMAIN) return null
  if (!NAME_SHAPE.test(name)) return null

  return { name, domain }
}

/**
 * The deployed names registry, or null when there is not one on this network.
 *
 * The address itself lives in `./namesContractId.ts`, shared with the `/names`
 * page — the server resolves names and the browser buys them, and a contract
 * address written in both places is one that will eventually differ.
 */
export function getNamesContractId(): string | null {
  return namesContractIdFor(serverNetwork().name)
}

/** Resolves a bare name to the address holding it, or null. */
export type NameResolver = (name: string) => Promise<string | null>

/**
 * Read `resolve(name)` off the registry contract.
 *
 * A simulation, not a submission: `resolve` is a read and costs nothing, so
 * there is no source account to fund. The dummy account below is never
 * charged and never signs — `simulateTransaction` only needs a well-formed
 * envelope to execute against.
 *
 * Any failure resolves to null rather than throwing. A federation server that
 * 500s on an RPC hiccup teaches callers that the name does not resolve *and*
 * that Veil is unreliable; a 404 says only the first, which is the truthful
 * part. `federation.ts` on the client draws exactly this distinction, and
 * `reverseResolution.ts` already degrades to null on an outage.
 */
export async function resolveOnChain(name: string): Promise<string | null> {
  const contractId = getNamesContractId()
  if (!contractId) return null

  try {
    const network = serverNetwork()
    // No RPC configured means no way to read the registry. Returning null is
    // a 404 — "no such name" — which is the honest half of what is true.
    if (!network.rpcUrl) return null

    const server = new SorobanRpc.Server(network.rpcUrl)
    const contract = new Contract(contractId)

    // Any valid account works as a simulation source; this one is the
    // all-zero ed25519 key, which cannot sign and never needs to.
    const source = new Account('GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF', '0')

    const tx = new TransactionBuilder(source, {
      fee: BASE_FEE,
      networkPassphrase: network.networkPassphrase,
    })
      .addOperation(contract.call('resolve', nativeToScVal(name, { type: 'string' })))
      .setTimeout(30)
      .build()

    const sim = await server.simulateTransaction(tx)
    if (!SorobanRpc.Api.isSimulationSuccess(sim) || !sim.result) return null

    // `resolve` returns `Option<Address>`; a `None` natives to null/undefined.
    const value = scValToNative(sim.result.retval)
    return typeof value === 'string' && value.length > 0 ? value : null
  } catch {
    return null
  }
}

/** A SEP-2 `type=name` answer. */
export interface FederationNameRecord {
  stellar_address: string
  account_id: string
}

/**
 * Resolve a federated address to a record, or null.
 *
 * `resolver` is injectable so the route can be tested without an RPC server;
 * the default reads the chain.
 */
export async function lookupFederationName(
  q: string,
  resolver: NameResolver = resolveOnChain,
): Promise<FederationNameRecord | null> {
  const parsed = parseFederationName(q)
  if (!parsed) return null

  const accountId = await resolver(parsed.name)
  if (!accountId) return null

  return {
    stellar_address: `${parsed.name}*${parsed.domain}`,
    account_id: accountId,
  }
}
