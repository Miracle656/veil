import { TextEncoder, TextDecoder } from 'util'
Object.assign(globalThis, { TextEncoder, TextDecoder })

import {
  getMemoByteLength,
  validateMemoText,
  MAX_MEMO_TEXT_BYTES,
  MEMO_EXCEEDS_LIMIT_MESSAGE,
} from '../memo'

describe('Memo length validation (Issue #818)', () => {
  it('identifies 28 bytes as the maximum allowed limit', () => {
    expect(MAX_MEMO_TEXT_BYTES).toBe(28)
  })

  it('accepts empty or null memo', () => {
    expect(validateMemoText('')).toBeNull()
    expect(validateMemoText(null)).toBeNull()
    expect(validateMemoText(undefined)).toBeNull()
  })

  it('accepts an ASCII memo up to exactly 28 bytes', () => {
    const memo27 = 'a'.repeat(27)
    expect(getMemoByteLength(memo27)).toBe(27)
    expect(validateMemoText(memo27)).toBeNull()

    const memo28 = 'a'.repeat(28)
    expect(getMemoByteLength(memo28)).toBe(28)
    expect(validateMemoText(memo28)).toBeNull()
  })

  it('acceptance criterion: a 29-byte memo is refused with a validation message naming the limit', () => {
    const memo29 = 'a'.repeat(29)
    expect(getMemoByteLength(memo29)).toBe(29)
    expect(validateMemoText(memo29)).toBe(MEMO_EXCEEDS_LIMIT_MESSAGE)
    expect(validateMemoText(memo29)).toBe('Memo exceeds the 28-byte limit')
  })

  it('acceptance criterion: multi-byte characters are counted as bytes, not characters', () => {
    // '€' is 3 bytes in UTF-8, but only 1 character
    const euro = '€'
    expect(euro.length).toBe(1)
    expect(getMemoByteLength(euro)).toBe(3)

    // 9 euros = 9 characters, but 27 bytes (valid)
    const nineEuros = euro.repeat(9)
    expect(nineEuros.length).toBe(9)
    expect(getMemoByteLength(nineEuros)).toBe(27)
    expect(validateMemoText(nineEuros)).toBeNull()

    // 10 euros = 10 characters, but 30 bytes (exceeds 28 bytes)
    const tenEuros = euro.repeat(10)
    expect(tenEuros.length).toBe(10)
    expect(getMemoByteLength(tenEuros)).toBe(30)
    expect(validateMemoText(tenEuros)).toBe('Memo exceeds the 28-byte limit')
  })

  it('acceptance criterion: tests cover a multi-byte memo at the boundary', () => {
    // 'あ' (Japanese hiragana) is 3 bytes in UTF-8
    // 9 'あ' (27 bytes) + '!' (1 byte) = 28 bytes (boundary valid)
    const boundary28 = 'あ'.repeat(9) + '!'
    expect(getMemoByteLength(boundary28)).toBe(28)
    expect(validateMemoText(boundary28)).toBeNull()

    // 9 'あ' (27 bytes) + '!!' (2 bytes) = 29 bytes (boundary invalid)
    const boundary29 = 'あ'.repeat(9) + '!!'
    expect(getMemoByteLength(boundary29)).toBe(29)
    expect(validateMemoText(boundary29)).toBe('Memo exceeds the 28-byte limit')

    // 4-byte emoji boundary: '🚀' is 4 bytes
    // 7 emojis = 28 bytes (boundary valid)
    const sevenRockets = '🚀'.repeat(7)
    expect(getMemoByteLength(sevenRockets)).toBe(28)
    expect(validateMemoText(sevenRockets)).toBeNull()

    // 7 emojis (28 bytes) + 'a' (1 byte) = 29 bytes (boundary invalid)
    const sevenRocketsPlusOne = '🚀'.repeat(7) + 'a'
    expect(getMemoByteLength(sevenRocketsPlusOne)).toBe(29)
    expect(validateMemoText(sevenRocketsPlusOne)).toBe('Memo exceeds the 28-byte limit')
  })
})
