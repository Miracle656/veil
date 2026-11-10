/**
 * @jest-environment node
 */

import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import { COLLECTION_SIZE, FIGURES, figureImageUrl, pad } from '../masqueradeFigures'

/**
 * `lib/masqueradeFigures.ts` is a copy of the collection's source of truth.
 * This is the test that makes the copy safe: edit a trait at the source and
 * forget to copy it, and the grid describes a figure the token does not match.
 */
const traits = JSON.parse(
  readFileSync(
    join(__dirname, '..', '..', '..', '..', 'brand', 'veil-masquerade', 'traits.json'),
    'utf8',
  ),
) as {
  collection: { size: number }
  tokens: {
    id: number
    crown: string
    aperture: string
    ornament: string
    palette: string
    hem: string
    image: string
  }[]
}

describe('FIGURES matches brand/veil-masquerade/traits.json', () => {
  it('has the same number of figures the collection declares', () => {
    expect(COLLECTION_SIZE).toBe(traits.collection.size)
    expect(FIGURES).toHaveLength(traits.tokens.length)
  })

  it('carries every trait of every figure, unchanged', () => {
    for (const token of traits.tokens) {
      const mine = FIGURES.find((f) => f.id === token.id)
      expect(mine).toBeDefined()
      expect(mine).toEqual({
        id: token.id,
        crown: token.crown,
        aperture: token.aperture,
        ornament: token.ornament,
        palette: token.palette,
        hem: token.hem,
      })
    }
  })

  it('is in id order, because the grid indexes by position', () => {
    // `FIGURES[id - 1]` is used to render the selected figure. Out of order,
    // the buy bar would describe one figure while buying another.
    expect(FIGURES.map((f) => f.id)).toEqual(traits.tokens.map((_, i) => i + 1))
  })

  it('points at the image file the source names', () => {
    for (const token of traits.tokens) {
      expect(figureImageUrl(token.id)).toBe(`/masquerade/${token.image}`)
    }
  })

  it('pads to two digits', () => {
    expect(pad(1)).toBe('01')
    expect(pad(20)).toBe('20')
  })
})
