import { buildSponsoredFeeBumpTransaction } from '../feeBump'
import { Keypair, TransactionBuilder } from '@stellar/stellar-sdk'

// feeBump → lib/fees → @veil/sdk, which jest maps to the real SDK source —
// and sdk/src/core.ts reads Horizon.Server at module scope. Under the partial
// stellar-sdk mock below that chain used to explode before any test ran.
// Mocking @veil/sdk keeps the real SDK source out of this suite entirely; the
// fee path is not exercised here (baseFee is always supplied), so a stub bid
// is enough.
jest.mock('@veil/sdk', () => ({
  inclusionFee: () => '100',
}))
// `lib/fees` imports one function from the `@veil/sdk` barrel, and that barrel
// loads the whole SDK core — which reads `Horizon.Server` at module scope. With
// `@stellar/stellar-sdk` mocked below, `Horizon` is undefined and the suite dies
// before a single test runs. Stub the one export the chain actually needs; this
// file is about wrapping a transaction in a fee bump, not about the SDK.
jest.mock('@veil/sdk', () => ({ inclusionFee: () => '100' }))

jest.mock('@stellar/stellar-sdk', () => {
  const sponsorKeypair = {
    publicKey: jest.fn(() => 'GSPONSOR'),
  }
  const feeBump = {
    sign: jest.fn(),
    kind: 'fee-bump',
  }

  return {
    BASE_FEE: '100',
    // feeBump now bids through lib/fees, which reads lib/network — and that
    // needs Networks and Asset at module load. Mocking the SDK without them
    // fails the whole suite before a single test runs.
    Networks: { TESTNET: 'Test SDF Network ; September 2015', PUBLIC: 'Public Global Stellar Network ; September 2015' },
    Asset: { native: () => ({ contractId: () => 'CNATIVE' }) },
    Keypair: {
      fromSecret: jest.fn(() => sponsorKeypair),
    },
    TransactionBuilder: {
      buildFeeBumpTransaction: jest.fn(() => feeBump),
    },
    xdr: {},
  }
})

describe('fee-bump helpers', () => {
  beforeEach(() => {
    jest.clearAllMocks()
  })

  it('wraps a passkey-signed inner transaction in a sponsor-signed fee bump', () => {
    const innerTransaction = {
      signatures: ['passkey-signature'],
      source: 'GUSER',
    }

    const feeBump = buildSponsoredFeeBumpTransaction({
      innerTransaction: innerTransaction as any,
      networkPassphrase: 'Test SDF Network ; September 2015',
      sponsor: { secret: 'SSPONSOR', baseFee: '5000' },
    }) as any

    expect(Keypair.fromSecret).toHaveBeenCalledWith('SSPONSOR')
    expect(TransactionBuilder.buildFeeBumpTransaction).toHaveBeenCalledWith(
      'GSPONSOR',
      '5000',
      innerTransaction,
      'Test SDF Network ; September 2015',
    )
    expect(feeBump.sign).toHaveBeenCalledWith(
      expect.objectContaining({ publicKey: expect.any(Function) }),
    )
    expect(innerTransaction.signatures).toEqual(['passkey-signature'])
  })

})
