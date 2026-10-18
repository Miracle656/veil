/**
 * @jest-environment node
 */

import { NextRequest } from 'next/server'
import { GET, OPTIONS } from '../route'
import * as namesResolver from '@/lib/namesResolver'

describe('GET /api/federation route handler (Issue #1075)', () => {
  it('returns 400 when q or type are missing', async () => {
    const req = new NextRequest('https://app.useveilapp.xyz/api/federation')
    const res = await GET(req)
    expect(res.status).toBe(400)
    const json = await res.json()
    expect(json.detail).toContain('Missing required query parameters')
  })

  it('returns 200 with SEP-2 payload and 60-second Cache-Control for type=name', async () => {
    jest.spyOn(namesResolver, 'resolveFederationName').mockResolvedValueOnce({
      stellar_address: 'alice*useveilapp.xyz',
      account_id: 'GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWLT',
    })

    const req = new NextRequest('https://app.useveilapp.xyz/api/federation?q=alice*useveilapp.xyz&type=name')
    const res = await GET(req)

    expect(res.status).toBe(200)
    expect(res.headers.get('Cache-Control')).toBe('public, max-age=60, s-maxage=60')
    expect(res.headers.get('Access-Control-Allow-Origin')).toBe('*')

    const json = await res.json()
    expect(json.stellar_address).toBe('alice*useveilapp.xyz')
    expect(json.account_id).toBe('GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWLT')
  })

  it('returns 200 for type=id reverse lookup', async () => {
    jest.spyOn(namesResolver, 'resolveFederationId').mockResolvedValueOnce({
      stellar_address: 'bob*useveilapp.xyz',
      account_id: 'GBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBOTHR',
    })

    const req = new NextRequest('https://app.useveilapp.xyz/api/federation?q=GBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBOTHR&type=id')
    const res = await GET(req)

    expect(res.status).toBe(200)
    const json = await res.json()
    expect(json.stellar_address).toBe('bob*useveilapp.xyz')
  })

  it('returns 404 when name is not found', async () => {
    jest.spyOn(namesResolver, 'resolveFederationName').mockRejectedValueOnce(
      new namesResolver.NameNotFoundError('unknown'),
    )

    const req = new NextRequest('https://app.useveilapp.xyz/api/federation?q=unknown*useveilapp.xyz&type=name')
    const res = await GET(req)

    expect(res.status).toBe(404)
    const json = await res.json()
    expect(json.detail).toBe('address not found')
  })

  it('returns 502 when on-chain holder cannot be read', async () => {
    jest.spyOn(namesResolver, 'resolveFederationName').mockRejectedValueOnce(
      new namesResolver.UnreadableHolderError('alice', '1'),
    )

    const req = new NextRequest('https://app.useveilapp.xyz/api/federation?q=alice*useveilapp.xyz&type=name')
    const res = await GET(req)

    expect(res.status).toBe(502)
    const json = await res.json()
    expect(json.detail).toContain('Cannot determine current on-chain holder')
  })

  it('responds with 204 to OPTIONS request', async () => {
    const res = await OPTIONS()
    expect(res.status).toBe(204)
    expect(res.headers.get('Access-Control-Allow-Origin')).toBe('*')
  })
})
