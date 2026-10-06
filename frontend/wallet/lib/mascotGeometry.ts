/**
 * The Veil mascot's geometry — the one place its shape is defined.
 *
 * The figure is not designed alongside the mark; it IS the mark's outline. The
 * Drape (the web wallet's `components/ui/VeilMark.tsx`, mobile's
 * `components/VeilLogo.tsx`) is three bars of width 52, 40 and 28, centred on
 * x=48, at y=26, 44 and 62. Their outer corners therefore sit at (22,32)
 * (74,32) · (28,50) (68,50) · (34,68) (62,68), and joining those six points
 * gives a taper nobody had to invent. Doming the top and closing with a hem
 * turns the stack into a hanging figure in the same 96×96 box.
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
 * The straight edge runs corner to corner, (74,32) to (62,68), which puts it
 * exactly on all three bar edges: half-width 26 at y=32, 20 at y=50, 14 at
 * y=68 — the mark's 52, 40 and 28. Anchoring the shoulders anywhere else (an
 * earlier draft used y=36) misses the middle bar by two pixels and the figure
 * stops being the mark's outline, which is the only reason to prefer it over
 * any other mascot.
 *
 * Above the shoulders it domes; below the last corner it closes with a hem
 * carrying a slight belly, so it reads as fabric rather than a cone.
 */
export const MASCOT_BODY =
  'M22 32C22 17 33 8 48 8C63 8 74 17 74 32L62 68Q48 78 34 68Z';

/** Where the cloth is opened. Never features drawn on — see the doc. */
export type MascotAperture = 'none' | 'slits' | 'slot' | 'woven';

export const MASCOT_APERTURES: readonly MascotAperture[] = ['none', 'slits', 'slot', 'woven'];

/**
 * One horizontal opening with rounded ends, as a path to subtract.
 *
 * Expressed as its own subpath rather than a separate element so the whole
 * figure stays a single `<path>` with `fill-rule="evenodd"`: one shape, one
 * fill, nothing that can fall out of alignment, and the opening is genuinely
 * absent rather than painted over in the background colour — which would break
 * the moment the figure sat on anything but `#0F0F0F`.
 */
function opening(x: number, width: number, y: number, height: number): string {
  const r = height / 2;
  return `M${x} ${y}h${width}a${r} ${r} 0 0 1 0 ${height}h-${width}a${r} ${r} 0 0 1 0 -${height}Z`;
}

/** The subpaths that open the cloth for `aperture`, or '' for none. */
export function aperturePath(aperture: MascotAperture): string {
  switch (aperture) {
    case 'slits':
      return opening(37, 8, 21, 4.5) + opening(51, 8, 21, 4.5);
    case 'slot':
      return opening(36, 24, 21, 4.5);
    case 'woven':
      // Three bands, the way a masquerade panel is actually woven open.
      return opening(34, 28, 16, 3) + opening(32, 32, 22, 3) + opening(34, 28, 28, 3);
    case 'none':
    default:
      return '';
  }
}

/** The complete figure: cloth, less whatever the aperture removes. */
export function mascotPath(aperture: MascotAperture = 'none'): string {
  return MASCOT_BODY + aperturePath(aperture);
}

/**
 * Below this, the figure is drawn solid.
 *
 * The mark fades 1.0 → 0.5 → 0.22 down its three bars, and the figure inherits
 * that fade. It does not survive being shrunk. At header size the bottom third
 * at 0.22 opacity on near-black is effectively invisible, so the faded figure
 * reads SHORTER and rounder than the solid one — a different silhouette
 * depending on how big it is drawn, which is the one thing a mark cannot do.
 *
 * The mark itself gets away with the same fade because three detached bars
 * still read as three bars however faint the last one is. A continuous body
 * does not: its hem just goes missing.
 *
 * So the fade is a large-size treatment. 32 is where the hem stops holding;
 * the header renders at 22.
 */
export const MASCOT_SOLID_BELOW = 32;

export function usesFade(size: number): boolean {
  return size >= MASCOT_SOLID_BELOW;
}

/** The fade stops, matching the mark's 1.0 / 0.5 / 0.22 at the same heights. */
export const MASCOT_FADE_STOPS: readonly { offset: number; opacity: number }[] = [
  { offset: 0, opacity: 1 },
  // The figure's box runs y=8 to y=73, so the mark's bar centres at y=32, 50
  // and 68 land here. The fade is not merely similar to the mark's: it is the
  // mark's, at the mark's own heights.
  { offset: 0.37, opacity: 1 },
  { offset: 0.65, opacity: 0.5 },
  { offset: 0.92, opacity: 0.22 },
  { offset: 1, opacity: 0.19 },
];
