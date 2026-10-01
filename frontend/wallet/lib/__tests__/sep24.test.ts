import { TextEncoder, TextDecoder } from 'util'
Object.assign(globalThis, { TextEncoder, TextDecoder })

jest.mock('@/lib/network', () => ({
  getNetwork: jest.fn(() => ({
    displayName: 'Stellar Mainnet',
    networkPassphrase: 'Public Global Network',
  })),
}))

import { discoverAnchorInfo } from '../sep24'
import { getNetwork } from '@/lib/network'

const mockGetNetwork = getNetwork as jest.MockedFunction<typeof getNetwork>

describe('discoverAnchorInfo', () => {
  it('uses the active mainnet passphrase when the anchor omits NETWORK_PASSPHRASE', async () => {
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      text: async () => [
        'TRANSFER_SERVER_SEP0024 = "https://anchor.example/sep24"',
        'WEB_AUTH_ENDPOINT = "https://anchor.example/auth"',
      ].join('\n'),
    }) as jest.Mock

    await expect(discoverAnchorInfo('anchor.example')).resolves.toMatchObject({
      networkPassphrase: 'Public Global Network',
      transferServerUrl: 'https://anchor.example/sep24',
    })
  })

  it('fails clearly when the active network has no passphrase', async () => {
    mockGetNetwork.mockReturnValueOnce({
      displayName: 'Stellar Mainnet',
      networkPassphrase: '',
    } as any)

    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      text: async () => [
        'TRANSFER_SERVER_SEP0024 = "https://anchor.example/sep24"',
        'WEB_AUTH_ENDPOINT = "https://anchor.example/auth"',
      ].join('\n'),
    }) as jest.Mock

    await expect(discoverAnchorInfo('anchor.example')).rejects.toThrow(
      'No network passphrase is configured for Stellar Mainnet.',
    )
  })
})

describe('getDefaultSep24Anchor', () => {
  const originalEnv = process.env.NEXT_PUBLIC_SEP24_ANCHORS

  afterEach(() => {
    process.env.NEXT_PUBLIC_SEP24_ANCHORS = originalEnv
  })

  it('does not fall back to testanchor.stellar.org when NEXT_PUBLIC_SEP24_ANCHORS is omitted', () => {
    delete process.env.NEXT_PUBLIC_SEP24_ANCHORS
    const { getDefaultSep24Anchor } = require('../sep24')
    expect(getDefaultSep24Anchor()).toBe('')
    expect(getDefaultSep24Anchor()).not.toContain('testanchor')
  })

  it('uses the first configured anchor domain when NEXT_PUBLIC_SEP24_ANCHORS is set', () => {
    process.env.NEXT_PUBLIC_SEP24_ANCHORS = 'anchor.mywallet.org, fallback.mywallet.org'
    const { getDefaultSep24Anchor } = require('../sep24')
    expect(getDefaultSep24Anchor()).toBe('anchor.mywallet.org')
  })
})

