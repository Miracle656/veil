jest.mock('../network', () => ({ getNetworkName: () => 'mainnet' }))

import { isBackstopEnabled } from '../backstopFeature'

describe('isBackstopEnabled', () => {
  const original = process.env.NEXT_PUBLIC_BLEND_BACKSTOP_FEATURE_FLAG

  afterEach(() => {
    if (original === undefined) delete process.env.NEXT_PUBLIC_BLEND_BACKSTOP_FEATURE_FLAG
    else process.env.NEXT_PUBLIC_BLEND_BACKSTOP_FEATURE_FLAG = original
  })

  it('is off on mainnet by default', () => {
    delete process.env.NEXT_PUBLIC_BLEND_BACKSTOP_FEATURE_FLAG
    expect(isBackstopEnabled()).toBe(false)
    expect(isBackstopEnabled('mainnet')).toBe(false)
  })

  it('opens on mainnet only when the build opts in', () => {
    process.env.NEXT_PUBLIC_BLEND_BACKSTOP_FEATURE_FLAG = '1'
    expect(isBackstopEnabled('mainnet')).toBe(true)

    process.env.NEXT_PUBLIC_BLEND_BACKSTOP_FEATURE_FLAG = 'true'
    expect(isBackstopEnabled('mainnet')).toBe(true)
  })

  it('is available on testnet, where the live cycle runs', () => {
    delete process.env.NEXT_PUBLIC_BLEND_BACKSTOP_FEATURE_FLAG
    expect(isBackstopEnabled('testnet')).toBe(true)
  })
})
