import { TextEncoder, TextDecoder } from 'util'
Object.assign(globalThis, { TextEncoder, TextDecoder })

import { parseSep7Uri, buildSep7Memo, buildSep7PayUri } from '../sep7'

const PUBLIC_KEY = 'GA3DHM4WL2VXPHR7NQKPZ7XK9FQJ2ULTQ6ZT4W2M5N6Q7RSTUVWXK9FQ'
const HASH_HEX = 'a1b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d4e5f60718293a4b5c6d7e8f90'
const HASH_BASE64 = Buffer.from(HASH_HEX, 'hex').toString('base64')

describe('SEP-7 memo_type handling (Issue #817)', () => {
  describe('acceptance criterion: MEMO_TEXT, MEMO_ID, MEMO_HASH, and MEMO_RETURN each produce the right memo', () => {
    it('MEMO_TEXT produces a text memo', () => {
      const uri = `web+stellar:pay?destination=${PUBLIC_KEY}&memo=hello+world&memo_type=MEMO_TEXT`
      const parsed = parseSep7Uri(uri)
      expect(parsed).not.toBeNull()
      expect(parsed!.memo).toBe('hello world')
      expect(parsed!.memoType).toBe('MEMO_TEXT')

      const memo = buildSep7Memo(parsed!.memo!, parsed!.memoType)
      expect(memo.type).toBe('text')
      expect(memo.value).toBe('hello world')
    })

    it('MEMO_ID produces an id memo', () => {
      const uri = `web+stellar:pay?destination=${PUBLIC_KEY}&memo=123456789&memo_type=MEMO_ID`
      const parsed = parseSep7Uri(uri)
      expect(parsed).not.toBeNull()
      expect(parsed!.memo).toBe('123456789')
      expect(parsed!.memoType).toBe('MEMO_ID')

      const memo = buildSep7Memo(parsed!.memo!, parsed!.memoType)
      expect(memo.type).toBe('id')
      expect(memo.value).toBe('123456789')
    })

    it('MEMO_HASH produces a hash memo (hex)', () => {
      const uri = `web+stellar:pay?destination=${PUBLIC_KEY}&memo=${HASH_HEX}&memo_type=MEMO_HASH`
      const parsed = parseSep7Uri(uri)
      expect(parsed).not.toBeNull()
      expect(parsed!.memo).toBe(HASH_HEX)
      expect(parsed!.memoType).toBe('MEMO_HASH')

      const memo = buildSep7Memo(parsed!.memo!, parsed!.memoType)
      expect(memo.type).toBe('hash')
      expect(Buffer.from(memo.value as Buffer).toString('hex')).toBe(HASH_HEX)
    })

    it('MEMO_HASH produces a hash memo (base64)', () => {
      const uri = `web+stellar:pay?destination=${PUBLIC_KEY}&memo=${encodeURIComponent(HASH_BASE64)}&memo_type=MEMO_HASH`
      const parsed = parseSep7Uri(uri)
      expect(parsed).not.toBeNull()
      expect(parsed!.memoType).toBe('MEMO_HASH')

      const memo = buildSep7Memo(parsed!.memo!, parsed!.memoType)
      expect(memo.type).toBe('hash')
      expect(Buffer.from(memo.value as Buffer).toString('hex')).toBe(HASH_HEX)
    })

    it('MEMO_RETURN produces a return memo (hex)', () => {
      const uri = `web+stellar:pay?destination=${PUBLIC_KEY}&memo=${HASH_HEX}&memo_type=MEMO_RETURN`
      const parsed = parseSep7Uri(uri)
      expect(parsed).not.toBeNull()
      expect(parsed!.memo).toBe(HASH_HEX)
      expect(parsed!.memoType).toBe('MEMO_RETURN')

      const memo = buildSep7Memo(parsed!.memo!, parsed!.memoType)
      expect(memo.type).toBe('return')
      expect(Buffer.from(memo.value as Buffer).toString('hex')).toBe(HASH_HEX)
    })

    it('MEMO_RETURN produces a return memo (base64)', () => {
      const uri = `web+stellar:pay?destination=${PUBLIC_KEY}&memo=${encodeURIComponent(HASH_BASE64)}&memo_type=MEMO_RETURN`
      const parsed = parseSep7Uri(uri)
      expect(parsed).not.toBeNull()
      expect(parsed!.memoType).toBe('MEMO_RETURN')

      const memo = buildSep7Memo(parsed!.memo!, parsed!.memoType)
      expect(memo.type).toBe('return')
      expect(Buffer.from(memo.value as Buffer).toString('hex')).toBe(HASH_HEX)
    })
  })

  describe('acceptance criterion: an unknown memo_type is refused with a message naming it', () => {
    it('refuses an unknown memo_type in parseSep7Uri with message naming it', () => {
      const uri = `web+stellar:pay?destination=${PUBLIC_KEY}&memo=123&memo_type=MEMO_UNKNOWN_TYPE`
      expect(() => parseSep7Uri(uri)).toThrow('Unknown memo_type: "MEMO_UNKNOWN_TYPE"')
    })

    it('refuses an unknown memo_type in buildSep7Memo with message naming it', () => {
      expect(() => buildSep7Memo('123', 'INVALID_TYPE')).toThrow('Unknown memo_type: "INVALID_TYPE"')
    })

    it('refuses malformed memo values for typed memos rather than guessing', () => {
      // Non-integer MEMO_ID
      const uriId = `web+stellar:pay?destination=${PUBLIC_KEY}&memo=not-a-number&memo_type=MEMO_ID`
      expect(() => parseSep7Uri(uriId)).toThrow(/Invalid MEMO_ID/)

      // Non-32-byte MEMO_HASH
      const uriHash = `web+stellar:pay?destination=${PUBLIC_KEY}&memo=tooshort&memo_type=MEMO_HASH`
      expect(() => parseSep7Uri(uriHash)).toThrow(/Invalid MEMO_HASH/)
    })
  })

  describe('acceptance criterion: a link with memo and no memo_type behaves as today', () => {
    it('defaults to text memo when memo_type is absent', () => {
      const uri = `web+stellar:pay?destination=${PUBLIC_KEY}&memo=deposit-ref-123`
      const parsed = parseSep7Uri(uri)
      expect(parsed).not.toBeNull()
      expect(parsed!.memo).toBe('deposit-ref-123')
      expect(parsed!.memoType).toBeUndefined()

      const memo = buildSep7Memo(parsed!.memo!, parsed!.memoType)
      expect(memo.type).toBe('text')
      expect(memo.value).toBe('deposit-ref-123')
    })
  })

  describe('round-trip buildSep7PayUri with memo_type', () => {
    it('includes memo_type in built URI', () => {
      const uri = buildSep7PayUri({
        destination: PUBLIC_KEY,
        memo: '123456',
        memoType: 'MEMO_ID',
      })
      expect(uri).toContain('memo_type=MEMO_ID')
      const parsed = parseSep7Uri(uri)
      expect(parsed?.memoType).toBe('MEMO_ID')
    })
  })
})
