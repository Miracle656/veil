/**
 * SEP-45 — Web Authentication for Contract Accounts.
 * https://github.com/stellar/stellar-protocol/blob/master/ecosystem/sep-0045.md
 *
 * SEP-10 only accepts `G…`/`M…` addresses, so a Veil wallet (a `C…` contract
 * account) cannot authenticate to an anchor under it directly — deposit and
 * withdraw flows have to borrow the fee-payer's `G…` identity instead of the
 * account that actually holds the funds. SEP-45 is the contract-account
 * equivalent of the SEP-10 handshake, and this module implements the client
 * side of it (see `docs/SEP45_SPIKE.md` for the investigation this builds on).
 *
 * Flow:
 *  1. {@link fetchSep45Challenge} — GET the anchor's endpoint; it returns two
 *     `SorobanAuthorizationEntry` values: an unsigned one for the wallet
 *     (entry 0 in practice, but this module locates it by its unsigned
 *     signature rather than assuming a position) and one already signed by
 *     the anchor.
 *  2. {@link signSep45Challenge} — validate that the entry actually is an
 *     unsigned `web_auth_verify` invocation on the anchor's declared
 *     contract, for this wallet and this home domain, on this wallet's
 *     network — `__check_auth` does not know or care that the invocation is
 *     `web_auth_verify` rather than a transfer, so this module has to check
 *     before signing with the existing passkey signer.
 *  3. {@link submitSep45Challenge} — POST both entries back; the anchor
 *     simulates the invocation and returns `{ token: "<JWT>" }`.
 *
 * The returned JWT is a normal SEP-10-shaped bearer token — it is accepted
 * anywhere `initiateDeposit` / `initiateWithdraw` / `getTransactionStatus`
 * (see `./sep24.ts`) take a `jwt` parameter, in place of the fee-payer's
 * SEP-10 token.
 */

import {
  xdr,
  hash as stellarHash,
  nativeToScVal,
  scValToNative,
  Address,
  StrKey,
} from '@stellar/stellar-sdk'
// @stellar/js-xdr is CommonJS with `__esModule: true` but no `default` export,
// so a default import resolves to `undefined` under esModuleInterop — a
// namespace import is what actually works (see docs/SEP45_SPIKE.md gotchas
// and stellar-js-xdr.d.ts for the full story).
import * as jsXdr from '@stellar/js-xdr'
import type { WebAuthnSignature } from '@veil/sdk'
import { getNetwork } from './network'

/** XDR codec for the challenge payload: a variable-length array of entries. */
const AuthEntryArray = new jsXdr.VarArray(xdr.SorobanAuthorizationEntry)

function decodeAuthEntries(base64: string): xdr.SorobanAuthorizationEntry[] {
  const reader = new jsXdr.XdrReader(Buffer.from(base64, 'base64'))
  return AuthEntryArray.read(reader) as xdr.SorobanAuthorizationEntry[]
}

function encodeAuthEntries(entries: xdr.SorobanAuthorizationEntry[]): string {
  const writer = new jsXdr.XdrWriter()
  AuthEntryArray.write(entries, writer)
  return writer.finalize().toString('base64')
}

// ── Errors ───────────────────────────────────────────────────────────────────

export type Sep45ErrorCode =
  | 'INVALID_RESPONSE'
  | 'INVALID_CHALLENGE'
  | 'WRONG_NETWORK'
  | 'CHALLENGE_EXPIRED'
  | 'SIGNATURE_REJECTED'
  | 'ANCHOR_ERROR'
  | 'NETWORK_ERROR'

/** Typed error for every SEP-45 failure mode, so callers can branch on `code`. */
export class Sep45Error extends Error {
  readonly code: Sep45ErrorCode
  constructor(message: string, code: Sep45ErrorCode) {
    super(message)
    this.name = 'Sep45Error'
    this.code = code
  }
}

// ── Challenge fetch + parse ──────────────────────────────────────────────────

export type Sep45Challenge = {
  /** Every entry the anchor returned, in the order it returned them. */
  entries: xdr.SorobanAuthorizationEntry[]
  networkPassphrase: string
}

/** Raw shape of the anchor's GET response, tolerant of both field-name conventions. */
type RawSep45Challenge = {
  authorization_entries?: unknown
  authorizationEntries?: unknown
  network_passphrase?: unknown
  networkPassphrase?: unknown
  error?: unknown
}

