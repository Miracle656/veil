/**
 * @jest-environment node
 */

import { NextRequest } from 'next/server'

import { GET, OPTIONS } from '../route'

function get(query: string): NextRequest {
  return new NextRequest(`https://app.useveilapp.xyz/api/federation${query}`)
}

describe('GET /api/federation', () => {
  it('is reachable at all — the endpoint stellar.toml advertises', async () => {
    // The regression this route exists for: the published FEDERATION_SERVER
    // URL returned Next's HTML 404, so wallets got markup where they expected
    // JSON. Any JSON answer, including a 404 body, is the fix.
    const res = await GET(get('?q=adebayo*useveilapp.xyz&type=name'))
    expect(res.headers.get('content-type')).toContain('application/json')
  })

  describe('parameter validation', () => {
    it('400s without q', async () => {
      expect((await GET(get('?type=name'))).status).toBe(400)
    })

    it('400s without type', async () => {
      // SEP-2 requires `type`; guessing it would make the endpoint answer
      // differently from every other federation server.
      expect((await GET(get('?q=adebayo*useveilapp.xyz'))).status).toBe(400)
    })

    it('400s on an unknown type and names the ones it takes', async () => {
      const res = await GET(get('?q=adebayo*useveilapp.xyz&type=nonsense'))
      expect(res.status).toBe(400)

      const body = await res.json()
      expect(body.detail).toContain('name')
      expect(body.detail).toContain('id')
    })
  })

  describe('type=name', () => {
    it('404s for an unregistered name, since the registry is not deployed', async () => {
      const res = await GET(get('?q=adebayo*useveilapp.xyz&type=name'))
      expect(res.status).toBe(404)
      expect((await res.json()).detail).toBeTruthy()
    })

    it('404s rather than answering for another domain', async () => {
      expect((await GET(get('?q=adebayo*lobstr.co&type=name'))).status).toBe(404)
    })

    it('never caches, because expiry is a ledger fact', async () => {
      // A cached 404 would outlive a registration, and a cached hit would
      // outlive an expiry — which is exactly the stale-contact hazard the
      // contract's 90-day recovery window exists to contain.
      const res = await GET(get('?q=adebayo*useveilapp.xyz&type=name'))
      expect(res.headers.get('Cache-Control')).toBe('no-store')
    })
  })

  describe('the other SEP-2 types', () => {
    it('404s on type=id, because the registry has no reverse index', async () => {
      const res = await GET(get('?q=CWALLET123&type=id'))
      expect(res.status).toBe(404)
    })

    it('400s on type=forward, because Veil runs no off-network rail', async () => {
      // Deliberately not a 404: "not found" would imply a right destination
      // might exist, and for forwarding none can.
      expect((await GET(get('?q=adebayo*useveilapp.xyz&type=forward'))).status).toBe(400)
    })

    it('404s on type=txid', async () => {
      expect((await GET(get('?q=abc123&type=txid'))).status).toBe(404)
    })
  })

  describe('CORS', () => {
    it('is open to any origin, as a federation server must be', async () => {
      // Public by specification: any wallet on any origin resolves a name
      // without a key. This is the one endpoint where `*` is correct.
      const res = await GET(get('?q=adebayo*useveilapp.xyz&type=name'))
      expect(res.headers.get('Access-Control-Allow-Origin')).toBe('*')
    })

    it('answers a preflight with 204', async () => {
      const res = await OPTIONS()
      expect(res.status).toBe(204)
      expect(res.headers.get('Access-Control-Allow-Origin')).toBe('*')
    })
  })
})
