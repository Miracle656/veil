/**
 * @jest-environment node
 */
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'

import { PoolStatusNotice } from '../PoolStatusNotice'

jest.mock('@/lib/blendStatus', () => jest.requireActual('../../lib/blendStatus'))

const render = (status: number | null) => renderToStaticMarkup(createElement(PoolStatusNotice, { status }))

describe('PoolStatusNotice', () => {
  it.each([0, 1])('renders nothing for an active pool (status %i)', (status) => {
    expect(render(status)).toBe('')
  })

  it('tells the person when the pool has paused borrowing (status 3, as read from mainnet on 2026-11-28)', () => {
    const html = render(3)
    expect(html).toContain('role="status"')
    expect(html).toContain('Borrowing paused')
    expect(html).toContain('You can still deposit and withdraw')
  })

  it('tells the person when deposits are closed', () => {
    expect(render(5)).toContain('Deposits closed')
  })

  it('says so when the status could not be read', () => {
    expect(render(null)).toContain('Status unknown')
  })
})
