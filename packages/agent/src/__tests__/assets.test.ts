import { beforeAll, describe, expect, it, jest } from '@jest/globals'

import { ASSET_REGISTRY } from '../assets.js'

jest.unstable_mockModule('@stellar/stellar-sdk', () => ({
  Asset: { native: jest.fn() },
  Networks: { PUBLIC: 'public', TESTNET: 'testnet' },
}))

jest.unstable_mockModule('@soroswap/sdk', () => ({
  SoroswapSDK: jest.fn(),
  SupportedNetworks: { MAINNET: 'mainnet' },
  SupportedProtocols: {},
  TradeType: {},
}))

let resolveAsset: typeof import('../price.js').resolveAsset

describe('agent asset registry', () => {
  beforeAll(async () => {
    ({ resolveAsset } = await import('../price.js'))
  })

  it('resolves bare USDC from the registry', () => {
    expect(resolveAsset('USDC').horizon).toBe(`USDC:${ASSET_REGISTRY.USDC.issuer}`)
  })

  it('resolves every mainnet registry asset by its pinned issuer', () => {
    for (const asset of Object.values(ASSET_REGISTRY)) {
      expect(resolveAsset(asset.code).horizon).toBe(`${asset.code}:${asset.issuer}`)
    }
  })
})