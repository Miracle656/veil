import {
  MASCOT_APERTURES,
  MASCOT_BANDS,
  MASCOT_BODY,
  MASCOT_LAYERED_FROM,
  aperturePath,
  isLayered,
  mascotPath,
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

  it('is widest at the shoulder, not at the head', () => {
    // The first round domed straight over the top, which made the head the
    // widest part — and a figure whose head is its widest part is a lightbulb,
    // whatever the taper beneath it is derived from. The crown is now the hem's
    // width, 28, and the cloth spreads out from it to the mark's 52.
    const crown = MASCOT_BODY.match(/C34 13 40 8 48 8C56 8 62 13 62 23/)
    expect(crown).not.toBeNull()
    // Crown spans x=34 to x=62 — 28 across, the same as the hem.
    expect(62 - 34).toBe(28)
    expect(widthAt(32)).toBeGreaterThan(28)
  })

  it('breaks the hem instead of smoothing it', () => {
    // A single smooth belly reads as a solid object. Three scallops read as
    // cloth. Each is one quadratic, so count them.
    expect(MASCOT_BODY.match(/Q/g)).toHaveLength(3)
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

  it('keeps every opening inside the crown', () => {
    // Measured off the crown's own cubic — P0(34,23) C(34,13) C(40,8) (48,8) —
    // rather than extrapolated from the body's straight taper, which would say
    // the head is wider than it is and pass an opening hanging off the edge:
    //
    //   y=11.8 -> 20.0 across    y=15.3 -> 25.0 across
    //   y=13.4 -> 22.8 across    y=17.6 -> 26.6 across
    //
    // So this box is inside the crown at every height an opening uses. The
    // hooded head has far less room than the first round's bulb did, which is
    // the point: the aperture has to be designed against this shape.
    for (const aperture of MASCOT_APERTURES) {
      for (const [, xs, ys, ws] of aperturePath(aperture).matchAll(
        /M([\d.]+) ([\d.]+)h([\d.]+)/g,
      )) {
        const left = Number(xs)
        const right = left + Number(ws)
        const y = Number(ys)
        expect(y).toBeGreaterThanOrEqual(12)
        expect(y).toBeLessThanOrEqual(26)
        expect(left).toBeGreaterThanOrEqual(36)
        expect(right).toBeLessThanOrEqual(60)
      }
    }
  })

  it('narrows the openings as they climb the crown', () => {
    // The crown tapers upward, so an opening higher than another may not be
    // wider than it. This is what stops a redrawn aperture from quietly
    // overflowing the head.
    const bands = [...aperturePath('woven').matchAll(/M([\d.]+) ([\d.]+)h([\d.]+)/g)]
      .map(([, , y, w]) => ({ y: Number(y), width: Number(w) }))
      .sort((a, b) => a.y - b.y)

    for (let i = 1; i < bands.length; i++) {
      expect(bands[i].width).toBeGreaterThanOrEqual(bands[i - 1].width)
    }
  })
})

describe('detail is a large-size treatment', () => {
  it('draws one solid shape at the size the header uses', () => {
    // 22px is what VeilMark renders at in the dashboard header. Seams there
    // are mud, and the first round proved the matching point about the mark's
    // fade: a figure that reads shorter small than large is not one mark.
    expect(isLayered(22)).toBe(false)
    expect(isLayered(MASCOT_LAYERED_FROM - 1)).toBe(false)
  })

  it('seams once there is room for them to mean something', () => {
    expect(isLayered(MASCOT_LAYERED_FROM)).toBe(true)
    expect(isLayered(200)).toBe(true)
  })

  it('carries the mark’s own three opacities', () => {
    expect(MASCOT_BANDS.map((b) => b.opacity)).toEqual([1, 0.5, 0.22])
  })

  it('covers the whole box, so the seams cannot change the outline', () => {
    // Every band runs the full width and they overlap vertically; clipped to
    // the body, their union is exactly the silhouette. A gap between two of
    // them would punch a hole the plain rendering does not have.
    const spans = MASCOT_BANDS.map((band) => {
      const ys = [...band.d.matchAll(/[HVMQ ](?:[\d.]+ )?([\d.]+)/g)].map((m) => Number(m[1]))
      return { top: Math.min(...ys), bottom: Math.max(...ys) }
    })

    expect(spans[0].top).toBe(0)
    expect(spans[spans.length - 1].bottom).toBe(96)
    for (let i = 1; i < spans.length; i++) {
      // The next band starts before the previous one ends.
      expect(spans[i].top).toBeLessThan(spans[i - 1].bottom)
    }
  })
})
