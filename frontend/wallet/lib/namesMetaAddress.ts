/**
 * Resolving a Veil name to its stealth meta-address, and refusing when it has
 * none.
 *
 * `contracts/veil-names` holds an optional `MetaAddress` per name. This module
 * asks our own server (`/api/names/meta`, which reads the contract) and turns
 * the answer into something a screen can act on.
 *
 * ## Fail closed
 *
 * A name with no record is **not** a public-payment fallback hidden behind a
 * privacy toggle. It is a refusal: `not-published`, with a sentence that says
 * the payment would be public. The same is true when the answer cannot be
 * read — `unknown` is deliberately distinct from `not-published`, but neither
 * is allowed to produce a stealth address, and the UI must not claim privacy
 * for either.
 */

import { SUFFIX } from './names'
import {
  META_ADDRESS_PREFIX,
  parseMetaAddress,
  StealthAddressError,
  type StealthMetaAddress,
} from './stealthAddress'

/** The bare name when `input` is a Veil name, or null if it is another domain. */
export function parseVeilName(input: string): string | null {
  const trimmed = (input ?? '').trim()
  if (!trimmed.endsWith(SUFFIX)) return null
  const name = trimmed.slice(0, -SUFFIX.length)
  // The server validates the shape against the contract; an empty name is a
  // typo, not a lookup.
  return name.length > 0 ? name : null
}

/** What a lookup produced, in the terms the send screen needs. */
export type NameMetaLookup =
  | { status: 'idle' }
  | { status: 'checking' }
  /** A federated name on a domain this deployment does not answer for. */
  | { status: 'not-veil-name' }
  | {
      status: 'published'
      /** The bare name, as the registry holds it. */
      name: string
      /** `name*useveilapp.xyz`, echoed by the server. */
      stellarAddress: string
      meta: StealthMetaAddress
    }
  /** The name exists (or may exist) and has published nothing. */
  | { status: 'not-published'; name: string; message: string }
  /** The question could not be answered — not the same as "no record". */
  | { status: 'unknown'; name: string; message: string }

/** The refusal shown for a name that never opted in. */
export function noMetaAddressMessage(stellarAddress: string): string {
  return (
    `${stellarAddress} has not published a stealth meta-address, so Veil cannot derive a ` +
    'one-time address for it. Paying it now would be a public payment to its contract address.'
  )
}

/** The refusal shown when the record could not be read. */
export function metaAddressUnknownMessage(stellarAddress: string): string {
  return (
    `Veil could not check whether ${stellarAddress} publishes a stealth meta-address. ` +
    'A name that cannot be checked is not a private destination.'
  )
}

interface MetaQueryOptions {
  fetchImpl?: typeof fetch
  /** Override the API origin, for tests and for a non-browser caller. */
  baseUrl?: string
}

function apiUrl(input: string, baseUrl: string | undefined): string {
  const base = (baseUrl ?? '').replace(/\/+$/, '')
  return `${base}/api/names/meta?q=${encodeURIComponent(input.trim())}`
}

/**
 * Ask the registry, through our API, whether a name accepts stealth payments.
 *
 * Never throws: a refusal or an outage is a value, because every one of these
 * has to be shown to somebody about to send money.
 */
export async function lookupNameMetaAddress(
  input: string,
  options: MetaQueryOptions = {},
): Promise<NameMetaLookup> {
  const stellarAddress = input.trim()
  const name = parseVeilName(stellarAddress)
  if (!name) return { status: 'not-veil-name' }

  const doFetch = options.fetchImpl ?? fetch
  let response: Response
  try {
    response = await doFetch(apiUrl(stellarAddress, options.baseUrl))
  } catch {
    return { status: 'unknown', name, message: metaAddressUnknownMessage(stellarAddress) }
  }

  if (response.status === 404) {
    return {
      status: 'not-published',
      name,
      message: noMetaAddressMessage(stellarAddress),
    }
  }
  if (!response.ok) {
    return { status: 'unknown', name, message: metaAddressUnknownMessage(stellarAddress) }
  }

  let body: { stellar_address?: unknown; spend_key?: unknown; view_key?: unknown }
  try {
    body = await response.json()
  } catch {
    return { status: 'unknown', name, message: metaAddressUnknownMessage(stellarAddress) }
  }

  const spend = typeof body.spend_key === 'string' ? body.spend_key : ''
  const view = typeof body.view_key === 'string' ? body.view_key : ''

  try {
    const meta = parseMetaAddress(`${META_ADDRESS_PREFIX}${spend}${view}`)
    return {
      status: 'published',
      name,
      stellarAddress:
        typeof body.stellar_address === 'string' && body.stellar_address.length > 0
          ? body.stellar_address
          : stellarAddress,
      meta,
    }
  } catch (err) {
    // A record that does not parse is not a destination. Saying "no record"
    // would be untrue, and using it would derive an address nobody holds.
    const reason = err instanceof StealthAddressError ? err.message : 'the record is malformed'
    return {
      status: 'unknown',
      name,
      message: `${stellarAddress} publishes a stealth meta-address that Veil cannot use: ${reason}`,
    }
  }
}
