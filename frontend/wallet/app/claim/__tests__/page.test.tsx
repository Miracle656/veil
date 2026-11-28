import { TextEncoder, TextDecoder } from 'util'
Object.assign(globalThis, { TextEncoder, TextDecoder })

import * as React from 'react'
Object.assign(globalThis, { React })

import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { Keypair } from '@stellar/stellar-sdk'
import { useParams, useRouter } from 'next/navigation'

import ClaimLinkPage from '../[id]/page'
import { claimWebLink, inspectWebClaimLink, retryWebReserveRelease } from '@/lib/claimLink'
import { ensureFeePayer, peekFeePayerKeypair } from '@/lib/feePayer'
import { walletLocal } from '@/lib/walletStorage'

jest.mock('next/navigation', () => ({
  useRouter: jest.fn(),
  useParams: jest.fn(),
}))
jest.mock('@/lib/feePayer', () => ({
  ensureFeePayer: jest.fn(),
  peekFeePayerKeypair: jest.fn(),
}))
jest.mock('@/lib/claimLink', () => {
  const actual = jest.requireActual('@/lib/claimLink')
  return {
    ...actual,
    inspectWebClaimLink: jest.fn(),
    claimWebLink: jest.fn(),
    retryWebReserveRelease: jest.fn(),
  }
})

const SENDER = Keypair.random()
const EPHEMERAL = Keypair.random()
const FEE_PAYER = Keypair.random()
const FAKE_ISSUER = Keypair.random().publicKey()
const BALANCE_ID = '00000000' + 'cd'.repeat(32)