/**
 * Parse an anchor's SEP-45 challenge response body.
 *
 * The SDF test anchor returns `authorizationEntries` (camelCase); the spec
 * text says `authorization_entries` (snake_case). A client that reads only
 * one gets `undefined` on the other and silently proceeds with garbage, so
 * both are accepted here — exported separately from {@link fetchSep45Challenge}
 * so this parsing can be unit tested without a network call.
 */
export function parseSep45ChallengeResponse(body: unknown): Sep45Challenge {
  if (!body || typeof body !== 'object') {
    throw new Sep45Error('SEP-45 challenge response was not a JSON object', 'INVALID_RESPONSE')
  }
  const raw = body as RawSep45Challenge
  if (typeof raw.error === 'string') {
    throw new Sep45Error(`Anchor rejected the SEP-45 challenge request: ${raw.error}`, 'ANCHOR_ERROR')
  }

  const entriesXdr = raw.authorization_entries ?? raw.authorizationEntries
  if (typeof entriesXdr !== 'string' || entriesXdr.length === 0) {
    throw new Sep45Error(
      'SEP-45 challenge response is missing authorization_entries / authorizationEntries',
      'INVALID_RESPONSE',
    )
  }

  const networkPassphrase = raw.network_passphrase ?? raw.networkPassphrase
  if (typeof networkPassphrase !== 'string' || networkPassphrase.length === 0) {
    throw new Sep45Error(
      'SEP-45 challenge response is missing network_passphrase / networkPassphrase',
      'INVALID_RESPONSE',
    )
  }

  let entries: xdr.SorobanAuthorizationEntry[]
  try {
    entries = decodeAuthEntries(entriesXdr)
  } catch (err) {
    throw new Sep45Error(
      `Could not decode SEP-45 authorization entries: ${err instanceof Error ? err.message : String(err)}`,
      'INVALID_RESPONSE',
    )
  }

  if (entries.length < 2) {
    throw new Sep45Error(
      `Expected at least 2 SorobanAuthorizationEntry values (wallet + anchor), got ${entries.length}`,
      'INVALID_RESPONSE',
    )
  }

  return { entries, networkPassphrase }
}

/**
 * GET the anchor's SEP-45 challenge for `account`.
 *
 * @param webAuthForContractsEndpoint `WEB_AUTH_FOR_CONTRACTS_ENDPOINT` from the anchor's stellar.toml.
 * @param account   The wallet's `C…` contract address.
 * @param homeDomain The anchor's home domain (matches the `home_domain` challenge arg).
 */
export async function fetchSep45Challenge(
  webAuthForContractsEndpoint: string,
  account: string,
  homeDomain: string,
): Promise<Sep45Challenge> {
  const url = new URL(webAuthForContractsEndpoint)
  url.searchParams.set('account', account)
  url.searchParams.set('home_domain', homeDomain)

  let res: Response
  try {
    res = await fetch(url.toString(), { signal: AbortSignal.timeout(10_000) })
  } catch (err) {
    throw new Sep45Error(
      `Could not reach the anchor's SEP-45 endpoint: ${err instanceof Error ? err.message : String(err)}`,
      'NETWORK_ERROR',
    )
  }

  let body: unknown
  try {
    body = await res.json()
  } catch {
    throw new Sep45Error(`Anchor returned a non-JSON response (HTTP ${res.status})`, 'INVALID_RESPONSE')
  }

  if (!res.ok) {
    const message = typeof (body as { error?: unknown })?.error === 'string'
      ? (body as { error: string }).error
      : `HTTP ${res.status}`
    throw new Sep45Error(`Anchor rejected the SEP-45 challenge request: ${message}`, 'ANCHOR_ERROR')
  }

  return parseSep45ChallengeResponse(body)
}

// ── Signing ──────────────────────────────────────────────────────────────────

