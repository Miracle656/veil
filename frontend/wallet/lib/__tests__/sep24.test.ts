/**
 * @jest-environment node
 *
 * Runs under Node (not jsdom): loading @stellar/stellar-sdk in jsdom fails on
 * its module-scope TextEncoder use (same constraint backup.test.ts documents).
 * This suite only mocks global.fetch, which Node 20 provides natively.
 */

jest.mock('../network', () => ({
  getNetwork: jest.fn(() => ({
    name: 'mainnet',
    displayName: 'Stellar Mainnet',
    networkPassphrase: 'Public Global Network',
    horizonUrl: 'https://horizon.stellar.org',
    rpcUrl: 'https://example.test/rpc',
    factoryContractId: 'CMAINNETFACTORY',
    friendbotUrl: null,
  })),
}))

import { discoverAnchorInfo } from '../sep24'
import { getNetwork } from '../network'

const mockGetNetwork = getNetwork as jest.MockedFunction<typeof getNetwork>

const TOML_WITHOUT_PASSPHRASE = [
  'TRANSFER_SERVER_SEP0024 = "https://anchor.example/sep24"',
  'WEB_AUTH_ENDPOINT = "https://anchor.example/auth"',
].join('\n')

describe('discoverAnchorInfo', () => {
  afterEach(() => {
    mockGetNetwork.mockReset()
    mockGetNetwork.mockImplementation(() => ({
      name: 'mainnet',
      displayName: 'Stellar Mainnet',
      networkPassphrase: 'Public Global Network',
      horizonUrl: 'https://horizon.stellar.org',
      rpcUrl: 'https://example.test/rpc',
      factoryContractId: 'CMAINNETFACTORY',
      friendbotUrl: null,
    }))
  })

  it('uses the active mainnet passphrase when the anchor omits NETWORK_PASSPHRASE', async () => {
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      text: async () => TOML_WITHOUT_PASSPHRASE,
    }) as jest.Mock

    await expect(discoverAnchorInfo('anchor.example')).resolves.toMatchObject({
      networkPassphrase: 'Public Global Network',
      transferServerUrl: 'https://anchor.example/sep24',
    })
  })

  it('still prefers the passphrase the anchor publishes', async () => {
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      text: async () => `${TOML_WITHOUT_PASSPHRASE}\nNETWORK_PASSPHRASE = "Anchor Custom Network"`,
    }) as jest.Mock

    await expect(discoverAnchorInfo('anchor.example')).resolves.toMatchObject({
      networkPassphrase: 'Anchor Custom Network',
    })
  })

  it('fails clearly when the active network has no passphrase', async () => {
    // A whole VeilNetwork, not just the field under test: `getNetwork` is
    // typed, so a partial object is a typecheck error even though this code
    // path only reads the passphrase (the mistake #703 fixed in mobile's test).
    mockGetNetwork.mockReturnValueOnce({
      name: 'mainnet',
      displayName: 'Stellar Mainnet',
      networkPassphrase: '',
      horizonUrl: '',
      rpcUrl: '',
      factoryContractId: '',
      friendbotUrl: null,
    })

    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      text: async () => TOML_WITHOUT_PASSPHRASE,
    }) as jest.Mock

    // Before the fix this silently substituted `Networks.TESTNET`, so a
    // mainnet user's SEP-10 challenge was parsed against the wrong network.
    await expect(discoverAnchorInfo('anchor.example')).rejects.toThrow(
      'No network passphrase is configured for Stellar Mainnet.',
    )
  })
})
