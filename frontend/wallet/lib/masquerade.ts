/**
 * Veil Masquerade Figure System (V274 / V275)
 *
 * The first twenty claimants receive the twenty Masquerade figures in sequence (1..20).
 * Claim order permanently binds to figure number.
 * Claimant 21+ receives a name but no figure.
 */

export interface MasqueradeFigure {
  id: number
  name: string
  image: string
  canvaMediaId: string
  crown: string
  aperture: string
  ornament: string
  palette: string
  hem: string
  isClosedMask: boolean
}

export interface ClaimFigureStatus {
  claimOrder: number
  hasFigure: boolean
  figure: MasqueradeFigure | null
  warning?: string
  note?: string
}

export const MASQUERADE_TOTAL_SUPPLY = 20
export const MASQUERADE_IMAGE_BASE = 'ipfs://REPLACE_WITH_COLLECTION_CID'

export const MASQUERADE_FIGURES: readonly MasqueradeFigure[] = Object.freeze([
  { id: 1,  name: 'Veil Masquerade #01', image: `${MASQUERADE_IMAGE_BASE}/01.png`, canvaMediaId: 'MAHXPqo2Eyc', crown: 'Plume',           aperture: 'Twin slits', ornament: 'Chevrons',           palette: 'Lilac',        hem: 'Beaded fringe', isClosedMask: false },
  { id: 2,  name: 'Veil Masquerade #02', image: `${MASQUERADE_IMAGE_BASE}/02.png`, canvaMediaId: 'MAHXPmqzBDY', crown: 'Horns',           aperture: 'Slot',       ornament: 'Diamonds',           palette: 'Gold',         hem: 'Scalloped',     isClosedMask: false },
  { id: 3,  name: 'Veil Masquerade #03', image: `${MASQUERADE_IMAGE_BASE}/03.png`, canvaMediaId: 'MAHXPvFUx3w', crown: 'Beaded dome',     aperture: 'Woven band', ornament: 'Zigzag',             palette: 'Bone',         hem: 'Pointed',       isClosedMask: false },
  { id: 4,  name: 'Veil Masquerade #04', image: `${MASQUERADE_IMAGE_BASE}/04.png`, canvaMediaId: 'MAHXPtdQFcI', crown: 'Flat cap',        aperture: 'Slot',       ornament: 'Concentric squares', palette: 'Teal',         hem: 'Ragged',        isClosedMask: false },
  { id: 5,  name: 'Veil Masquerade #05', image: `${MASQUERADE_IMAGE_BASE}/05.png`, canvaMediaId: 'MAHXPpvgH4w', crown: 'Crescent',        aperture: 'Twin slits', ornament: 'Dotted grid',        palette: 'Gold + lilac', hem: 'Straight',      isClosedMask: false },
  { id: 6,  name: 'Veil Masquerade #06', image: `${MASQUERADE_IMAGE_BASE}/06.png`, canvaMediaId: 'MAHXPiuZ2LM', crown: 'Fan',             aperture: 'Woven band', ornament: 'Basketweave',        palette: 'Gold',         hem: 'Long fringe',   isClosedMask: false },
  { id: 7,  name: 'Veil Masquerade #07', image: `${MASQUERADE_IMAGE_BASE}/07.png`, canvaMediaId: 'MAHXPp5mwvg', crown: 'Spikes',          aperture: 'Slot',       ornament: 'Stripes',            palette: 'Bone + teal',  hem: 'Scalloped',     isClosedMask: false },
  { id: 8,  name: 'Veil Masquerade #08', image: `${MASQUERADE_IMAGE_BASE}/08.png`, canvaMediaId: 'MAHXPoXBS8w', crown: 'Triple finial',   aperture: 'Twin slits', ornament: 'Triangles',          palette: 'Lilac',        hem: 'Ragged',        isClosedMask: false },
  { id: 9,  name: 'Veil Masquerade #09', image: `${MASQUERADE_IMAGE_BASE}/09.png`, canvaMediaId: 'MAHXPgc7eb0', crown: 'Discs',           aperture: 'None',       ornament: 'Chevrons',           palette: 'Teal',         hem: 'Beaded fringe', isClosedMask: true },
  { id: 10, name: 'Veil Masquerade #10', image: `${MASQUERADE_IMAGE_BASE}/10.png`, canvaMediaId: 'MAHXPrcpoC4', crown: 'Antlers',         aperture: 'Slot',       ornament: 'Diamonds and dots',  palette: 'Gold',         hem: 'Pointed',       isClosedMask: false },
  { id: 11, name: 'Veil Masquerade #11', image: `${MASQUERADE_IMAGE_BASE}/11.png`, canvaMediaId: 'MAHXPvrhqBI', crown: 'Beaded cap',      aperture: 'Woven band', ornament: 'Nested chevrons',    palette: 'Bone + lilac', hem: 'Layered',       isClosedMask: false },
  { id: 12, name: 'Veil Masquerade #12', image: `${MASQUERADE_IMAGE_BASE}/12.png`, canvaMediaId: 'MAHXPjak9Iw', crown: 'Plume and beads', aperture: 'Twin slits', ornament: 'Lightning',          palette: 'Gold + teal',  hem: 'Beaded fringe', isClosedMask: false },
  { id: 13, name: 'Veil Masquerade #13', image: `${MASQUERADE_IMAGE_BASE}/13.png`, canvaMediaId: 'MAHXPkUrBBE', crown: 'Coins',           aperture: 'Slot',       ornament: 'Checkerboard',       palette: 'Lilac',        hem: 'Scalloped',     isClosedMask: false },
  { id: 14, name: 'Veil Masquerade #14', image: `${MASQUERADE_IMAGE_BASE}/14.png`, canvaMediaId: 'MAHXPtsVs5s', crown: 'Feather crest',   aperture: 'Woven band', ornament: 'Waves',              palette: 'Bone + teal',  hem: 'Ragged',        isClosedMask: false },
  { id: 15, name: 'Veil Masquerade #15', image: `${MASQUERADE_IMAGE_BASE}/15.png`, canvaMediaId: 'MAHXPgPU510', crown: 'Pyramid',         aperture: 'Twin slits', ornament: 'Lattice',            palette: 'Gold',         hem: 'Straight',      isClosedMask: false },
  { id: 16, name: 'Veil Masquerade #16', image: `${MASQUERADE_IMAGE_BASE}/16.png`, canvaMediaId: 'MAHXPvE_ig4', crown: 'Loops',           aperture: 'Slot',       ornament: 'Spirals',            palette: 'Lilac',        hem: 'Pointed fringe',isClosedMask: false },
  { id: 17, name: 'Veil Masquerade #17', image: `${MASQUERADE_IMAGE_BASE}/17.png`, canvaMediaId: 'MAHXPr8C22A', crown: 'Comb crest',      aperture: 'Woven band', ornament: 'Arrows',             palette: 'Bone',         hem: 'Pointed',       isClosedMask: false },
  { id: 18, name: 'Veil Masquerade #18', image: `${MASQUERADE_IMAGE_BASE}/18.png`, canvaMediaId: 'MAHXPoxCaI4', crown: 'Beaded veil',     aperture: 'Twin slits', ornament: 'Stars',              palette: 'Gold + teal',  hem: 'Layered',       isClosedMask: false },
  { id: 19, name: 'Veil Masquerade #19', image: `${MASQUERADE_IMAGE_BASE}/19.png`, canvaMediaId: 'MAHXPi8QBNM', crown: 'Twin horns',      aperture: 'Slot',       ornament: 'Herringbone',        palette: 'Bone + lilac', hem: 'Scalloped',     isClosedMask: false },
  { id: 20, name: 'Veil Masquerade #20', image: `${MASQUERADE_IMAGE_BASE}/20.png`, canvaMediaId: 'MAHXPkOJqrM', crown: 'Halo',            aperture: 'Woven band', ornament: 'Concentric circles', palette: 'Gold',         hem: 'Long fringe',   isClosedMask: false },
])

/**
 * Returns figure status and details for a claimant based on claim order (1-indexed).
 */
export function getMasqueradeFigureForOrder(claimOrder: number): ClaimFigureStatus {
  if (claimOrder <= 0) {
    throw new Error(`Invalid claim order: ${claimOrder}`)
  }

  if (claimOrder > MASQUERADE_TOTAL_SUPPLY) {
    return {
      claimOrder,
      hasFigure: false,
      figure: null,
      warning:
        'All 20 Veil Masquerade figures have been allocated. You will receive your name, but no Masquerade figure token.',
    }
  }

  const figure = MASQUERADE_FIGURES[claimOrder - 1] ?? null
  const note =
    claimOrder === 9
      ? 'Veil Masquerade #09 — the unique closed mask in the set (Aperture: None) — goes to the ninth claimant.'
      : undefined

  return {
    claimOrder,
    hasFigure: true,
    figure,
    note,
  }
}
