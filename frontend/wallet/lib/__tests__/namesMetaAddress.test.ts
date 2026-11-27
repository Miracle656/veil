/**
 * @jest-environment node
 */

/**
 * The send screen's copy of the registry answer.
 *
 * Every case here is a refusal or a published record — there is no "assume it
 * is fine" branch, because the whole feature is opt-in. `not-published` and
 * `unknown` are kept apart: one means the holder has not opted in, the other
 * means Veil could not ask, and neither may become a stealth address.
 */

import {
  lookupNameMetaAddress,
  noMetaAddressMessage,
  parseVeilName,
} from '../namesMetaAddress'
import {
  bytesToHex,
  encodeMetaAddress,
  metaAddressFromSecrets,
} from '../stealthAddress'

function scalar(...tail: number[]): Uint8Array {
  const out = new Uint8Array(32)
  out.set(tail, 32 - tail.length)
  return out
}

const meta = metaAddressFromSecrets(scalar(1, 2, 3), scalar(4, 5, 6))

function respond(status: number, body: unknown): typeof fetch {
  return (async () => ({
    status,
    ok: status >= 200 && status < 300,
    json: async () => body,
  })) as unknown as typeof fetch
}

describe('parseVeilName', () => {
  it('takes the bare name from one of our names', () => {
    expect(parseVeilName('ada*useveilapp.xyz')).toBe('ada')
    expect(parseVeilName('  ada*useveilapp.xyz ')).toBe('ada')
  })

  it('refuses another domain, a bare name, and an empty name', () => {
    expect(parseVeilName('ada*lobstr.co')).toBeNull()
    expect(parseVeilName('ada')).toBeNull()
    expect(parseVeilName('*useveilapp.xyz')).toBeNull()
  })
})

describe('lookupNameMetaAddress', () => {
  it('returns the parsed keys and the canonical address', async () => {
    const lookup = await lookupNameMetaAddress('ada*useveilapp.xyz', {
      fetchImpl: respond(200, {
        stellar_address: 'ada*useveilapp.xyz',
        spend_key: bytesToHex(meta.spendKey),
        view_key: bytesToHex(meta.viewKey),
      }),
    })

    expect(lookup.status).toBe('published')
    if (lookup.status !== 'published') throw new Error('expected a published record')
    expect(lookup.name).toBe('ada')
    expect(bytesToHex(lookup.meta.spendKey)).toBe(bytesToHex(meta.spendKey))
    expect(bytesToHex(lookup.meta.viewKey)).toBe(bytesToHex(meta.viewKey))
  })

  it('asks the API for the full federated address, encoded', async () => {
    const seen: string[] = []
    const fetchImpl = (async (url: string) => {
      seen.push(String(url))
      return { status: 404, ok: false, json: async () => ({}) }
    }) as unknown as typeof fetch

    await lookupNameMetaAddress('ada*useveilapp.xyz', { fetchImpl, baseUrl: 'https://veil.test/' })

    // `encodeURIComponent` leaves `*` alone; it is legal in a query.
    expect(seen).toEqual([
      'https://veil.test/api/names/meta?q=ada*useveilapp.xyz',
    ])
  })

  it('refuses a name with no record instead of falling back to its public address', async () => {
    const lookup = await lookupNameMetaAddress('ada*useveilapp.xyz', {
      fetchImpl: respond(404, { error: 'NO_META_ADDRESS' }),
    })

    expect(lookup.status).toBe('not-published')
    if (lookup.status !== 'not-published') throw new Error('expected a refusal')
    expect(lookup.message).toBe(noMetaAddressMessage('ada*useveilapp.xyz'))
    expect(lookup.message).toContain('public payment')
  })

  it('treats an outage as unknown, not as “no record”', async () => {
    const fetchImpl = (async () => {
      throw new Error('offline')
    }) as unknown as typeof fetch

    const lookup = await lookupNameMetaAddress('ada*useveilapp.xyz', { fetchImpl })

    expect(lookup.status).toBe('unknown')
    if (lookup.status !== 'unknown') throw new Error('expected unknown')
    expect(lookup.message).toContain('not a private destination')
  })

  it('treats a server error as unknown', async () => {
    const lookup = await lookupNameMetaAddress('ada*useveilapp.xyz', {
      fetchImpl: respond(503, { error: 'NAMES_NOT_AVAILABLE' }),
    })
    expect(lookup.status).toBe('unknown')
  })

  it('refuses a record that does not parse rather than deriving from it', async () => {
    const lookup = await lookupNameMetaAddress('ada*useveilapp.xyz', {
      fetchImpl: respond(200, {
        stellar_address: 'ada*useveilapp.xyz',
        spend_key: 'ff'.repeat(32),
        view_key: '00'.repeat(32),
      }),
    })

    expect(lookup.status).toBe('unknown')
    if (lookup.status !== 'unknown') throw new Error('expected unknown')
    expect(lookup.message).toContain('cannot use')
  })

  it('never asks the API about another domain', async () => {
    const fetchImpl = jest.fn() as unknown as typeof fetch
    const lookup = await lookupNameMetaAddress('ada*lobstr.co', { fetchImpl })

    expect(lookup.status).toBe('not-veil-name')
    expect(fetchImpl).not.toHaveBeenCalled()
  })

  it('round-trips an encoded meta-address through the API shape', async () => {
    // The wire shape is hex fields, not the `st:vly:` string; both must
    // describe the same keys.
    const encoded = encodeMetaAddress(meta)
    const lookup = await lookupNameMetaAddress('ada*useveilapp.xyz', {
      fetchImpl: respond(200, {
        stellar_address: 'ada*useveilapp.xyz',
        spend_key: encoded.slice('st:vly:'.length, 64 + 'st:vly:'.length),
        view_key: encoded.slice(64 + 'st:vly:'.length),
      }),
    })

    expect(lookup.status).toBe('published')
    if (lookup.status !== 'published') throw new Error('expected a published record')
    expect(encodeMetaAddress(lookup.meta)).toBe(encoded)
  })
})
