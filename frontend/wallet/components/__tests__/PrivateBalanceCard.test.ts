// react-dom/server needs TextEncoder at module load; jsdom omits it.
import { TextEncoder, TextDecoder } from 'util'
Object.assign(globalThis, { TextEncoder, TextDecoder })

import { createElement } from 'react'
import * as React from 'react'
// jest's inline tsconfig uses the classic JSX runtime, so the component's
// compiled output reads a React global that Next's automatic runtime omits.
Object.assign(globalThis, { React })
import { renderToStaticMarkup } from 'react-dom/server'
import { PrivateBalanceCard } from '../PrivateBalanceCard'

const FLAG = 'NEXT_PUBLIC_V131'

function render(props: Parameters<typeof PrivateBalanceCard>[0]): string {
  return renderToStaticMarkup(createElement(PrivateBalanceCard, props))
}

beforeEach(() => {
  delete process.env[FLAG]
})

afterEach(() => {
  delete process.env[FLAG]
})

describe('PrivateBalanceCard', () => {
  it('renders nothing when the V131 flag is off', () => {
    expect(
      render({ balances: [{ code: 'XLM', amount: '10' }], syncState: 'up-to-date', hideAmounts: false }),
    ).toBe('')
  })

  it('masks amounts when hidden amounts is on', () => {
    process.env[FLAG] = 'true'
    const html = render({ balances: [{ code: 'XLM', amount: '12.5' }], syncState: 'up-to-date', hideAmounts: true })
    expect(html).toMatch(/••••/)
    expect(html).not.toMatch(/12\.5/)
  })

  it.each(['syncing', 'needs-history'] as const)('never shows a confident zero while %s', (syncState) => {
    process.env[FLAG] = 'true'
    const html = render({ balances: [], syncState, hideAmounts: false })
    expect(html).not.toMatch(/0\.00/)
    expect(html).not.toMatch(/No shielded balance yet/)
  })

  it('shows the scanning state while syncing', () => {
    process.env[FLAG] = 'true'
    expect(render({ balances: [], syncState: 'syncing', hideAmounts: false })).toMatch(/Scanning the pool/)
  })

  it('shows the bootnode state when history is needed', () => {
    process.env[FLAG] = 'true'
    expect(render({ balances: [], syncState: 'needs-history', hideAmounts: false })).toMatch(/bootnode/)
  })

  it('renders accurate balances once up to date', () => {
    process.env[FLAG] = 'true'
    const html = render({ balances: [{ code: 'XLM', amount: '12.5' }], syncState: 'up-to-date', hideAmounts: false })
    expect(html).toMatch(/12\.5/)
    expect(html).toMatch(/Up to date/)
  })
})