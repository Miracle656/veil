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

  it('404s with a machine-readable code when there is no record', async () => {
    // No registry is reachable in this environment, so the reader answers
    // null. The route must not turn that into `{}` — a sender cannot derive
    // anything from an absent record, and a public fallback is exactly what
    // this endpoint exists to prevent.
    const res = await GET(get('?q=ada*useveilapp.xyz'))
    expect(res.status).toBe(404)

    const body = await res.json()
    expect(body.error).toBe('NO_META_ADDRESS')
    expect(body.detail).toContain('public payment')
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
