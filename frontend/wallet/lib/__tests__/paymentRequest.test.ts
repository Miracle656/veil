/**
 * Tests for the SEP-7 payment-request wiring (lib/paymentRequest.ts).
 *
 * Confirms a generated URI + QR payload round-trips into a correct pre-filled
 * send, and that malformed / hostile links are rejected safely.
 *
 * The SDK SEP-7 module pulls in @stellar/stellar-sdk, which needs TextEncoder;
 * jsdom does not provide it, so we install it first.
 */

import { TextEncoder, TextDecoder } from 'util'
Object.assign(globalThis, { TextEncoder, TextDecoder })

import {
  createPaymentRequest,
  parsePaymentLink,
  parseScannedValue,
  tryParsePaymentLink,
  isPaymentRequestUri,
  Sep7Error,
} from '../paymentRequest'

const DEST = 'GCSWM5I2FRYFIDSVJDGLWDH4TMQZY6IVT4JDF2SCFW6PPJ56TSBH23NO'
const ISSUER = 'GD2VUFNSFXBAVZEZIU6VRPFU2KMSU4VQKP65SCE4TR5C2MJPLJ6VEAIM'

describe('createPaymentRequest', () => {
  it('produces a SEP-7 URI and a matching QR payload', () => {
    const { uri, qrValue } = createPaymentRequest({ destination: DEST, amount: '10' })
    expect(uri.startsWith('web+stellar:pay?')).toBe(true)
    expect(qrValue).toBe(uri)
  })

  it('throws on an invalid destination', () => {
    expect(() => createPaymentRequest({ destination: 'nope' })).toThrow(Sep7Error)
  })
})

describe('QR round-trip → pre-filled send', () => {
  it('round-trips a full invoice into the correct pre-fill', () => {
    const { qrValue } = createPaymentRequest({
      destination: DEST,
      amount: '42.5',
      assetCode: 'USDC',
      assetIssuer: ISSUER,
      memo: 'invoice-1001',
      callback: 'https://merchant.example/cb',
      msg: 'Invoice 1001',
    })

    // Simulate scanning the QR and pre-filling the send screen.
    const prefilled = parseScannedValue(qrValue)

    expect(prefilled).toEqual({
      destination: DEST,
      amount: '42.5',
      assetCode: 'USDC',
      assetIssuer: ISSUER,
      memo: 'invoice-1001',
      memoType: 'text',
      callback: 'https://merchant.example/cb',
      msg: 'Invoice 1001',
    })
  })

  it('round-trips a native XLM request with no asset fields', () => {
    const { uri } = createPaymentRequest({ destination: DEST, amount: '1' })
    const prefilled = parsePaymentLink(uri)
    expect(prefilled.destination).toBe(DEST)
    expect(prefilled.amount).toBe('1')
    expect(prefilled.assetCode).toBeUndefined()
    expect(prefilled.assetIssuer).toBeUndefined()
  })

  it('treats a bare scanned address as destination-only', () => {
    expect(parseScannedValue(DEST)).toEqual({ destination: DEST })
  })
})

describe('hostile / malformed inputs are rejected safely', () => {
  it.each([
    ['wrong scheme', 'https://evil.example/pay?destination=' + DEST],
    ['javascript callback', `web+stellar:pay?destination=${DEST}&callback=url%3Ajavascript%3Aalert(1)`],
    ['bad destination', 'web+stellar:pay?destination=GINVALID'],
    ['negative amount', `web+stellar:pay?destination=${DEST}&amount=-1`],
    ['empty', ''],
  ])('%s', (_label, input) => {
    expect(() => parsePaymentLink(input)).toThrow(Sep7Error)
  })

  it('tryParsePaymentLink returns null instead of throwing on bad input', () => {
    expect(tryParsePaymentLink('not a link')).toBeNull()
    expect(tryParsePaymentLink(`web+stellar:pay?destination=${DEST}`)).toEqual({ destination: DEST })
  })
})

describe('isPaymentRequestUri', () => {
  it('detects SEP-7 URIs without validating them', () => {
    expect(isPaymentRequestUri('web+stellar:pay?destination=x')).toBe(true)
    expect(isPaymentRequestUri('  WEB+STELLAR:pay?x ')).toBe(true)
    expect(isPaymentRequestUri('https://x')).toBe(false)
  })
})
