import { isValidStellarAddress } from '../QrScanner'

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
