import { webcrypto } from 'crypto'
import { TextEncoder, TextDecoder } from 'util'
Object.defineProperty(globalThis, 'crypto', { value: webcrypto, configurable: true, writable: true })
Object.assign(globalThis, { TextEncoder, TextDecoder })

import { lpToStroops, stroopsToLp } from '../backstop'

describe('lpToStroops', () => {
  it('converts amounts', () => {
    expect(lpToStroops('1')).toBe(10000000n)
    expect(lpToStroops('0.1')).toBe(1000000n)
  })
  it('refuses invalid', () => {
    expect(() => lpToStroops('0')).toThrow()
    expect(() => lpToStroops('1.00000001')).toThrow()
  })
})

describe('stroopsToLp', () => {
  it('formats', () => {
    expect(stroopsToLp(10000000n)).toBe('1')
    expect(stroopsToLp(1n)).toBe('0.0000001')
  })
})
