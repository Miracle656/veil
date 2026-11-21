/** @jest-environment node */

import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'

import { VaultPositionHistory } from '../VaultPositionHistory'

describe('VaultPositionHistory', () => {
  it('renders an explicit no-data state instead of invented history', () => {
    const html = renderToStaticMarkup(createElement(VaultPositionHistory, { history: [] }))
    expect(html).toContain('Position value history')
    expect(html).toContain('Position value history is unavailable')
  })

  it('renders a visible annotated drop', () => {
    const html = renderToStaticMarkup(
      createElement(VaultPositionHistory, {
        history: [
          { timestamp: 1_700_000_000, valueStroops: 100_000_000n },
          { timestamp: 1_700_086_400, valueStroops: 90_000_000n },
        ],
      }),
    )
    expect(html).toContain('Share value fell')
    expect(html).toContain('10')
    expect(html).toContain('10.00%')
  })
})