/**
 * How long a signature stays valid for, in ledgers. SEP-45 has no home for
 * this value the way SEP-10 has `maxTime` on its transaction — sigExpLedger
 * is a raw ledger count set by the signer.
 *
 * 5s/ledger on Stellar today, so 60 ledgers is ~5 minutes: comfortably longer
 * than the round trip of "receive the challenge, run the passkey ceremony,
 * POST it back" (a few seconds at most, dominated by the user's own tap),
 * while keeping the *signed* entry's replay window short if it were ever
 * intercepted before submission — this signature is single-purpose (it only
 * authorizes `web_auth_verify` with this exact nonce) but there is no reason
 * to make it live longer than the ceremony needs.
 */
export const SEP45_SIGNATURE_EXPIRATION_LEDGERS = 60

/** Whether an entry's address-credentials signature is still the SEP-45 "please sign me" placeholder. */
function isUnsignedAddressEntry(entry: xdr.SorobanAuthorizationEntry): boolean {
  const cred = entry.credentials()
  if (cred.switch().value !== xdr.SorobanCredentialsType.sorobanCredentialsAddress().value) return false
  return cred.address().signature().switch().name === 'scvVoid'
}

/**
 * Verify that the invocation a SEP-45 entry asks the wallet to sign is
 * actually a `web_auth_verify` call on the anchor's declared web-auth
 * contract, for this wallet and this home domain — not an arbitrary contract
 * invocation (e.g. a token `transfer`) dressed up as a login challenge.
 *
 * `__check_auth` is invocation-blind: it verifies the WebAuthn signature over
 * the preimage hash and nothing about what is being authorized. That is
 * exactly why no new cryptography is needed for SEP-45 — and exactly why this
 * check has to happen here, before the passkey ceremony runs, rather than
 * relying on the contract to reject anything.
 */
function validateWebAuthInvocation(
  invocation: xdr.SorobanAuthorizedInvocation,
  webAuthContractId: string,
  walletAddress: string,
  homeDomain: string,
): void {
  if (invocation.subInvocations().length !== 0) {
    throw new Sep45Error(
      'SEP-45 challenge invocation has sub-invocations; web_auth_verify should never need any',
      'INVALID_CHALLENGE',
    )
  }

  const fn = invocation.function()
  if (fn.switch().name !== 'sorobanAuthorizedFunctionTypeContractFn') {
    throw new Sep45Error('SEP-45 challenge invocation is not a contract function call', 'INVALID_CHALLENGE')
  }
  const call = fn.contractFn()

  const contractAddress = Address.fromScAddress(call.contractAddress()).toString()
  if (contractAddress !== webAuthContractId) {
    throw new Sep45Error(
      `SEP-45 challenge invokes ${contractAddress}, not the anchor's declared web-auth contract (${webAuthContractId})`,
      'INVALID_CHALLENGE',
    )
  }

  const functionName = call.functionName().toString()
  if (functionName !== 'web_auth_verify') {
    throw new Sep45Error(
      `SEP-45 challenge invokes "${functionName}", not "web_auth_verify" — refusing to sign`,
      'INVALID_CHALLENGE',
    )
  }

  const [account, argHomeDomain] = call.args().map((arg) => scValToNative(arg))
  if (account !== walletAddress) {
    throw new Sep45Error(
      `SEP-45 challenge's "account" argument (${account}) does not match this wallet (${walletAddress})`,
      'INVALID_CHALLENGE',
    )
  }
  if (argHomeDomain !== homeDomain) {
    throw new Sep45Error(
      `SEP-45 challenge's "home_domain" argument (${argHomeDomain}) does not match the requested domain (${homeDomain})`,
      'INVALID_CHALLENGE',
    )
  }
}

