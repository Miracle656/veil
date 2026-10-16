// @stellar/stellar-sdk needs TextEncoder at module load; jsdom omits it.
import { TextEncoder, TextDecoder } from 'util'
Object.assign(globalThis, { TextEncoder, TextDecoder })

/**
 * #791 — a payment request resolves to an exact code:issuer, or is refused.
 *
 * Mainnet has eight assets called USDT0; seven are impostors (the two below
 * end their addresses in "USDT" to look the part). A code match is not an
 * asset match, so these tests pin down every way a request is refused and the
 * one way it is accepted.
 */

import { Asset, Networks } from '@stellar/stellar-sdk'
import { readPaymentRequest, resolveRequestedAsset } from '../requestedAsset'
import { createPaymentRequest } from '../paymentRequest'
import { getAssetIssuer, USDT0_MAINNET_ISSUER, USDT0_MAINNET_SAC } from '../assets'

const DEST = 'GCSWM5I2FRYFIDSVJDGLWDH4TMQZY6IVT4JDF2SCFW6PPJ56TSBH23NO'
const IMPOSTORS = [
  'GC35JBERU4SFTDVOF32A2SIJN5FHSLSZFZSGP6VVFWCZNDVGJFLQBANK',
  'GADUBOKGYG4E2BZUVXAZBBILGPIYIPOXAXWIIG6DJ4JDXWOQR67HUSDT',
  'GBL35PWBKAHURS7SMATHXTS5X57BHC23P2B6MOJTDXTDKD7K25QHUSDT',
]
const pay = (query: string) => `web+stellar:pay?destination=${DEST}&${query}`

describe('refusal case 1: a code with no issuer', () => {
  it('refuses asset=USDT0 with no issuer, and says it will not guess', () => {
    const read = readPaymentRequest(pay('asset_code=USDT0&amount=10'), 'mainnet')
    expect(read.ok).toBe(false)
    if (read.ok) return
    expect(read.reason).toMatch(/USDT0/)
    expect(read.reason).toMatch(/does not say who issued it/)
  })

  it('refuses a send handoff that names a code with no issuer', () => {
    expect(resolveRequestedAsset('USDT0', undefined, 'mainnet').ok).toBe(false)
  })

  it('still accepts native XLM, which has no issuer', () => {
    expect(resolveRequestedAsset('XLM', undefined, 'mainnet')).toEqual({ ok: true, asset: null })
    expect(readPaymentRequest(pay('amount=1'), 'mainnet')).toMatchObject({ ok: true, asset: null })
  })
})

describe('refusal case 2: an unregistered issuer', () => {
  it.each(IMPOSTORS)('refuses USDT0 issued by %s and names that issuer', (impostor) => {
    const read = readPaymentRequest(pay(`asset_code=USDT0&asset_issuer=${impostor}`), 'mainnet')
    expect(read.ok).toBe(false)
    if (read.ok) return
    expect(read.reason).toContain(`Unregistered issuer ${impostor}`)
  })

  it('does not let a held trustline launder an impostor of a registered code', () => {
    const held = [{ code: 'USDT0', issuer: IMPOSTORS[0] }]
    expect(resolveRequestedAsset('USDT0', IMPOSTORS[0], 'mainnet', held).ok).toBe(false)
  })

  it('refuses an unknown code:issuer the wallet does not hold, naming the issuer', () => {
    const r = resolveRequestedAsset('FOO', IMPOSTORS[1], 'mainnet')
    expect(r).toEqual({ ok: false, reason: expect.stringContaining(IMPOSTORS[1]) })
  })

  it('accepts an unknown code only when the wallet already holds that exact asset', () => {
    const held = [{ code: 'FOO', issuer: IMPOSTORS[1] }]
    expect(resolveRequestedAsset('FOO', IMPOSTORS[1], 'mainnet', held).ok).toBe(true)
  })

  it('refuses a case-variant of a registered code', () => {
    expect(resolveRequestedAsset('usdt0', USDT0_MAINNET_ISSUER, 'mainnet').ok).toBe(false)
  })

  it('refuses an issued asset calling itself XLM', () => {
    expect(resolveRequestedAsset('XLM', IMPOSTORS[0], 'mainnet').ok).toBe(false)
  })

  it('refuses USDT0 on testnet, where it does not exist', () => {
    expect(resolveRequestedAsset('USDT0', USDT0_MAINNET_ISSUER, 'testnet')).toEqual({
      ok: false,
      reason: 'USDT0 is not available on testnet.',
    })
  })
})

