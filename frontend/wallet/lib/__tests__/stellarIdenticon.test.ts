import { IDENTICON_GRID, hasIdenticon, identiconFor } from '../stellarIdenticon'

// Address-shaped placeholders (56 base32 characters). Not real accounts.
const A = 'G' + 'BZXQ7MK2'.repeat(6) + 'ABCDEFG'
const B = 'C' + 'Q5T3NHWL'.repeat(6) + 'ZYXWVUT'

/** Lobstr's published algorithm, written out again so the two can be compared. */
function reference(address: string): { grid: boolean[][]; colorByte: number } {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567'
  const buf: number[] = []
  let shift = 8
  let carry = 0
  for (const char of address) {
    const symbol = alphabet.indexOf(char) & 0xff
    shift -= 5
    if (shift > 0) carry |= symbol << shift
    else if (shift < 0) { buf.push(carry | (symbol >> -shift)); shift += 8; carry = (symbol << shift) & 0xff }
    else { buf.push(carry | symbol); shift = 8; carry = 0 }
  }
  const bytes = buf.slice(2, 16)
  const bits = bytes.slice(1)
  const cols = Math.ceil(IDENTICON_GRID / 2)
  const grid = Array.from({ length: IDENTICON_GRID }, () => Array<boolean>(IDENTICON_GRID).fill(false))
  for (let column = 0; column < cols; column++) {
    for (let r = 0; r < IDENTICON_GRID; r++) {
      const position = column + r * cols
      if ((bits[Math.floor(position / 8)] & (1 << (7 - (position % 8)))) !== 0) {
        grid[r][column] = true
        grid[r][IDENTICON_GRID - column - 1] = true
      }
    }
  }
  return { grid, colorByte: bytes[0] }
}

function gridOf(address: string): boolean[][] {
  const grid = Array.from({ length: IDENTICON_GRID }, () => Array<boolean>(IDENTICON_GRID).fill(false))
  for (const { x, y } of identiconFor(address).cells) grid[y][x] = true
  return grid
}

describe('the address picture', () => {
  it.each([A, B])('matches the published algorithm for %s', (address) => {
    expect(gridOf(address)).toEqual(reference(address).grid)
  })

  it('is the same every time, and differs between addresses', () => {
    expect(identiconFor(A)).toEqual(identiconFor(A))
    expect(gridOf(A)).not.toEqual(gridOf(B))
  })

  it('is mirrored left to right and lists no cell twice', () => {
    const grid = gridOf(A)
    for (const r of grid) expect(r).toEqual([...r].reverse())
    const keys = identiconFor(A).cells.map(({ x, y }) => `${x}-${y}`)
    expect(new Set(keys).size).toBe(keys.length)
  })

  it('gives a colour', () => {
    expect(identiconFor(A).color).toMatch(/^rgb\(\d+, \d+, \d+\)$/)
  })

  it('is only drawn for something shaped like an address', () => {
    expect(hasIdenticon(A)).toBe(true)
    expect(hasIdenticon(B)).toBe(true)
    expect(hasIdenticon('Stellar DEX')).toBe(false)
    expect(hasIdenticon('unknown')).toBe(false)
    expect(hasIdenticon('')).toBe(false)
    expect(hasIdenticon(null)).toBe(false)
    expect(hasIdenticon(A.slice(0, 55))).toBe(false)
  })
})