/**
 * Sign the wallet's (unsigned) entry in a SEP-45 challenge with the passkey
 * signer, leaving every already-signed entry (the anchor's) untouched.
 *
 * Mirrors the SDK's `authorizeEntries` (sdk/src/core.ts): build the
 * `HashIdPreimageSorobanAuthorization` for the entry, hash it, and hand that
 * hash to the passkey as the WebAuthn challenge — the same primitive
 * `__check_auth` verifies for every ordinary contract call, so no new
 * cryptography is needed for SEP-45.
 *
 * `__check_auth` only verifies the signature; it never checks the network,
 * the signing address, or what is being invoked. An anchor (or a MITM of the
 * `stellar.toml` fetch that supplies `webAuthForContractsEndpoint`) could
 * otherwise hand back a "challenge" that invokes a token `transfer` instead
 * of `web_auth_verify`, so every one of those is validated here — before the
 * passkey ceremony runs, not after:
 *  - the network passphrase must match the wallet's configured network;
 *  - exactly one entry must be unsigned and addressed to `walletAddress`;
 *  - its invocation must be `web_auth_verify` on `webAuthContractId`, with no
 *    sub-invocations;
 *  - its `account` / `home_domain` arguments must match `walletAddress` /
 *    `homeDomain`.
 *
 * @param signAuthEntry   The wallet's existing passkey signer. Returns null
 *                        when the user cancels/declines the prompt.
 * @param currentLedger   The current ledger sequence, used to compute a
 *                         deliberate {@link SEP45_SIGNATURE_EXPIRATION_LEDGERS}
 *                         expiration rather than reusing the challenge's `0`.
 * @param walletAddress   This wallet's own `C…` contract address — the entry
 *                         addressed to any other account is rejected.
 * @param webAuthContractId The anchor's web-auth contract id (from its
 *                         `stellar.toml`), the only contract this will sign
 *                         an invocation for.
 * @param homeDomain      The anchor's home domain, as passed to
 *                         {@link fetchSep45Challenge} — must match the
 *                         challenge's `home_domain` argument.
 * @throws {Sep45Error} `SIGNATURE_REJECTED` if the passkey ceremony is
 *   cancelled; `INVALID_RESPONSE` if no unsigned wallet entry is found;
 *   `WRONG_NETWORK` if the challenge's network doesn't match the wallet's;
 *   `INVALID_CHALLENGE` if the invocation doesn't check out.
 */
export async function signSep45Challenge(
  challenge: Sep45Challenge,
  signAuthEntry: (payload: Uint8Array) => Promise<WebAuthnSignature | null>,
  currentLedger: number,
  walletAddress: string,
  webAuthContractId: string,
  homeDomain: string,
  expirationLedgers: number = SEP45_SIGNATURE_EXPIRATION_LEDGERS,
): Promise<xdr.SorobanAuthorizationEntry[]> {
  if (!Number.isInteger(currentLedger) || currentLedger <= 0) {
    throw new Sep45Error(`currentLedger must be a positive integer, got ${currentLedger}`, 'INVALID_CHALLENGE')
  }
  if (!StrKey.isValidContract(webAuthContractId)) {
    throw new Sep45Error(`webAuthContractId is not a valid contract address: ${webAuthContractId}`, 'INVALID_CHALLENGE')
  }

  const expectedNetworkPassphrase = getNetwork().networkPassphrase
  if (challenge.networkPassphrase !== expectedNetworkPassphrase) {
    throw new Sep45Error(
      `SEP-45 challenge is for the wrong network (anchor sent "${challenge.networkPassphrase}", wallet is on "${expectedNetworkPassphrase}") — refusing to sign`,
      'WRONG_NETWORK',
    )
  }

  // Locate the single unsigned entry addressed to this wallet, and validate
  // its invocation, before running the passkey ceremony or hashing anything.
  let walletEntryIndex = -1
  for (let i = 0; i < challenge.entries.length; i++) {
    const entry = challenge.entries[i]
    if (!isUnsignedAddressEntry(entry)) continue

    const entryAddress = Address.fromScAddress(entry.credentials().address().address()).toString()
    if (entryAddress !== walletAddress) {
      throw new Sep45Error(
        `SEP-45 challenge contains an unsigned entry addressed to ${entryAddress}, not this wallet (${walletAddress})`,
        'INVALID_CHALLENGE',
      )
    }
    if (walletEntryIndex !== -1) {
      throw new Sep45Error(
        'SEP-45 challenge contains more than one unsigned entry addressed to this wallet',
        'INVALID_CHALLENGE',
      )
    }
    walletEntryIndex = i
  }
  if (walletEntryIndex === -1) {
    throw new Sep45Error('No unsigned wallet entry found in the SEP-45 challenge', 'INVALID_RESPONSE')
  }

  validateWebAuthInvocation(
    challenge.entries[walletEntryIndex].rootInvocation(),
    webAuthContractId,
    walletAddress,
    homeDomain,
  )

  const networkId = Buffer.from(
    (stellarHash as (input: Buffer) => Buffer)(Buffer.from(challenge.networkPassphrase)),
  )
  const signatureExpirationLedger = currentLedger + expirationLedgers

  return Promise.all(
    challenge.entries.map(async (entry, i) => {
      if (i !== walletEntryIndex) return entry // the anchor's own entry — already signed, pass through

      const addrCred = entry.credentials().address()
      const preimage = xdr.HashIdPreimage.envelopeTypeSorobanAuthorization(
        new xdr.HashIdPreimageSorobanAuthorization({
          networkId,
          nonce: addrCred.nonce(),
          invocation: entry.rootInvocation(),
          signatureExpirationLedger,
        }),
      )
      const payloadHash = new Uint8Array(
        (stellarHash as (input: Buffer) => Buffer)(Buffer.from(preimage.toXDR())),
      )

      const sig = await signAuthEntry(payloadHash)
      if (!sig) {
        throw new Sep45Error('The passkey signature was cancelled or rejected', 'SIGNATURE_REJECTED')
      }

      const sigVec = xdr.ScVal.scvVec([
        nativeToScVal(sig.publicKey, { type: 'bytes' }),
        nativeToScVal(sig.authData, { type: 'bytes' }),
        nativeToScVal(sig.clientDataJSON, { type: 'bytes' }),
        nativeToScVal(sig.signature, { type: 'bytes' }),
      ])

      return new xdr.SorobanAuthorizationEntry({
        credentials: xdr.SorobanCredentials.sorobanCredentialsAddress(
          new xdr.SorobanAddressCredentials({
            address: addrCred.address(),
            nonce: addrCred.nonce(),
            signatureExpirationLedger,
            signature: sigVec,
          }),
        ),
        rootInvocation: entry.rootInvocation(),
      })
    }),
  )
}