describe('ClaimLinkPage — web /claim/[id] route', () => {
  const mockPush = jest.fn()

  beforeEach(() => {
    jest.clearAllMocks()
    localStorage.clear()
    sessionStorage.clear()
    ;(useRouter as jest.Mock).mockReturnValue({
      push: mockPush,
      replace: jest.fn(),
      back: jest.fn(),
    })
    ;(useParams as jest.Mock).mockReturnValue({ id: BALANCE_ID })
    ;(ensureFeePayer as jest.Mock).mockResolvedValue(FEE_PAYER)
    ;(peekFeePayerKeypair as jest.Mock).mockReturnValue(FEE_PAYER)
    window.history.replaceState(
      null,
      '',
      `/claim/${BALANCE_ID}?network=testnet&note=Lunch#s=${encodeURIComponent(EPHEMERAL.secret())}`,
    )
  })

  it('renders verified Horizon details, claims via #s= fragment, and strips the hash afterwards', async () => {
    walletLocal.setItem('invisible_wallet_address', 'C_TEST_WALLET')
    ;(inspectWebClaimLink as jest.Mock).mockResolvedValue({
      status: 'claimable',
      balanceId: BALANCE_ID,
      amount: '25',
      assetCode: 'XLM',
      assetIssuer: null,
      sponsor: SENDER.publicKey(),
      claimantAddresses: [EPHEMERAL.publicKey()],
      expiresAt: 1_900_000_000,
      expired: false,
      expiryLabel: 'Claim within 7d',
      isVerifiedAsset: true,
      verifiedAssetName: 'Stellar Lumens',
      verifiedIssuerName: 'Stellar',
    })
    const fullWebHash = 'f'.repeat(64)
    ;(claimWebLink as jest.Mock).mockResolvedValue({
      status: 'claimed',
      txHash: fullWebHash,
      mergeTxHash: 'e'.repeat(64),
      reserveReleased: true,
      reserveReleaseTxHash: 'e'.repeat(64),
      amount: '25',
      assetCode: 'XLM',
      assetIssuer: null,
      destination: FEE_PAYER.publicKey(),
    })

    const user = userEvent.setup()
    const { container } = render(<ClaimLinkPage />)

    expect((await screen.findByTestId('web-claim-amount')).textContent).toBe('25 XLM')
    expect(screen.getByTestId('web-claim-verification-badge').textContent).toContain(
      'Verified asset',
    )
    expect(container.textContent).toContain('Spending account')
    expect(container.textContent).not.toContain('fee-payer account')
    expect(screen.getByTestId('web-claim-sender').textContent).toBe(SENDER.publicKey())
    expect(screen.getByTestId('web-claim-note').textContent).toBe('Lunch')

    await user.click(screen.getByTestId('web-claim-submit'))

    expect(claimWebLink).toHaveBeenCalledWith({
      balanceId: BALANCE_ID,
      ephemeralSecret: EPHEMERAL.secret(),
      linkNetwork: 'testnet',
    })
    expect((await screen.findByTestId('web-claim-tx-hash')).textContent).toContain(fullWebHash)
    expect(screen.queryByTestId('web-claim-reserve-warning')).toBeNull()
    expect(window.location.hash).toBe('')
  })

  it('retains #s= and shows retry warning when Tx 2 reserve release fails, then strips #s= after retry succeeds', async () => {
    walletLocal.setItem('invisible_wallet_address', 'C_TEST_WALLET')
    ;(inspectWebClaimLink as jest.Mock).mockResolvedValue({
      status: 'claimable',
      balanceId: BALANCE_ID,
      amount: '25',
      assetCode: 'XLM',
      assetIssuer: null,
      sponsor: SENDER.publicKey(),
      claimantAddresses: [EPHEMERAL.publicKey()],
      expiresAt: 1_900_000_000,
      expired: false,
      expiryLabel: 'Claim within 7d',
      isVerifiedAsset: true,
      verifiedAssetName: 'Stellar Lumens',
      verifiedIssuerName: 'Stellar',
    })
    const fullWebHash = 'a'.repeat(64)
    ;(claimWebLink as jest.Mock).mockResolvedValue({
      status: 'claimed',
      txHash: fullWebHash,
      mergeTxHash: null,
      reserveReleased: false,
      reserveReleaseError: 'Horizon 504 on accountMerge',
      amount: '25',
      assetCode: 'XLM',
      assetIssuer: null,
      destination: FEE_PAYER.publicKey(),
    })
    ;(retryWebReserveRelease as jest.Mock).mockResolvedValue({
      released: true,
      txHash: 'b'.repeat(64),
    })

    const user = userEvent.setup()
    render(<ClaimLinkPage />)

    await screen.findByTestId('web-claim-amount')
    await user.click(screen.getByTestId('web-claim-submit'))

    // Warning visible, error shown, and `#s=` hash MUST stay intact until release succeeds.
    expect((await screen.findByTestId('web-claim-reserve-warning')).textContent).toContain(
      '1 XLM sponsor reserve',
    )
    expect(screen.getByTestId('web-claim-reserve-error').textContent).toContain(
      'Horizon 504 on accountMerge',
    )
    expect(window.location.hash).toContain(encodeURIComponent(EPHEMERAL.secret()))

    await user.click(screen.getByTestId('web-claim-retry-reserve'))

    expect(retryWebReserveRelease).toHaveBeenCalledWith({
      ephemeralSecret: EPHEMERAL.secret(),
    })
    expect((await screen.findByTestId('web-claim-reserve-released')).textContent).toContain(
      '1 XLM sponsor reserve released',
    )
    expect(screen.queryByTestId('web-claim-reserve-warning')).toBeNull()
    expect(window.location.hash).toBe('')
  })

  it('labels an impostor USDC from an unknown issuer as Unverified asset with NO icon', async () => {
    walletLocal.setItem('invisible_wallet_address', 'C_TEST_WALLET')
    ;(inspectWebClaimLink as jest.Mock).mockResolvedValue({
      status: 'claimable',
      balanceId: BALANCE_ID,
      amount: '100',
      assetCode: 'USDC',
      assetIssuer: FAKE_ISSUER,
      sponsor: SENDER.publicKey(),
      claimantAddresses: [EPHEMERAL.publicKey()],
      expiresAt: 1_900_000_000,
      expired: false,
      expiryLabel: 'Claim within 7d',
      isVerifiedAsset: false,
      verifiedAssetName: null,
      verifiedIssuerName: null,
    })

    const { container } = render(<ClaimLinkPage />)

    expect((await screen.findByTestId('web-claim-verification-badge')).textContent).toBe(
      'Unverified asset',
    )
    expect(screen.getByTestId('web-claim-unverified-warning').textContent).toMatch(
      /not in Veil’s verified registry/i,
    )
    // Zero token icons rendered inside <main> for an unverified asset.
    expect(container.querySelectorAll('main img')).toHaveLength(0)
  })

  it('renders network_mismatch and not_found states without reporting the link as claimed', async () => {
    ;(inspectWebClaimLink as jest.Mock).mockResolvedValueOnce({
      status: 'network_mismatch',
      balanceId: BALANCE_ID,
      linkNetwork: 'mainnet',
      activeNetwork: 'testnet',
      canSwitch: true,
      message:
        'This link was created on Stellar Mainnet, while your wallet is set to Stellar Testnet.',
    })

    const { unmount } = render(<ClaimLinkPage />)
    expect(await screen.findByTestId('web-claim-network-mismatch')).not.toBeNull()
    expect(screen.queryByText(/already been claimed/i)).toBeNull()
    unmount()

    ;(inspectWebClaimLink as jest.Mock).mockResolvedValueOnce({
      status: 'not_found',
      balanceId: BALANCE_ID,
      message: 'No claimable balance with this ID was found on Stellar Testnet.',
    })
    render(<ClaimLinkPage />)
    expect(await screen.findByTestId('web-claim-not-found')).not.toBeNull()
    expect(screen.queryByText(/already been claimed/i)).toBeNull()
  })

  it('offers existing Create wallet and Recover routes when no wallet exists in this browser', async () => {
    ;(peekFeePayerKeypair as jest.Mock).mockReturnValue(null)
    ;(ensureFeePayer as jest.Mock).mockResolvedValue(null)
    ;(inspectWebClaimLink as jest.Mock).mockResolvedValue({
      status: 'claimable',
      balanceId: BALANCE_ID,
      amount: '10',
      assetCode: 'XLM',
      assetIssuer: null,
      sponsor: SENDER.publicKey(),
      claimantAddresses: [EPHEMERAL.publicKey()],
      expiresAt: 1_900_000_000,
      expired: false,
      expiryLabel: 'Claim within 7d',
      isVerifiedAsset: true,
      verifiedAssetName: 'Stellar Lumens',
      verifiedIssuerName: 'Stellar',
    })

    render(<ClaimLinkPage />)

    const onboardingCard = await screen.findByTestId('web-claim-onboarding')
    expect(onboardingCard).not.toBeNull()
    expect(screen.getByRole('button', { name: 'Create wallet' })).not.toBeNull()
    expect(screen.getByRole('button', { name: 'Recover existing wallet' })).not.toBeNull()
  })
})
