import { buildSponsoredFeeBumpTransaction } from '../feeBump'
import { Keypair, TransactionBuilder } from '@stellar/stellar-sdk'

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