// ── Submission ───────────────────────────────────────────────────────────────

/**
 * POST the signed challenge entries back to the anchor and return the JWT.
 *
 * Store the returned token like any other bearer JWT — it is accepted
 * wherever `./sep24.ts`'s `initiateDeposit` / `initiateWithdraw` /
 * `getTransactionStatus` take a `jwt` argument, in place of a SEP-10 token.
 *
 * @throws {Sep45Error} `CHALLENGE_EXPIRED` when the anchor reports the
 *   signature's expiration has passed, `SIGNATURE_REJECTED` for any other
 *   4xx (bad signature, wrong signer, malformed entry), `ANCHOR_ERROR` for a
 *   5xx or a 2xx response with no token, and `NETWORK_ERROR` if the request
 *   never reaches the anchor.
 */
export async function submitSep45Challenge(
  webAuthForContractsEndpoint: string,
  signedEntries: xdr.SorobanAuthorizationEntry[],
): Promise<string> {
  let res: Response
  try {
    res = await fetch(webAuthForContractsEndpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ authorization_entries: encodeAuthEntries(signedEntries) }),
      signal: AbortSignal.timeout(15_000),
    })
  } catch (err) {
    throw new Sep45Error(
      `Could not reach the anchor to submit the signed SEP-45 challenge: ${err instanceof Error ? err.message : String(err)}`,
      'NETWORK_ERROR',
    )
  }

  let body: unknown
  try {
    body = await res.json()
  } catch {
    throw new Sep45Error(
      `Anchor returned a non-JSON response to the signed challenge (HTTP ${res.status})`,
      'INVALID_RESPONSE',
    )
  }

  if (!res.ok) {
    const message = typeof (body as { error?: unknown })?.error === 'string'
      ? (body as { error: string }).error
      : `HTTP ${res.status}`

    if (res.status === 400 && /expir/i.test(message)) {
      throw new Sep45Error(`SEP-45 challenge expired before it was accepted: ${message}`, 'CHALLENGE_EXPIRED')
    }
    if (res.status >= 400 && res.status < 500) {
      throw new Sep45Error(`Anchor rejected the signed SEP-45 challenge: ${message}`, 'SIGNATURE_REJECTED')
    }
    throw new Sep45Error(`Anchor returned an error for the SEP-45 challenge: ${message}`, 'ANCHOR_ERROR')
  }

  const token = (body as { token?: unknown })?.token
  if (typeof token !== 'string' || token.length === 0) {
    throw new Sep45Error('Anchor response did not include a token', 'INVALID_RESPONSE')
  }
  return token
}
