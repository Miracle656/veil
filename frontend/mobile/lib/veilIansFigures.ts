/**
 * The twenty Veil-ians, as the app needs them.
 *
 * A copy of `brand/veil-masquerade/traits.json`, the source of truth, which
 * lives outside this bundle. `__tests__/veilIans.test.ts` checks the copy
 * against the original, so a trait edited at the source and not here fails a
 * test rather than shipping a figure described wrongly.
 *
 * The art itself is NOT bundled: twenty full-resolution JPEGs is about 7 MB on
 * an APK that people download over mobile data, to show pictures most of them
 * will scroll past once. They load from the same host the token metadata points
 * at, so the app shows exactly what a marketplace would.
 */

export interface Figure {
  id: number;
  crown: string;
  aperture: string;
  ornament: string;
  palette: string;
  hem: string;
}

/** Ids run 1..20 and the array is in id order, so `FIGURES[id - 1]` is safe. */
export const FIGURES: readonly Figure[] = [
  { id: 1, crown: 'Plume', aperture: 'Twin slits', ornament: 'Chevrons', palette: 'Lilac', hem: 'Beaded fringe' },
  { id: 2, crown: 'Drum cap', aperture: 'Slot', ornament: 'Diamonds', palette: 'Gold + teal', hem: 'Scalloped' },
  { id: 3, crown: 'Beaded dome', aperture: 'Woven band', ornament: 'Zigzag', palette: 'Bone', hem: 'Pointed' },
  { id: 4, crown: 'Flat cap', aperture: 'Slot', ornament: 'Concentric squares', palette: 'Gold + lilac', hem: 'Ragged' },
  { id: 5, crown: 'Crescent', aperture: 'Twin slits', ornament: 'Dotted grid', palette: 'Gold + lilac', hem: 'Straight' },
  { id: 6, crown: 'Fan', aperture: 'Woven band', ornament: 'Basketweave', palette: 'Gold', hem: 'Long fringe' },
  { id: 7, crown: 'Spikes', aperture: 'Slot', ornament: 'Stripes', palette: 'Gold + teal', hem: 'Scalloped' },
  { id: 8, crown: 'Triple finial', aperture: 'Twin slits', ornament: 'Triangles', palette: 'Lilac', hem: 'Ragged' },
  { id: 9, crown: 'Discs', aperture: 'None', ornament: 'Chevrons', palette: 'Teal', hem: 'Beaded fringe' },
  { id: 10, crown: 'Antlers', aperture: 'Slot', ornament: 'Diamonds and dots', palette: 'Gold', hem: 'Pointed' },
  { id: 11, crown: 'Beaded cap', aperture: 'Woven band', ornament: 'Nested chevrons', palette: 'Bone + lilac', hem: 'Layered' },
  { id: 12, crown: 'Plume and beads', aperture: 'Twin slits', ornament: 'Lightning', palette: 'Gold + teal', hem: 'Beaded fringe' },
  { id: 13, crown: 'Coins', aperture: 'Slot', ornament: 'Checkerboard', palette: 'Lilac', hem: 'Scalloped' },
  { id: 14, crown: 'Feather crest', aperture: 'Woven band', ornament: 'Waves', palette: 'Bone + teal', hem: 'Ragged' },
  { id: 15, crown: 'Pyramid', aperture: 'Twin slits', ornament: 'Lattice', palette: 'Gold', hem: 'Straight' },
  { id: 16, crown: 'Loops', aperture: 'Slot', ornament: 'Spirals', palette: 'Lilac', hem: 'Pointed fringe' },
  { id: 17, crown: 'Comb crest', aperture: 'Woven band', ornament: 'Arrows', palette: 'Bone', hem: 'Pointed' },
  { id: 18, crown: 'Beaded veil', aperture: 'Twin slits', ornament: 'Stars', palette: 'Gold + teal', hem: 'Layered' },
  { id: 19, crown: 'Twin horns', aperture: 'Slot', ornament: 'Herringbone', palette: 'Bone + lilac', hem: 'Scalloped' },
  { id: 20, crown: 'Halo', aperture: 'Woven band', ornament: 'Concentric circles', palette: 'Gold', hem: 'Long fringe' },
];

/** Twenty figures, fixed. Mirrors `COLLECTION_SIZE` in the contract. */
export const COLLECTION_SIZE = FIGURES.length;

/** What one costs, in USDC stroops. Mirrors `PRICE * UNIT`. */
export const FIGURE_PRICE_STROOPS = 50_000_000n;

/**
 * Where the art and metadata are served from.
 *
 * Must match the contract's `base_uri`, because that is what a token actually
 * points at — if these two ever disagree, the app shows one picture and every
 * other wallet shows another.
 */
export const COLLECTION_BASE = 'https://app.useveilapp.xyz/masquerade';

/** Two-digit id, matching the published file names. */
export function pad(id: number): string {
  return String(id).padStart(2, '0');
}

export function figureImageUrl(id: number): string {
  return `${COLLECTION_BASE}/${pad(id)}.jpg`;
}

export function figureMetadataUrl(id: number): string {
  return `${COLLECTION_BASE}/${pad(id)}.json`;
}
