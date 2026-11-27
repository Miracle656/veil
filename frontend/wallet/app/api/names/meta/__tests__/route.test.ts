/**
 * @jest-environment node
 */

/**
 * `GET /api/names/meta` — the refusal path is the point of this test.
 *
 * The success path needs a live registry, so the cases here are the ones the
 * route decides on its own: a missing query, a name that is not ours, and a
 * registry that cannot answer (which must be a 404 `NO_META_ADDRESS`, not an
 * empty 200 a sender could mistake for a usable record).
 */

import { NextRequest } from 'next/server'

import { GET, OPTIONS } from '../route'

function get(query: string): NextRequest {
  return new NextRequest(`https://app.useveilapp.xyz/api/names/meta${query}`)
}

describe('GET /api/names/meta', () => {
  const savedEnv = { ...process.env }

  beforeEach(() => {
    delete process.env.VEIL_FEDERATION_NETWORK
    delete process.env.NEXT_PUBLIC_PRIVACY_FEATURE_FLAG
  })

  afterAll(() => {
    process.env = { ...savedEnv }
  })
  it('400s without q', async () => {
    const res = await GET(get(''))
    expect(res.status).toBe(400)
    expect((await res.json()).error).toBe('MISSING_QUERY')
  })

  it('400s for a name on another domain rather than answering for it', async () => {
    const res = await GET(get('?q=ada*lobstr.co'))
    expect(res.status).toBe(400)
    expect((await res.json()).error).toBe('NOT_A_VEIL_NAME')
  })

  it('400s for a bare name, because a domain is part of the question', async () => {
    expect((await GET(get('?q=ada'))).status).toBe(400)
  })

  it('does not query the registry when the testnet privacy preview is disabled', async () => {
    const res = await GET(get('?q=ada*useveilapp.xyz'))
    expect(res.status).toBe(503)
    expect((await res.json()).error).toBe('PRIVACY_DISABLED')
  })

  it('treats an unavailable or old registry as unavailable, not as no record', async () => {
    process.env.VEIL_FEDERATION_NETWORK = 'testnet'
    process.env.NEXT_PUBLIC_PRIVACY_FEATURE_FLAG = '1'
    const res = await GET(get('?q=ada*useveilapp.xyz'))
    expect(res.status).toBe(503)
    expect((await res.json()).error).toBe('META_ADDRESS_LOOKUP_UNAVAILABLE')
  })

  it('never caches, because a record can be published or removed', async () => {
    const res = await GET(get('?q=ada*useveilapp.xyz'))
    expect(res.headers.get('Cache-Control')).toBe('no-store')
  })

  it('answers a preflight with 204', async () => {
    const res = await OPTIONS()
    expect(res.status).toBe(204)
    expect(res.headers.get('Access-Control-Allow-Origin')).toBe('*')
  })
})
