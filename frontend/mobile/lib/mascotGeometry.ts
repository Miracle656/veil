/**
 * The Veil mascot's geometry — the one place its shape is defined.
 *
 * The figure descends from the Drape (the web wallet's
 * `components/ui/VeilMark.tsx`, mobile's `components/VeilLogo.tsx`): three bars
 * of width 52, 40 and 28, centred on x=48, at y=26, 44 and 62. Their outer
 * corners sit at (22,32) (74,32) · (28,50) (68,50) · (34,68) (62,68), and the
 * figure's falling edge runs straight through all three — half-width 26, 20,
 * 14. The mark sets the taper; none of it was invented.
 *
 * `frontend/wallet/lib/mascotGeometry.ts` and `frontend/mobile/lib/
 * mascotGeometry.ts` are the same file and must stay byte-identical;
 * `mascotParity.test.ts` fails when they drift, for the same reason the asset
 * registry has a parity test: a mark that differs between the two clients is
 * two marks.
 *
 * Direction and the cultural caution behind it: `docs/BRAND_MASCOT.md`.
 */

/**
 * The cloth.
 *
 * A first version joined the bar corners and domed straight over the top. It
 * read as a lightbulb — worth recording, because the geometry was not wrong: a
 * single convex curve simply is not fabric, whatever it is derived from. Two
 * changes fixed it, and both are load-bearing.
 *
 * **The widest point is the shoulder, not the head.** The crown is 28 across,
 * the same as the hem, and the cloth spreads out from it to the mark's full 52
 * at y=32. A figure whose head is its widest part is a bulb.
 *
 * **The hem is uneven.** Three scallops rather than one smooth belly. A smooth
 * edge reads as a solid object; a broken one reads as cloth hanging.
 */
export const MASCOT_BODY =
  'M22 32C22 28 28 25 34 23C34 13 40 8 48 8C56 8 62 13 62 23C68 25 74 28 74 32' +
  'L62 68Q57.5 76 53 68.5Q48.5 76 43.5 68.5Q39 76 34 68Z';

/**
 * The seams, for the detailed rendering.
 *
 * Each band runs the full width of the box and is clipped to {@link
 * MASCOT_BODY}, so their union is exactly the silhouette: the detailed figure
 * cannot grow a different outline from the plain one, however the seams are
 * redrawn. Scalloped like the hem, because every edge in the figure should be
 * cloth falling.
 *
 * The opacities are the mark's own 1.0 / 0.5 / 0.22 — this is the three bars,
 * read as three falls of cloth rather than three stripes.
 */
export const MASCOT_BANDS: readonly { d: string; opacity: number }[] = [
  { d: 'M0 0H96V45Q84 52 72 45Q60 52 48 45Q36 52 24 45Q12 52 0 45Z', opacity: 1 },
  { d: 'M0 43H96V61Q84 68 72 61Q60 68 48 61Q36 68 24 61Q12 68 0 61Z', opacity: 0.5 },
  { d: 'M0 59H96V96H0Z', opacity: 0.22 },
];

/** Where the cloth is opened. Never features drawn on — see the doc. */
export type MascotAperture = 'none' | 'slits' | 'slot' | 'woven';

export const MASCOT_APERTURES: readonly MascotAperture[] = ['none', 'slits', 'slot', 'woven'];

/**
 * One horizontal opening with rounded ends, as a path to subtract.
 *
 * Expressed as its own subpath rather than a separate element so the whole
 * figure stays a single `<path>` with `fill-rule="evenodd"`: one shape, one
 * fill, and the opening is genuinely absent rather than painted over in the
 * background colour — which would break the moment the figure sat on anything
 * but `#0F0F0F`.
 */
function opening(x: number, width: number, y: number, height: number): string {
  const r = height / 2;
  return `M${x} ${y}h${width}a${r} ${r} 0 0 1 0 ${height}h-${width}a${r} ${r} 0 0 1 0 -${height}Z`;
}

/**
 * The subpaths that open the cloth for `aperture`, or '' for none.
 *
 * Placed against the hooded crown, which is 28 across at its base and narrower
 * above — considerably less room than the first round's bulb had, so these are
 * smaller and sit lower on the head.
 */
export function aperturePath(aperture: MascotAperture): string {
  switch (aperture) {
    case 'slits':
      return opening(39, 6, 17, 3.5) + opening(51, 6, 17, 3.5);
    case 'slot':
      return opening(38, 20, 17, 3.5);
    case 'woven':
      // Three bands, the way a masquerade panel is actually woven open.
      return opening(40, 16, 13, 2.5) + opening(37, 22, 18, 2.5) + opening(36, 24, 23, 2.5);
    case 'none':
    default:
      return '';
  }
}

/** The complete outline: cloth, less whatever the aperture removes. */
export function mascotPath(aperture: MascotAperture = 'none'): string {
  return MASCOT_BODY + aperturePath(aperture);
}

/**
 * Above this, the seams are drawn; below it, the figure is one solid shape.
 *
 * The direction asks for silhouette first, with details earning their place
 * only above about 64px, and the first round found out why the hard way: the
 * mark's fade to 0.22 at the hem is invisible at header size, so a faded figure
 * reads shorter and rounder than a solid one. A mark that changes shape with
 * its size is not a mark. Seams have the same problem and the same answer —
 * they appear when there is room for them to mean something.
 */
export const MASCOT_LAYERED_FROM = 64;

export function isLayered(size: number): boolean {
  return size >= MASCOT_LAYERED_FROM;
}
