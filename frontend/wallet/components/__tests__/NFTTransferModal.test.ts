// react-dom/server needs TextEncoder at module load; jsdom omits it.
import { TextEncoder, TextDecoder } from 'util'
Object.assign(globalThis, { TextEncoder, TextDecoder })

import { createElement } from 'react'
import * as React from 'react'
Object.assign(globalThis, { React })
import { renderToStaticMarkup } from 'react-dom/server'
import { NFTTransferModal } from '../NFTTransferModal'
import type { NFTItem } from '../../lib/nfts'

function makeToken(overrides: Partial<NFTItem> = {}): NFTItem {
  return {
    id: 'tok-1077',
    contractId: 'CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAANFT1',
    tokenId: '42',
    name: 'Veil Masquerade #042',
    image: null,
    attributes: [],
    owner: 'GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWLT',
    standard: 'CAP-46',
    ...overrides,
  }
}

function renderModal(props: Parameters<typeof NFTTransferModal>[0]): string {
  return renderToStaticMarkup(createElement(NFTTransferModal, props))
}

describe('NFTTransferModal (Issue #1077)', () => {
  it('renders nothing when isOpen is false', () => {
    const html = renderModal({
      token: makeToken(),
      isOpen: false,
      onClose: () => {},
      onTransfer: () => {},
    })
    expect(html).toBe('')
  })

  it('transferring a token that carries a name shows the consequence before it is signed', () => {
    const token = makeToken({ boundName: 'alice*useveilapp.xyz' })
    const html = renderModal({
      token,
      isOpen: true,
      onClose: () => {},
      onTransfer: () => {},
    })

    // Shows warning card
    expect(html).toContain('name-transfer-warning-card')
    expect(html).toContain('The name &quot;alice*useveilapp.xyz&quot; goes with this token.')
    expect(html).toContain('Anyone who has saved this name will pay the new holder from now on.')
  })

  it('transferring a token with no name does not show the warning', () => {
    const token = makeToken({ boundName: null, attributes: [] })
    const html = renderModal({
      token,
      isOpen: true,
      onClose: () => {},
      onTransfer: () => {},
    })

    // Does NOT show warning card or consequence copy
    expect(html).not.toContain('name-transfer-warning-card')
    expect(html).not.toContain('Anyone who has saved this name will pay the new holder from now on')
  })

  it('the copy names the specific name being moved, not generic "your name"', () => {
    const token = makeToken({ boundName: 'satoshix*useveilapp.xyz' })
    const html = renderModal({
      token,
      isOpen: true,
      onClose: () => {},
      onTransfer: () => {},
    })

    expect(html).toContain('satoshix*useveilapp.xyz')
    expect(html).not.toContain('your name')
    expect(html).toContain('Transferring satoshix*useveilapp.xyz')
  })

  it('asserts the warning cannot be skipped on a name-carrying token: button is disabled initially', () => {
    const token = makeToken({ boundName: 'kabeer*useveilapp.xyz' })
    const html = renderModal({
      token,
      isOpen: true,
      onClose: () => {},
      onTransfer: () => {},
    })

    // Button has disabled attribute in static markup when unconfirmed
    expect(html).toContain('data-testid="confirm-transfer-button"')
    expect(html).toMatch(/<button[^>]*disabled[^>]*data-testid="confirm-transfer-button"/)
    expect(html).toContain('name-transfer-confirm-checkbox')
  })
})