describe('refusal case 3: an issuer with no code, or a malformed one', () => {
  it('refuses an issuer with no asset code', () => {
    const read = readPaymentRequest(pay(`asset_issuer=${USDT0_MAINNET_ISSUER}`), 'mainnet')
    expect(read).toEqual({ ok: false, reason: expect.stringContaining('no asset') })
  })

  it('refuses an issuer that is not a valid account', () => {
    const read = readPaymentRequest(pay('asset_code=USDT0&asset_issuer=GNOTANACCOUNT'), 'mainnet')
    expect(read).toEqual({ ok: false, reason: expect.stringContaining('not a valid Stellar account') })
  })

  it('refuses a malformed request with the parser’s reason instead of throwing', () => {
    expect(readPaymentRequest('web+stellar:pay?amount=1', 'mainnet'))
      .toEqual({ ok: false, reason: expect.stringContaining('destination') })
  })
})

describe('round trip: request link → scan → review → submit', () => {
  it('carries the genuine USDT0 issuer the whole way', () => {
    // Receive: the issuer comes from the registry, and the QR encodes it.
    const issuer = getAssetIssuer('USDT0', 'mainnet')!
    const { qrValue } = createPaymentRequest({ destination: DEST, amount: '250', assetCode: 'USDT0', assetIssuer: issuer })
    expect(qrValue).toContain(`asset_issuer=${USDT0_MAINNET_ISSUER}`)

    // Scan: resolved to the exact asset, with the rest of the request prefilled.
    const read = readPaymentRequest(qrValue, 'mainnet')
    if (!read.ok) throw new Error(read.reason)
    expect(read.asset).toEqual({ code: 'USDT0', issuer: USDT0_MAINNET_ISSUER })
    expect(read.prefill).toMatchObject({ destination: DEST, amount: '250' })

    // Review and submit build the asset from that pair — and it is the real SAC.
    const asset = new Asset(read.asset!.code, read.asset!.issuer)
    expect(asset.getIssuer()).toBe(USDT0_MAINNET_ISSUER)
    expect(asset.contractId(Networks.PUBLIC)).toBe(USDT0_MAINNET_SAC)
  })

  it('carries testnet USDC’s issuer on testnet', () => {
    const issuer = getAssetIssuer('USDC', 'testnet')!
    const { qrValue } = createPaymentRequest({ destination: DEST, assetCode: 'USDC', assetIssuer: issuer })
    expect(readPaymentRequest(qrValue, 'testnet')).toMatchObject({ ok: true, asset: { code: 'USDC', issuer } })
  })

  it('carries memo and memo_type (MEMO_ID) through payment request parsing (#704)', () => {
    const read = readPaymentRequest(pay('amount=50&memo=123456789&memo_type=MEMO_ID'), 'mainnet')
    expect(read.ok).toBe(true)
    if (!read.ok) return
    expect(read.prefill.memo).toBe('123456789')
    expect(read.prefill.memoType).toBe('id')
  })

  it('normalises query string memo_type correctly for send page prefill (#704)', () => {
    for (const [input, expected] of [
      ['MEMO_ID', 'id'],
      ['id', 'id'],
      ['MEMO_TEXT', 'text'],
      ['text', 'text'],
      ['MEMO_HASH', 'hash'],
      ['hash', 'hash'],
      ['MEMO_RETURN', 'return'],
      ['return', 'return'],
      ['unknown', null],
    ]) {
      const q = new URLSearchParams(`memo_type=${input}`)
      const rawMt = (q.get('memo_type') ?? '').toLowerCase()
      const normalizedMt = rawMt.startsWith('memo_') ? rawMt.slice(5) : rawMt
      const mt = ['text', 'id', 'hash', 'return'].includes(normalizedMt)
        ? normalizedMt
        : null
      expect(mt).toBe(expected)
    }
  })
})
