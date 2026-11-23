/**
 * The pixel picture shown next to a Stellar address, the same one Lobstr,
 * StellarExpert and the Veil phone app draw. It is worked out from the address
 * itself, so one address always gets one picture, in every app.
 *
 * Follows Lobstr's published algorithm (Lobstrco/stellar-identicon-js):
 * base32-decode the address, take bytes 2..16, colour from the first at
 * HSV(byte/255, 0.7, 0.8), and fill a 7×7 grid mirrored down the middle, one
 * bit per cell. Kept in step with frontend/mobile/components/StellarIdenticon.tsx.
 *
 * Worked out in the browser, never fetched: asking a service for the picture
 * would tell it every address this wallet deals with.
 *
 * The picture helps you recognise an address. It does not prove one: only the
 * first bytes are read, so two addresses can share a picture.
 */

export const IDENTICON_GRID = 7
const B32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567'

function decodeBase32(input: string): number[] {
  const buf: number[] = []
  let shift = 8
  let carry = 0
  for (const char of input.toUpperCase()) {
    const index = B32.indexOf(char)
    const symbol = (index < 0 ? 0 : index) & 0xff
    shift -= 5
    if (shift > 0) {
      carry |= symbol << shift
    } else if (shift < 0) {
      buf.push(carry | (symbol >> -shift))
      shift += 8
      carry = (symbol << shift) & 0xff
    } else {
      buf.push(carry | symbol)
      shift = 8
      carry = 0
    }
  }
  if (shift !== 8 && carry !== 0) buf.push(carry)
  return buf
}

function hsvToRgb(h: number, s: number, v: number): string {
  const i = Math.floor(h * 6)
  const f = h * 6 - i
  const p = v * (1 - s)
  const q = v * (1 - f * s)
  const t = v * (1 - (1 - f) * s)
  let r = 0, g = 0, b = 0
  switch (i % 6) {
    case 0: r = v; g = t; b = p; break
    case 1: r = q; g = v; b = p; break
    case 2: r = p; g = v; b = t; break
    case 3: r = p; g = q; b = v; break
    case 4: r = t; g = p; b = v; break
    case 5: r = v; g = p; b = q; break
  }
  return `rgb(${Math.round(r * 255)}, ${Math.round(g * 255)}, ${Math.round(b * 255)})`
}

function bitAt(position: number, bytes: number[]): boolean {
  const byte = bytes[Math.floor(position / 8)]
  if (byte === undefined) return false
  return (byte & (1 << (7 - (position % 8)))) !== 0
}

/** True for something shaped like a Stellar account (G…) or contract (C…). */
export function hasIdenticon(value: string | null | undefined): value is string {
  return !!value && /^[GC][A-Z2-7]{55}$/.test(value)
}

export type Identicon = { color: string; cells: { x: number; y: number }[] }

export function identiconFor(address: string): Identicon {
  const bytes = decodeBase32(address).slice(2, 16)
  const bits = bytes.slice(1)
  const half = Math.ceil(IDENTICON_GRID / 2)
  const cells: { x: number; y: number }[] = []
  for (let column = 0; column < half; column++) {
    for (let row = 0; row < IDENTICON_GRID; row++) {
      if (!bitAt(column + row * half, bits)) continue
      cells.push({ x: column, y: row })
      const mirror = IDENTICON_GRID - column - 1
      if (mirror !== column) cells.push({ x: mirror, y: row })
    }
  }
  return { color: hsvToRgb((bytes[0] ?? 0) / 255, 0.7, 0.8), cells }
}
