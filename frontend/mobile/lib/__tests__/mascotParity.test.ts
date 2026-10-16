import { readFileSync } from 'fs';
import { join } from 'path';

import { MASCOT_BODY, MASCOT_LAYERED_FROM, isLayered } from '../mascotGeometry';

/**
 * The mascot's geometry must be the same file on both clients.
 *
 * `frontend/mobile/lib/mascotGeometry.ts` is a copy of
 * `frontend/wallet/lib/mascotGeometry.ts`. A mark that differs between the two
 * clients is two marks, and the whole argument for this figure is that it is
 * the Drape's own outline — a taper edited on one side only quietly stops being
 * that.
 *
 * Compared as text rather than by importing both, because the file is pure
 * constants with no imports: byte-identity is the property, and a reformat on
 * one side is exactly the drift worth catching.
 *
 * If this fails, you edited one copy alone. Make the same change in both. Do
 * not "fix" it here.
 */

const MOBILE = join(__dirname, '..', 'mascotGeometry.ts');
const WALLET = join(__dirname, '..', '..', '..', 'wallet', 'lib', 'mascotGeometry.ts');

describe('mascot geometry parity', () => {
  it('is byte-identical on both clients', () => {
    const mobile = readFileSync(MOBILE, 'utf8');
    const wallet = readFileSync(WALLET, 'utf8');

    if (mobile !== wallet) {
      // Name the first line that differs: a whole-file diff in the output is
      // unreadable, and the line number is what you need to go and fix.
      const m = mobile.split('\n');
      const w = wallet.split('\n');
      const at = m.findIndex((line, i) => line !== w[i]);
      throw new Error(
        `mascotGeometry.ts differs at line ${at + 1}:\n` +
          `  mobile: ${JSON.stringify(m[at] ?? '<end of file>')}\n` +
          `  wallet: ${JSON.stringify(w[at] ?? '<end of file>')}`,
      );
    }

    expect(mobile).toBe(wallet);
  });

  it('still draws the taper off the mark, on this side', () => {
    // Cheap guard that the copy is the real module and not an empty stub. The
    // shoulders sit at y=32 — the mark's own top-bar corner — and the crown is
    // narrower than them, which is what stops the figure reading as a bulb.
    expect(MASCOT_BODY).toContain('M22 32');
    expect(MASCOT_BODY).toContain('L62 68');
    expect(MASCOT_BODY).toContain('C34 13 40 8 48 8');
    expect(MASCOT_LAYERED_FROM).toBe(64);
    expect(isLayered(22)).toBe(false);
  });
});
