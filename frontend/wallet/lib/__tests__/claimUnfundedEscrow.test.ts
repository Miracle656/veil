/**
 * The wallet's own entry point into the fee-bumped claim.
 *
 * The claim itself is tested with the SDK. What this pins is the choice made
 * here: which account pays, that a locked wallet does not silently claim with
 * no fee payer, and that the claim is bid at the wallet's inclusion fee rather
 * than the bare network minimum.
 */
import type { Keypair } from '@stellar/stellar-sdk'

import { claimUnfundedEscrow } from '../claimUnfundedEscrow'
import { claimEscrowWithFeeBump } from '../escrow'
import { peekFeePayerKeypair } from '../feePayer'
import { inclusionFee } from '../fees'
import { getNetwork } from '../network'

// jsdom has no TextEncoder, so the real SDK cannot load here. The claim itself
// is covered by the SDK's own tests; this suite only pins the wallet's choice of
// fee payer and the signers it hands over.
jest.mock('@stellar/stellar-sdk', () => ({
  TransactionBuilder: {
    fromXDR: jest.fn((xdr: string) => ({
      sign: jest.fn(),
      toXDR: () => `${xdr}:signed`,
    })),
  },
}))

jest.mock('../escrow', () => ({
  claimEscrowWithFeeBump: jest.fn(),
}))
jest.mock('../feePayer', () => ({
  peekFeePayerKeypair: jest.fn(),
}))
jest.mock('../fees', () => ({
  inclusionFee: jest.fn(() => '100000'),
}))
jest.mock('../network', () => ({
  getNetwork: jest.fn(() => ({
    horizonUrl: 'https://horizon-testnet.stellar.org',
    networkPassphrase: 'Test SDF Network ; September 2015',
  })),
}))

const mockClaim = claimEscrowWithFeeBump as jest.MockedFunction<typeof claimEscrowWithFeeBump>
const mockPeekFeePayer = peekFeePayerKeypair as jest.MockedFunction<typeof peekFeePayerKeypair>
const mockInclusionFee = inclusionFee as jest.MockedFunction<typeof inclusionFee>
const mockGetNetwork = getNetwork as jest.MockedFunction<typeof getNetwork>

const BALANCE_ID = '00000000' + 'cd'.repeat(32)

/** The real SDK is mocked here, so a signer is only its public key. */
const fakeKeypair = (publicKey: string) => ({ publicKey: () => publicKey }) as unknown as Keypair

beforeEach(() => {
  jest.clearAllMocks()
  mockInclusionFee.mockReturnValue('100000')
  mockPeekFeePayer.mockReturnValue(fakeKeypair('GWALLETFEEPAYER'))
  mockClaim.mockResolvedValue({
    txHash: 'claim-hash',
    claimantAccountCreated: false,
    feePayer: 'GWALLETFEEPAYER',
  })
})

describe('who pays for the claim', () => {
  it('pays from this wallet fee payer, on the active network, at the inclusion fee', async () => {
    const claimant = fakeKeypair('GONETIMEKEY')
    const feePayer = fakeKeypair('GCHOSENFEEPAYER')
    mockPeekFeePayer.mockReturnValue(feePayer)

    await claimUnfundedEscrow({ claimant, balanceId: BALANCE_ID })

    expect(mockClaim).toHaveBeenCalledWith({
      claimant: expect.objectContaining({ publicKey: 'GONETIMEKEY' }),
      feePayer: expect.objectContaining({ publicKey: 'GCHOSENFEEPAYER' }),
      balanceId: BALANCE_ID,
      config: {
        horizonUrl: 'https://horizon-testnet.stellar.org',
        networkPassphrase: 'Test SDF Network ; September 2015',
      },
      baseFee: '100000',
    })
  })

  it('says the wallet is locked rather than claiming without a payer', async () => {
    mockPeekFeePayer.mockReturnValue(null)

    await expect(
      claimUnfundedEscrow({ claimant: fakeKeypair('GONETIMEKEY'), balanceId: BALANCE_ID }),
    ).rejects.toThrow('locked')

    expect(mockClaim).not.toHaveBeenCalled()
  })
})

describe('what the caller gets back', () => {
  it('reports the claim hash and whether the one-time account was created', async () => {
    mockClaim.mockResolvedValue({
      txHash: 'claim-hash',
      claimantAccountCreated: true,
      feePayer: 'GFEEPAYER',
    })

    await expect(
      claimUnfundedEscrow({ claimant: fakeKeypair('GONETIMEKEY'), balanceId: BALANCE_ID }),
    ).resolves.toEqual({
      txHash: 'claim-hash',
      claimantAccountCreated: true,
      feePayer: 'GFEEPAYER',
    })
  })

  it('passes a failed claim through untouched, so a retry stays possible', async () => {
    mockClaim.mockRejectedValue(new Error('tx_fee_bump_inner_failed'))

    await expect(
      claimUnfundedEscrow({ claimant: fakeKeypair('GONETIMEKEY'), balanceId: BALANCE_ID }),
    ).rejects.toThrow('tx_fee_bump_inner_failed')

    expect(mockClaim).toHaveBeenCalledTimes(1)
    expect(mockGetNetwork).toHaveBeenCalled()
  })
})
