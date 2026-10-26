/**
 * @jest-environment node
 */

import { NextRequest } from 'next/server'
import { POST as claimPOST, OPTIONS as claimOPTIONS } from '../claim/route'
import { GET as availableGET } from '../available/route'
import { globalNamesRegistry } from '@/lib/namesRegistry'

describe('/api/names/claim and /api/names/available routes (Issue #1073)', () => {
  beforeEach(() => {
    globalNamesRegistry.reset()
  })

  describe('POST /api/names/claim', () => {
    it('returns 400 when required fields are missing', async () => {
      const req = new NextRequest('https://app.useveilapp.xyz/api/names/claim', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: 'myname' }),
      })

      const res = await claimPOST(req)
      expect(res.status).toBe(400)
      const data = await res.json()
      expect(data.error).toContain('Missing required fields')
    })

    it('returns 402 for unpaid claims', async () => {
      const req = new NextRequest('https://app.useveilapp.xyz/api/names/claim', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: 'cooperative',
          walletAddress: 'GA_WALLET_123',
          passkeyPublicKey: 'pk_unpaid_route',
          paymentTxHash: '',
        }),
      })

      const res = await claimPOST(req)
      expect(res.status).toBe(402)
      const data = await res.json()
      expect(data.code).toBe('UNPAID_CLAIM')
    })

    it('returns 403 when claiming a reserved name', async () => {
      const req = new NextRequest('https://app.useveilapp.xyz/api/names/claim', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: 'admin',
          walletAddress: 'GA_SQUATTER',
          passkeyPublicKey: 'pk_squatter',
          paymentTxHash: 'tx_hash_squatter',
        }),
      })

      const res = await claimPOST(req)
      expect(res.status).toBe(403)
      const data = await res.json()
      expect(data.code).toBe('RESERVED_NAME')
    })

    it('returns 201 when claim succeeds', async () => {
      const req = new NextRequest('https://app.useveilapp.xyz/api/names/claim', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: 'jupiter',
          walletAddress: 'GA_JUPITER_WALLET',
          passkeyPublicKey: 'pk_jupiter_pk',
          paymentTxHash: 'tx_valid_jupiter',
        }),
      })

      const res = await claimPOST(req)
      expect(res.status).toBe(201)
      const data = await res.json()
      expect(data.success).toBe(true)
      expect(data.record.name).toBe('jupiter')
      expect(data.record.stellar_address).toBe('jupiter*useveilapp.xyz')
      expect(data.record.tokenId).toBe('1')
    })

    it('returns 409 when claiming an already taken name', async () => {
      // First claim
      await globalNamesRegistry.claimName({
        name: 'saturn',
        walletAddress: 'GA_SATURN',
        passkeyPublicKey: 'pk_saturn',
        paymentTxHash: 'tx_saturn',
      })

      const req = new NextRequest('https://app.useveilapp.xyz/api/names/claim', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: 'saturn',
          walletAddress: 'GA_SATURN_2',
          passkeyPublicKey: 'pk_saturn_2',
          paymentTxHash: 'tx_saturn_2',
        }),
      })

      const res = await claimPOST(req)
      expect(res.status).toBe(409)
      const data = await res.json()
      expect(data.code).toBe('NAME_ALREADY_TAKEN')
    })

    it('responds to OPTIONS preflight with 204 and CORS headers', async () => {
      const res = await claimOPTIONS()
      expect(res.status).toBe(204)
      expect(res.headers.get('Access-Control-Allow-Origin')).toBe('*')
    })
  })

  describe('GET /api/names/available', () => {
    it('returns 400 if name parameter is missing', async () => {
      const req = new NextRequest('https://app.useveilapp.xyz/api/names/available')
      const res = await availableGET(req)
      expect(res.status).toBe(400)
    })

    it('returns available: true for untaken valid name', async () => {
      const req = new NextRequest('https://app.useveilapp.xyz/api/names/available?name=available-name')
      const res = await availableGET(req)
      expect(res.status).toBe(200)
      const data = await res.json()
      expect(data.available).toBe(true)
    })

    it('returns available: false for taken name', async () => {
      await globalNamesRegistry.claimName({
        name: 'pluto',
        walletAddress: 'GA_PLUTO',
        passkeyPublicKey: 'pk_pluto',
        paymentTxHash: 'tx_pluto',
      })

      const req = new NextRequest('https://app.useveilapp.xyz/api/names/available?name=pluto')
      const res = await availableGET(req)
      expect(res.status).toBe(200)
      const data = await res.json()
      expect(data.available).toBe(false)
      expect(data.reason).toBe('Name is already taken')
    })
  })
})
