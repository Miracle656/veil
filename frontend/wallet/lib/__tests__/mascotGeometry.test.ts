import {
  MASCOT_APERTURES,
  MASCOT_BODY,
  MASCOT_FADE_STOPS,
  MASCOT_SOLID_BELOW,
  aperturePath,
  mascotPath,
  usesFade,
} from '../mascotGeometry'

/**
 * The mascot's geometry.
 *
 * The claim the whole direction rests on is that the figure is the mark's own
 * outline — so the thing worth pinning is that its taper still matches the
 * mark's bar widths, and that an opening is genuinely subtracted rather than
 * painted over.
 */

/** Width of the figure at height `y`, read off the straight taper. */
function widthAt(y: number): number {
  // Right edge runs corner to corner, (74, 32) to (62, 68); the left mirrors
  // it about x=48.
  const right = 74 - (12 * (y - 32)) / 36
  return (right - 48) * 2
}

/**
 * The mark's three bars: width, and the y its corners sit at.
 * VeilMark draws them at y=26, 44, 62, each 12 tall, so the corners are +6.
 */
const BARS = [
  { width: 52, y: 32 },
  { width: 40, y: 50 },
  { width: 28, y: 68 },
] as const

describe('the taper comes from the mark', () => {
  it.each(BARS)('is exactly $width wide at y$y', ({ width, y }) => {
    // Exact, not approximate. An earlier draft anchored the shoulders at y=36
    // and missed the middle bar by two pixels; at that point the figure is
    // merely mark-like, and being the mark's own outline is the whole argument
    // for it over any other mascot.
    expect(widthAt(y)).toBeCloseTo(width, 10)
  })

  it('draws the cloth as one closed shape', () => {
    expect(MASCOT_BODY.startsWith('M')).toBe(true)
    expect(MASCOT_BODY.endsWith('Z')).toBe(true)
    // One subpath: a second 'M' would mean the body had been split in two.
    expect(MASCOT_BODY.match(/M/g)).toHaveLength(1)
  })
})

describe('apertures are cloth removed', () => {
  it('leaves the cloth alone when there is none', () => {
    expect(aperturePath('none')).toBe('')
    expect(mascotPath('none')).toBe(MASCOT_BODY)
  })

  it.each([
    ['slits', 2],
    ['slot', 1],
    ['woven', 3],
  ] as const)('opens %s as %i subpath(s)', (aperture, openings) => {
    const path = aperturePath(aperture)
    expect(path.match(/M/g)).toHaveLength(openings)
    expect(path.endsWith('Z')).toBe(true)
  })

  it('keeps every aperture inside one path, so the figure stays one shape', () => {
    for (const aperture of MASCOT_APERTURES) {
      // The body first, the openings appended: evenodd then subtracts them.
      // Separate elements filled with the background colour would look the
      // same on #0F0F0F and break on anything else.
      expect(mascotPath(aperture).startsWith(MASCOT_BODY)).toBe(true)
    }
  })

  it('keeps every opening well inside the cloth', () => {
    // A box the figure comfortably contains at every height an opening uses:
    // the dome narrows above the shoulders, so extrapolating the straight
    // taper up there would pass an opening that actually hangs off the edge.
    for (const aperture of MASCOT_APERTURES) {
      for (const [, xs, ys, ws] of aperturePath(aperture).matchAll(
        /M([\d.]+) ([\d.]+)h([\d.]+)/g,
      )) {
        const left = Number(xs)
        const right = left + Number(ws)
        const y = Number(ys)
        expect(y).toBeGreaterThanOrEqual(14)
        expect(y).toBeLessThanOrEqual(36)
        expect(left).toBeGreaterThanOrEqual(30)
        expect(right).toBeLessThanOrEqual(66)
      }
    }
  })
})

describe('the fade is a large-size treatment', () => {
  it('draws solid at the size the header uses', () => {
    // 22px is what VeilMark renders at in the dashboard header. The hem at
    // 0.22 opacity disappears there, which would make the figure read shorter
    // small than large — a mark cannot change shape with size.
    expect(usesFade(22)).toBe(false)
    expect(usesFade(MASCOT_SOLID_BELOW - 1)).toBe(false)
  })

  it('fades once there is room for the hem to survive', () => {
    expect(usesFade(MASCOT_SOLID_BELOW)).toBe(true)
    expect(usesFade(96)).toBe(true)
  })

  it('puts the mark’s own opacities at the mark’s own heights', () => {
    // The figure's box runs y=8 to y=73. A bar centre at y maps to
    // (y - 8) / 65 along the gradient, so matching the mark is checkable
    // rather than a matter of taste.
    const at = (y: number) => (y - 8) / 65
    const stopFor = (opacity: number) => MASCOT_FADE_STOPS.find((s) => s.opacity === opacity)

    expect(stopFor(1)).toBeDefined()
    expect(stopFor(0.5)!.offset).toBeCloseTo(at(50), 2)
    expect(stopFor(0.22)!.offset).toBeCloseTo(at(68), 2)
    // The full-opacity run has to reach the top bar.
    expect(Math.max(...MASCOT_FADE_STOPS.filter((s) => s.opacity === 1).map((s) => s.offset)))
      .toBeCloseTo(at(32), 2)
  })

  it('runs top to bottom without going backwards', () => {
    const offsets = MASCOT_FADE_STOPS.map((s) => s.offset)
    expect(offsets).toEqual([...offsets].sort((a, b) => a - b))
    expect(offsets[0]).toBe(0)
    expect(offsets[offsets.length - 1]).toBe(1)
  })
})
