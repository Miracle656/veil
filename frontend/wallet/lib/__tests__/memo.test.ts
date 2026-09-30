import { TextEncoder } from 'util'
Object.assign(globalThis, { TextEncoder })

import { MEMO_MAX_BYTES, memoByteLength, memoError } from '../memo'



describe('memo byte limit', () => {
  it('allows a memo of exactly 28 bytes and refuses 29', () => {
    expect(memoError('a'.repeat(28))).toBeNull();
    const message = memoError('a'.repeat(29));
    expect(message).toContain('29 bytes');
    expect(message).toContain('limit is 28 bytes');
  });

  it('counts bytes, not characters', () => {
    // 14 x "é" = 14 characters but 28 bytes: fits. 15 = 30 bytes: does not.
    expect(memoByteLength('é'.repeat(14))).toBe(28);
    expect(memoError('é'.repeat(14))).toBeNull();
    expect(memoError('é'.repeat(15))).toContain('30 bytes');
    // 7 x a 4-byte emoji = 28 bytes (14 UTF-16 units): fits; 8 = 32 bytes: does not.
    expect(memoError('😀'.repeat(7))).toBeNull();
    expect(memoError('😀'.repeat(8))).toContain('32 bytes');
    // 28 characters that are over the limit in bytes.
    expect('é'.repeat(28)).toHaveLength(28);
    expect(memoError('é'.repeat(28))).not.toBeNull();
  });

  it('treats a blank or missing memo as fine and ignores surrounding whitespace', () => {
    expect(memoError(undefined)).toBeNull();
    expect(memoError(null)).toBeNull();
    expect(memoError('   ')).toBeNull();
    expect(memoError(`  ${'a'.repeat(28)}  `)).toBeNull();
  });

  it('uses the Stellar limit', () => {
    expect(MEMO_MAX_BYTES).toBe(28);
  });
});
