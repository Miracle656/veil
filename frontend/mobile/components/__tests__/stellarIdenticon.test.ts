/**
 * Pins our identicon output to Lobstr's published algorithm
 * (Lobstrco/stellar-identicon-js), which StellarExpert and StellarTerm also
 * implement. The value of these icons is that the same address draws the same
 * picture everywhere — an icon that is merely deterministic *for us* is worth
 * very little, so drift here is a real regression rather than a cosmetic one.
 *
 * The reference implementation is transcribed below rather than imported: the
 * upstream package renders to a browser <canvas>, which does not exist under
 * jest, and pulling it in would test the mock rather than the maths.
 */
import { __identiconForTest } from '../StellarIdenticon';

const B32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

function refDecodeBase32(input: string): number[] {
  const charmap: Record<string, number> = {};
  B32.split('').forEach((c, i) => { charmap[c] = i; });
  const buf: number[] = [];
  let shift = 8;
  let carry = 0;
  input.toUpperCase().split('').forEach((char) => {
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
  });
  if (shift !== 8 && carry !== 0) buf.push(carry);
  return buf;
}

function refMatrix(address: string): { grid: boolean[][]; colorByte: number } {
  const bytes = refDecodeBase32(address).slice(2, 16);
  const size = 7;
  const grid: boolean[][] = Array.from({ length: size }, () => Array(size).fill(false));
  const cols = Math.ceil(size / 2);
  const bits = bytes.slice(1);
  const getBit = (position: number) =>
    (bits[Math.floor(position / 8)] & (1 << (7 - (position % 8)))) !== 0;

  for (let column = 0; column < cols; column++) {
    for (let row = 0; row < size; row++) {
      if (getBit(column + row * cols)) {
        grid[row][column] = true;
        grid[row][size - column - 1] = true;
      }
    }
  }
  return { grid, colorByte: bytes[0] };
}

const ADDRESSES = [
  'GAE6BEVEA6IH4HLTGU3AEGZZWSLNCCWLKD4GLN2XHLXFFNFB24COWUJY',
  'GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN',
  'GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5',
  // A contract address — these appear as counterparties on swaps, and the
  // algorithm has to survive the different version byte.
  'CDLJHWWXBP7YCC5A57DTQXVBMTFHFWJCVMGCQHJPYSHTLPJJ7YWXRFR6',
];

describe('StellarIdenticon', () => {
  it.each(ADDRESSES)('matches the reference implementation for %s', (address) => {
    const mine = __identiconForTest(address);
    const ref = refMatrix(address);

    expect(mine.grid).toEqual(ref.grid);
    expect(mine.colorByte).toBe(ref.colorByte);
  });

  it('is symmetric down the middle', () => {
    const { grid } = __identiconForTest(ADDRESSES[0]);
    for (const row of grid) {
      for (let c = 0; c < 3; c++) expect(row[c]).toBe(row[6 - c]);
    }
  });

  it('gives different addresses different icons', () => {
    const a = __identiconForTest(ADDRESSES[0]);
    const b = __identiconForTest(ADDRESSES[1]);
    expect(a.grid).not.toEqual(b.grid);
  });

  it('does not throw on a malformed address', () => {
    // Counterparties arrive from an indexer, so this must degrade rather than
    // take the whole activity feed down with it.
    expect(() => __identiconForTest('')).not.toThrow();
    expect(() => __identiconForTest('not-an-address')).not.toThrow();
  });
});
