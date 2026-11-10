/**
 * @jest-environment node
 */

/**
 * The names API is closed (`lib/namesApiGate.ts`).
 *
 * This file previously drove the in-process registry through the routes and
 * asserted a 201 on `paymentTxHash: 'tx_valid_jupiter'` — encoding, as
 * intended behaviour, that any non-empty string buys a name. Those cases are
 * gone with the behaviour. What the registry itself does with a reserved
 * name, a taken name or a bad charset is covered directly in
 * `lib/__tests__/namesRegistry.test.ts`, so nothing unique moved out of
 * coverage here.
 *
 * What is left is the thing that must not regress: both routes refuse, and
 * they refuse for every shape of request, including a well-formed one.
 */

import { NextRequest } from 'next/server'

import { POST as claimPOST, OPTIONS as claimOPTIONS } from '../claim/route'
import { GET as availableGET, OPTIONS as availableOPTIONS } from '../available/route'

describe('the names API is closed until the registry is on-chain', () => {
  describe('POST /api/names/claim', () => {
    it('refuses a well-formed claim with 503', async () => {
      const res = await claimPOST()
      expect(res.status).toBe(503)

      const data = await res.json()
      expect(data.code).toBe('NAMES_NOT_AVAILABLE')
    })

    it('never answers 201, whatever the body says', async () => {
      // The body is ignored entirely — the route takes no request argument.
      // Asserting the status directly is the point: there is no combination
      // of fields that reaches the registry any more.
      const res = await claimPOST()
      expect(res.status).not.toBe(201)
    })

    it('is not cached, so lifting the gate takes effect immediately', async () => {
      const res = await claimPOST()
      expect(res.headers.get('Cache-Control')).toBe('no-store')
    })

    it('answers an OPTIONS preflight with 204 and CORS headers', async () => {
      const res = await claimOPTIONS()
      expect(res.status).toBe(204)
      expect(res.headers.get('Access-Control-Allow-Origin')).toBe('*')
    })
  })

  describe('GET /api/names/available', () => {
    it('refuses with 503 rather than claiming a name is free', async () => {
      const res = await availableGET()
      expect(res.status).toBe(503)

      const data = await res.json()
      expect(data.code).toBe('NAMES_NOT_AVAILABLE')
      // The old route returned `available: true` for every name, because the
      // in-process registry is always empty in production.
      expect(data.available).toBeUndefined()
    })

    it('does not let a client cache the refusal as an answer', async () => {
      const res = await availableGET()
      expect(res.headers.get('Cache-Control')).toBe('no-store')
    })

    it('answers an OPTIONS preflight with 204 and CORS headers', async () => {
      const res = await availableOPTIONS()
      expect(res.status).toBe(204)
      expect(res.headers.get('Access-Control-Allow-Origin')).toBe('*')
    })
  })

  describe('the request type still compiles against NextRequest', () => {
    it('constructs a request the route would have received', () => {
      // Kept so the import does not drift out of the file while the routes
      // take no argument; when the gate lifts, these handlers take a
      // NextRequest again and this is the shape they get.
      const req = new NextRequest('https://app.useveilapp.xyz/api/names/available?name=adebayo')
      expect(new URL(req.url).searchParams.get('name')).toBe('adebayo')
    })
  })
})
