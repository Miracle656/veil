import { useMemo } from 'react';
import Svg, { Rect } from 'react-native-svg';

/**
 * The pixel avatar Lobstr, StellarTerm and StellarExpert all show next to an
 * address. It is not a profile picture — there is no profile, no upload and no
 * account behind it. The image is derived from the address itself, so the same
 * key always draws the same icon, in every wallet that implements this.
 *
 * That cross-app agreement is the whole point, so this follows Lobstr's
 * published algorithm exactly (Lobstrco/stellar-identicon-js, proposed as a
 * SEP): base32-decode the address, take bytes 2..16 of the raw key, colour from
 * the first of those at HSV(byte/255, 0.7, 0.8), and fill a 7×7 grid that is
 * mirrored down the middle — one bit per cell, read from the remaining bytes.
 *
 * Deliberately computed on device rather than fetched from id.lobstr.co, which
 * is the other way projects do this. That endpoint would work, but it would
 * mean sending Lobstr the address of every counterparty a Veil user transacts
 * with — building exactly the graph this wallet exists to avoid.
 *
 * Known property of the upstream spec, inherited on purpose: only the first
 * bytes are read, so two addresses sharing a prefix draw the same icon. The
 * icon is recognition, never verification — never let it stand in for checking
 * an address.
 */

const GRID = 7;
const B32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

function decodeBase32(input: string): number[] {
  const charmap: Record<string, number> = {};
  B32.split('').forEach((c, i) => { charmap[c] = i; });

  const buf: number[] = [];
  let shift = 8;
  let carry = 0;

  for (const char of input.toUpperCase()) {
    const symbol = charmap[char] & 0xff;
    shift -= 5;
    if (shift > 0) {
      carry |= symbol << shift;
    } else if (shift < 0) {
      buf.push(carry | (symbol >> -shift));
      shift += 8;
      carry = (symbol << shift) & 0xff;
    } else {
      buf.push(carry | symbol);
      shift = 8;
      carry = 0;
    }
  }
  if (shift !== 8 && carry !== 0) buf.push(carry);
  return buf;
}

function hsvToRgb(h: number, s: number, v: number): string {
  const i = Math.floor(h * 6);
  const f = h * 6 - i;
  const p = v * (1 - s);
  const q = v * (1 - f * s);
  const t = v * (1 - (1 - f) * s);
  let r = 0, g = 0, b = 0;
  switch (i % 6) {
    case 0: r = v; g = t; b = p; break;
    case 1: r = q; g = v; b = p; break;
    case 2: r = p; g = v; b = t; break;
    case 3: r = p; g = q; b = v; break;
    case 4: r = t; g = p; b = v; break;
    case 5: r = v; g = p; b = q; break;
  }
  return `rgb(${Math.round(r * 255)}, ${Math.round(g * 255)}, ${Math.round(b * 255)})`;
}

function bitAt(position: number, bytes: number[]): boolean {
  const byte = bytes[Math.floor(position / 8)];
  if (byte === undefined) return false;
  return (byte & (1 << (7 - (position % 8)))) !== 0;
}

/**
 * The grid and colour byte, without the SVG around them — exported so the
 * conformance test can compare against Lobstr's algorithm directly. Rendering
 * is not what needs pinning here; the maths is.
 */
export function __identiconForTest(address: string): { grid: boolean[][]; colorByte: number } {
  const bytes = decodeBase32(address).slice(2, 16);
  const bits = bytes.slice(1);
  const half = Math.ceil(GRID / 2);
  const grid: boolean[][] = Array.from({ length: GRID }, () => Array(GRID).fill(false));
  for (let column = 0; column < half; column++) {
    for (let row = 0; row < GRID; row++) {
      if (bitAt(column + row * half, bits)) {
        grid[row][column] = true;
        grid[row][GRID - column - 1] = true;
      }
    }
  }
  return { grid, colorByte: bytes[0] };
}

export function StellarIdenticon({ address, size = 38 }: { address: string; size?: number }) {
  const { color, cells } = useMemo(() => {
    const bytes = decodeBase32(address).slice(2, 16);
    const fill = hsvToRgb((bytes[0] ?? 0) / 255, 0.7, 0.8);
    const bits = bytes.slice(1);

    // Only the left half is read; the right is its mirror, which is what gives
    // these icons their face-like symmetry rather than looking like noise.
    const half = Math.ceil(GRID / 2);
    const on: { x: number; y: number }[] = [];
    for (let column = 0; column < half; column++) {
      for (let row = 0; row < GRID; row++) {
        if (bitAt(column + row * half, bits)) {
          on.push({ x: column, y: row });
          if (column !== GRID - column - 1) on.push({ x: GRID - column - 1, y: row });
        }
      }
    }
    return { color: fill, cells: on };
  }, [address]);

  const cell = size / GRID;

  return (
    <Svg width={size} height={size} viewBox={`0 0 ${size} ${size}`}>
      {cells.map(({ x, y }) => (
        <Rect
          key={`${x}-${y}`}
          x={x * cell}
          y={y * cell}
          width={cell}
          height={cell}
          fill={color}
        />
      ))}
    </Svg>
  );
}
