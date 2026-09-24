/**
 * Regenerate the app's icon and splash artwork from the canonical Veil mark.
 *
 * Run with:  node scripts/generate-icons.mjs
 *
 * Why this exists rather than exported artwork: every one of these images is
 * masked by the platform before a user sees it, and each mask is a different
 * shape. Android 12+ draws the splash icon inside a circle two thirds the width
 * of the canvas; adaptive launcher icons keep a 66dp circle out of a 108dp
 * canvas; several OEM skins (MIUI among them) crop notification icons round as
 * well. Art that fills its canvas gets sliced into a lens shape by all three.
 *
 * So the mark is drawn from geometry, positioned so its furthest painted pixel
 * lands inside the mask that will be applied to it, and the safe radius is
 * asserted rather than eyeballed.
 *
 * The mark itself is the same three bars as `VeilMark` in the web wallet
 * (`frontend/wallet/components/ui/VeilMark.tsx`) — keep the two in step.
 */

import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

// sharp lives in the web wallet's tree; the mobile app has no need for it at
// runtime, and this script runs by hand rather than in a build.
const require = createRequire(import.meta.url);
const sharp = require(path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../../wallet/node_modules/sharp',
));

const OUT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../assets/images');

// ── The mark ─────────────────────────────────────────────────────────────────
// Three stacked bars fading downward, on a 96×96 grid. Each is a full pill
// (height 12, radius 6), which is what keeps the corners in.
const BARS = [
  { x: 22, y: 26, w: 52 },
  { x: 28, y: 44, w: 40 },
  { x: 34, y: 62, w: 28 },
];
const BAR_H = 12;
const RADIUS = BAR_H / 2;
const GRID = 96;

/**
 * Distance from the grid's centre to the furthest painted pixel.
 *
 * Computed rather than assumed: because the bars are pills, the extreme point
 * is the end-cap arc's centre plus its radius, not the bounding box corner —
 * which buys about 8% more mark for the same mask, and is the sort of thing
 * that silently stops being true if a bar's height ever changes.
 */
function markRadius() {
  const c = GRID / 2;
  let max = 0;
  for (const b of BARS) {
    const cy = b.y + BAR_H / 2;
    for (const cx of [b.x + RADIUS, b.x + b.w - RADIUS]) {
      max = Math.max(max, Math.hypot(cx - c, cy - c) + RADIUS);
    }
  }
  return max;
}

const MARK_RADIUS = markRadius();

/**
 * An SVG of the mark, scaled so its furthest pixel sits exactly `safeRadius`
 * from the centre of a `size`×`size` canvas.
 */
function markSvg({ size, safeRadius, color, opacities, background = null }) {
  const k = safeRadius / MARK_RADIUS;
  const offset = size / 2 - (GRID / 2) * k;

  const field = background
    ? `<rect width="${size}" height="${size}" fill="${background}"/>`
    : '';

  const bars = BARS.map(
    (b, i) =>
      `<rect x="${b.x}" y="${b.y}" width="${b.w}" height="${BAR_H}" rx="${RADIUS}" ` +
      `fill="${color}" opacity="${opacities[i]}"/>`,
  ).join('');

  return Buffer.from(
    `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}">` +
      field +
      `<g transform="translate(${offset} ${offset}) scale(${k})">${bars}</g>` +
      `</svg>`,
  );
}

// ── What each platform will do to the image ──────────────────────────────────
// `safe` is expressed as a fraction of the canvas width. A little margin is
// left under each documented limit, because the masks are nominal and OEM skins
// are not always exact about them.
const TARGETS = [
  {
    file: 'splash-icon-light.png',
    size: 1152,
    safe: 0.3125, // Android 12+ splash: 1/3, kept just inside
    // A darker gold than the brand value: #FDDA24 on white is barely a colour,
    // and the two faded bars disappear entirely. The fade still reads as a
    // fade, it just starts from somewhere legible.
    color: '#C4A800',
    opacities: [1, 0.58, 0.32],
    note: 'Android 12+ splash, light scheme',
  },
  {
    file: 'splash-icon-dark.png',
    size: 1152,
    safe: 0.3125,
    color: '#FDDA24',
    opacities: [1, 0.5, 0.22],
    note: 'Android 12+ splash, dark scheme',
  },
  {
    file: 'android-icon-foreground.png',
    size: 1024,
    safe: 0.28, // adaptive icon: 66/108 diameter = 0.3055 radius
    color: '#FDDA24',
    opacities: [1, 0.5, 0.22],
    background: '#0F0F0F',
    note: 'Adaptive launcher icon foreground',
  },
  {
    file: 'icon.png',
    size: 1024,
    // iOS masks to a rounded rectangle rather than a circle, so the mark has
    // more room here than in any of the Android slots and should use it — a
    // home-screen icon that hedges for a mask it will never meet just looks
    // small next to its neighbours.
    safe: 0.36,
    color: '#FDDA24',
    opacities: [1, 0.5, 0.22],
    // Opaque: iOS rejects an app icon with an alpha channel.
    background: '#0F0F0F',
    note: 'iOS / general app icon',
  },
  {
    file: 'android-icon-monochrome.png',
    size: 1024,
    safe: 0.28,
    // Android 13+ themed icons keep only the alpha channel and repaint it in
    // the user's wallpaper colours, so — as with the notification icon — the
    // fade cannot survive and flat white is the honest source.
    color: '#FFFFFF',
    opacities: [1, 1, 1],
    note: 'Adaptive icon, themed (Android 13+; alpha only)',
  },
  {
    file: 'notification-icon.png',
    size: 452,
    safe: 0.3125,
    // Android tints notification small icons wholesale: only the alpha channel
    // survives, so the colour must be flat white and the fade has to go. Three
    // bars at three opacities become three bars at one opacity — the shape is
    // what identifies it here, not the gradient.
    color: '#FFFFFF',
    opacities: [1, 1, 1],
    note: 'Android status-bar icon (tinted; alpha only)',
  },
];

for (const t of TARGETS) {
  const safeRadius = t.size * t.safe;
  const svg = markSvg({
    size: t.size,
    safeRadius,
    color: t.color,
    opacities: t.opacities,
    background: t.background,
  });

  await sharp(svg).png({ compressionLevel: 9 }).toFile(path.join(OUT, t.file));

  console.log(
    `${t.file.padEnd(30)} ${t.size}×${t.size}  ` +
      `mark r=${safeRadius.toFixed(0)}px (${(t.safe * 100).toFixed(1)}% of canvas)  — ${t.note}`,
  );
}
