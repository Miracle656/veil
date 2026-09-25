import { isValidStellarAddress, isRecognizedQrValue } from '../QrScanner'

describe('isValidStellarAddress', () => {
  it('accepts a valid G-address (56 chars)', () => {
    expect(isValidStellarAddress('G' + 'A'.repeat(55))).toBe(true)
  })

  it('accepts a valid C-address (56 chars)', () => {
    expect(isValidStellarAddress('C' + 'A'.repeat(55))).toBe(true)
  })

  it('rejects address shorter than 56 chars', () => {
    expect(isValidStellarAddress('G' + 'A'.repeat(54))).toBe(false)
  })

  it('rejects address longer than 56 chars', () => {
    expect(isValidStellarAddress('G' + 'A'.repeat(56))).toBe(false)
  })

  it('rejects address with wrong prefix', () => {
    expect(isValidStellarAddress('X' + 'A'.repeat(55))).toBe(false)
  })

  it('rejects empty string', () => {
    expect(isValidStellarAddress('')).toBe(false)
  })

  it('rejects address with leading whitespace (untrimmed)', () => {
    expect(isValidStellarAddress(' G' + 'A'.repeat(54))).toBe(false)
  })
})

describe('isRecognizedQrValue', () => {
  const G_ADDR = 'G' + 'A'.repeat(55)
  const C_ADDR = 'C' + 'A'.repeat(55)

  it('accepts bare G and C addresses', () => {
    expect(isRecognizedQrValue(G_ADDR)).toBe(true)
    expect(isRecognizedQrValue(C_ADDR)).toBe(true)
  })

  it('accepts SEP-7 pay URIs with destination, amount, and memo', () => {
    expect(
      isRecognizedQrValue(`web+stellar:pay?destination=${G_ADDR}&amount=10&memo=deposit-123`),
    ).toBe(true)
  })

  it('rejects random text or malformed URIs', () => {
    expect(isRecognizedQrValue('hello world')).toBe(false)
    expect(isRecognizedQrValue('')).toBe(false)
    expect(isRecognizedQrValue('https://evil.com')).toBe(false)
  })
})
