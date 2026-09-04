/**
 * Every one of these images is masked by the platform before anyone sees it,
 * and art that fills its canvas comes back sliced into a lens shape. This
 * asserts each asset's furthest painted pixel lands inside the mask that will
 * be applied to it.
 *
 * It reads the PNGs directly rather than trusting the generator, because the
 * failure this guards against is someone dropping in an exported file by hand.
 * Regenerate with `node scripts/generate-icons.mjs`.
 */

import { readFileSync } from 'fs';
import { inflateSync } from 'zlib';
import { join } from 'path';

const IMAGES = join(__dirname, '..', 'assets', 'images');

type Png = { width: number; height: number; channels: number; pixels: Buffer };

/** Minimal PNG reader: 8-bit RGBA/RGB only, which is all these assets are. */
function readPng(file: string): Png {
  const buf = readFileSync(join(IMAGES, file));
  let offset = 8;
  let width = 0;
  let height = 0;
  let colorType = 0;
  const idat: Buffer[] = [];

  while (offset < buf.length) {
    const length = buf.readUInt32BE(offset);
    const type = buf.subarray(offset + 4, offset + 8).toString('ascii');
    const data = buf.subarray(offset + 8, offset + 8 + length);

    if (type === 'IHDR') {
      width = data.readUInt32BE(0);
      height = data.readUInt32BE(4);
      const bitDepth = data.readUInt8(8);
      colorType = data.readUInt8(9);
      if (bitDepth !== 8) throw new Error(`${file}: expected 8-bit, got ${bitDepth}`);
    } else if (type === 'IDAT') {
      idat.push(data);
    } else if (type === 'IEND') {
      break;
    }
    offset += 12 + length;
  }

  const channels = { 0: 1, 2: 3, 4: 2, 6: 4 }[colorType as 0 | 2 | 4 | 6];
  if (!channels) throw new Error(`${file}: unsupported colour type ${colorType}`);

  const raw = inflateSync(Buffer.concat(idat));
  const stride = width * channels;
  const pixels = Buffer.alloc(stride * height);
  let prev = Buffer.alloc(stride);
  let at = 0;

  // Undo the per-scanline filters (PNG spec §9).
  for (let y = 0; y < height; y++) {
    const filter = raw[at++];
    const line = Buffer.from(raw.subarray(at, at + stride));
    at += stride;

    for (let x = 0; x < stride; x++) {
      const a = x >= channels ? line[x - channels] : 0;
      const b = prev[x];
      const c = x >= channels ? prev[x - channels] : 0;
      if (filter === 1) line[x] = (line[x] + a) & 0xff;
      else if (filter === 2) line[x] = (line[x] + b) & 0xff;
      else if (filter === 3) line[x] = (line[x] + ((a + b) >> 1)) & 0xff;
      else if (filter === 4) {
        const p = a + b - c;
        const pa = Math.abs(p - a);
        const pb = Math.abs(p - b);
        const pc = Math.abs(p - c);
        line[x] = (line[x] + (pa <= pb && pa <= pc ? a : pb <= pc ? b : c)) & 0xff;
      }
    }

    line.copy(pixels, y * stride);
    prev = line;
  }

  return { width, height, channels, pixels };
}

/**
 * Distance from the canvas centre to the furthest pixel matching `visible`,
 * as a fraction of the canvas width.
 */
function contentRadius(png: Png, visible: (r: number, g: number, b: number, a: number) => boolean) {
  const { width, height, channels, pixels } = png;
  const cx = width / 2;
  const cy = height / 2;
  let max = 0;

  for (let y = 0; y < height; y++) {
    const row = y * width * channels;
    for (let x = 0; x < width; x++) {
      const o = row + x * channels;
      const a = channels === 4 ? pixels[o + 3] : 255;
      if (visible(pixels[o], pixels[o + 1], pixels[o + 2], a)) {
        const d = Math.hypot(x - cx, y - cy);
        if (d > max) max = d;
      }
    }
  }

  return max / width;
}

/** Anything not fully transparent is painted. */
const painted = (_r: number, _g: number, _b: number, a: number) => a > 8;

/**
 * The gold mark, as distinct from the opaque field behind it. Red high and
 * clearly above blue separates gold from the near-black ground at every one of
 * the mark's three opacities.
 */
const goldMark = (r: number, _g: number, b: number, a: number) => a > 128 && r > 90 && r > b + 40;

describe('icon and splash artwork survives its platform mask', () => {
  // Radii are fractions of the canvas width. Android 12+ splash icons and
  // several OEM notification skins mask to a circle 2/3 the canvas wide;
  // adaptive icons keep a 66dp circle out of 108dp.
  const CIRCLE = 1 / 3;
  const ADAPTIVE = 66 / 108 / 2;

  it.each([
    ['splash-icon-light.png', CIRCLE],
    ['splash-icon-dark.png', CIRCLE],
    ['notification-icon.png', CIRCLE],
  ])('%s fits inside its circular mask', (file, safe) => {
    expect(contentRadius(readPng(file), painted)).toBeLessThanOrEqual(safe);
  });

  it.each([['android-icon-foreground.png'], ['android-icon-monochrome.png']])(
    "%s keeps the mark inside the adaptive icon's safe circle",
    (file) => {
      const png = readPng(file);
      // The foreground carries an opaque field that is *meant* to be cropped,
      // so the mark is what has to fit — measured by colour, not by alpha.
      const visible = file.includes('monochrome') ? painted : goldMark;
      expect(contentRadius(png, visible)).toBeLessThanOrEqual(ADAPTIVE);
    },
  );

  it('icon.png is opaque, because iOS rejects an app icon with alpha', () => {
    const { pixels, channels } = readPng('icon.png');
    if (channels < 4) return; // no alpha channel at all is equally fine
    for (let o = 3; o < pixels.length; o += channels) {
      if (pixels[o] !== 255) throw new Error('icon.png has transparent pixels');
    }
  });

  it('the tinted icons are flat white, since only their alpha survives', () => {
    for (const file of ['notification-icon.png', 'android-icon-monochrome.png']) {
      const { pixels, channels } = readPng(file);
      for (let o = 0; o < pixels.length; o += channels) {
        if (pixels[o + 3] > 8) {
          expect([pixels[o], pixels[o + 1], pixels[o + 2]]).toEqual([255, 255, 255]);
        }
      }
    }
  });
});
