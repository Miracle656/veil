/**
 * @jest-environment jsdom
 *
 * V139 — Web: selective disclosure ("prove this payment")
 * Tests for lib/privacy/disclosure.ts.
 */

import { webcrypto } from 'crypto'
import { TextEncoder, TextDecoder } from 'util'

Object.defineProperty(globalThis, 'crypto', {
  value: webcrypto,
  configurable: true,
  writable: true,
})
Object.assign(globalThis, { TextEncoder, TextDecoder })

import {
  generateDisclosure,
  verifyDisclosure,
  encodeDisclosureForLink,
  decodeDisclosureFromLink,
  type SelectiveDisclosure,
} from '../disclosure'
import { SPP_NETWORKS } from '../config'

describe('Selective Disclosure (V139)', () => {
  const samplePayment = {
    txHash: '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef',
    timestamp: 1727218800,
    amount: '125.5000000',
    asset: 'XLM',
    sender: 'GAEXAMPLEPAYERSENDERWALLET7XLMADDRESS234567890123456789012',
    recipient: 'GBEXAMPLERECEIVERLANDLORDADDRESS3456789012345678901234567',
    memo: 'Rent Oct 2026',
  }

  const sampleParty = 'Metro Realty Landlord Management'

  it('generates a valid note-scoped disclosure proof bound to the intended party', async () => {
    const disclosure = await generateDisclosure({
      payment: samplePayment,
      intendedParty: sampleParty,
    })

    expect(disclosure.version).toBe(1)
    expect(disclosure.intendedParty).toBe(sampleParty)
    expect(disclosure.network).toBe('testnet')
    expect(disclosure.verifierContractId).toBe(SPP_NETWORKS.testnet?.verifiers.standard)
    expect(disclosure.noteScope.poolContractId).toBe(SPP_NETWORKS.testnet?.pools[0].id)
    expect(disclosure.noteScope.noteCommitment).toBeDefined()
    expect(disclosure.payment.amount).toBe(samplePayment.amount)
    expect(disclosure.proof.publicInputs).toHaveLength(6)

    // Isolation check: exactly one payment note
    expect(Object.keys(disclosure.noteScope)).toEqual(['noteCommitment', 'poolContractId'])
    expect((disclosure.noteScope as any).otherNotes).toBeUndefined()
    expect((disclosure.noteScope as any).balances).toBeUndefined()
  })

  it('accepts a valid disclosure in verifyDisclosure', async () => {
    const disclosure = await generateDisclosure({
      payment: samplePayment,
      intendedParty: sampleParty,
    })

    const result = await verifyDisclosure(disclosure)
    expect(result.valid).toBe(true)
    expect(result.error).toBeUndefined()
    expect(result.verificationDetails?.verifiedParty).toBe(sampleParty)
    expect(result.verificationDetails?.verifiedAmount).toBe('125.5000000 XLM')
    expect(result.verificationDetails?.verifiedTxHash).toBe(samplePayment.txHash)
  })

  it('rejects a disclosure if the payment amount was tampered with', async () => {
    const disclosure = await generateDisclosure({
      payment: samplePayment,
      intendedParty: sampleParty,
    })

    // Tamper with the amount
    const tampered = JSON.parse(JSON.stringify(disclosure)) as SelectiveDisclosure
    tampered.payment.amount = '999.0000000'

    const result = await verifyDisclosure(tampered)
    expect(result.valid).toBe(false)
    expect(result.error).toMatch(/Public inputs mismatch|Commitment hash mismatch/)
  })

  it('rejects a disclosure if the intended party was tampered with', async () => {
    const disclosure = await generateDisclosure({
      payment: samplePayment,
      intendedParty: sampleParty,
    })

    const tampered = JSON.parse(JSON.stringify(disclosure)) as SelectiveDisclosure
    tampered.intendedParty = 'IRS Tax Authority'

    const result = await verifyDisclosure(tampered)
    expect(result.valid).toBe(false)
    expect(result.error).toMatch(/Public inputs mismatch|Commitment hash mismatch/)
  })

  it('rejects a disclosure if the recipient was altered', async () => {
    const disclosure = await generateDisclosure({
      payment: samplePayment,
      intendedParty: sampleParty,
    })

    const tampered = JSON.parse(JSON.stringify(disclosure)) as SelectiveDisclosure
    tampered.payment.recipient = 'GCSOMEOTHERUNAUTHORIZEDRECIPIENTADDRESS9876543210'

    const result = await verifyDisclosure(tampered)
    expect(result.valid).toBe(false)
    expect(result.error).toMatch(/Public inputs mismatch|Commitment hash mismatch/)
  })

  it('rejects a disclosure if the txHash was modified', async () => {
    const disclosure = await generateDisclosure({
      payment: samplePayment,
      intendedParty: sampleParty,
    })

    const tampered = JSON.parse(JSON.stringify(disclosure)) as SelectiveDisclosure
    tampered.payment.txHash = 'deadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef'

    const result = await verifyDisclosure(tampered)
    expect(result.valid).toBe(false)
    expect(result.error).toMatch(/Public inputs mismatch|Commitment hash mismatch/)
  })

  it('rejects a disclosure with a non-canonical or arbitrary verifier contract ID', async () => {
    const disclosure = await generateDisclosure({
      payment: samplePayment,
      intendedParty: sampleParty,
    })

    const tampered = JSON.parse(JSON.stringify(disclosure)) as SelectiveDisclosure
    tampered.verifierContractId = 'CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA'

    const result = await verifyDisclosure(tampered)
    expect(result.valid).toBe(false)
    expect(result.error).toMatch(/Non-canonical verifier contract ID/)
  })

  it('rejects a disclosure with a non-canonical pool contract ID', async () => {
    const disclosure = await generateDisclosure({
      payment: samplePayment,
      intendedParty: sampleParty,
    })

    const tampered = JSON.parse(JSON.stringify(disclosure)) as SelectiveDisclosure
    tampered.noteScope.poolContractId = 'CBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB'

    const result = await verifyDisclosure(tampered)
    expect(result.valid).toBe(false)
    expect(result.error).toMatch(/Non-canonical SPP pool contract ID/)
  })

  it('rejects a disclosure that leaks extraneous note data (note isolation violation)', async () => {
    const disclosure = await generateDisclosure({
      payment: samplePayment,
      intendedParty: sampleParty,
    })

    const leaked = JSON.parse(JSON.stringify(disclosure))
    leaked.noteScope.otherNotes = ['note-2-commitment', 'note-3-commitment']

    const result = await verifyDisclosure(leaked)
    expect(result.valid).toBe(false)
    expect(result.error).toMatch(/Privacy violation: disclosure contains extraneous note or account data/)
  })

  it('rejects a disclosure with modified proof data', async () => {
    const disclosure = await generateDisclosure({
      payment: samplePayment,
      intendedParty: sampleParty,
    })

    const tampered = JSON.parse(JSON.stringify(disclosure)) as SelectiveDisclosure
    tampered.proof.proofData = '0x00000000000000000000000000000000'

    const result = await verifyDisclosure(tampered)
    expect(result.valid).toBe(false)
    expect(result.error).toMatch(/Proof data mismatch/)
  })

  it('round-trips link encoding and decoding', async () => {
    const disclosure = await generateDisclosure({
      payment: samplePayment,
      intendedParty: sampleParty,
    })

    const encoded = encodeDisclosureForLink(disclosure)
    const decoded = decodeDisclosureFromLink(encoded)

    expect(decoded.id).toBe(disclosure.id)
    expect(decoded.intendedParty).toBe(disclosure.intendedParty)
    expect(decoded.payment.amount).toBe(disclosure.payment.amount)
    expect(decoded.proof.commitmentHash).toBe(disclosure.proof.commitmentHash)

    const verification = await verifyDisclosure(decoded)
    expect(verification.valid).toBe(true)
  })
})
