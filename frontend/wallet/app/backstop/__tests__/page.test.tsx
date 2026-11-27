/**
 * The backstop screen.
 *
 * Three things matter here and none of them is layout:
 *   1. Before the first deposit the screen has to say what the position is, in
 *      the wallet's own words, instead of showing a zero balance with no
 *      explanation.
 *   2. The share value and the emissions are different numbers from different
 *      sources, and they must not be merged into one "total".
 *   3. Deposit, queue, cancel and withdraw each route to their own contract
 *      call, with the amount the user typed.
 */
import { webcrypto } from 'crypto'
import { TextEncoder, TextDecoder } from 'util'
Object.defineProperty(globalThis, 'crypto', { value: webcrypto, configurable: true, writable: true })
Object.assign(globalThis, { TextEncoder, TextDecoder })

// The Jest tsconfig compiles JSX with the classic runtime, so React has to be
// in scope here even though the component does not reference it.
import React from 'react'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'

const POSITION = {
  backstopId: 'CAQQR5SWBXKIGZKPBZDH3KM5GQ5GUTPKB7JAFCINLZBC5WXPJKRG3IM7',
  poolId: 'CAJJZSGMMM3PD7N33TAPHGBUGTB43OC73HVIK2L2G6BNGGGYOSSYBXBD',
  userId: 'GCEV7YTFLBCU3BYZRHEZRNPXCEWG7OCRBA7TVK2664KJRNVSIVYILJRK',
  shares: 250_000_000n,
  shareValue: 31.4021,
  blnd: 25.1217,
  usdc: 6.2804,
  emissions: 2.75,
  queued: [{ amount: 4, exp: 1_900_000_000 }],
  totalQueued: 4,
  unlockedQueued: 0,
  unlockedShares: 0n,
}

const EMPTY_POSITION = {
  ...POSITION,
  shares: 0n,
  shareValue: 0,
  blnd: 0,
  usdc: 0,
  emissions: 0,
  queued: [],
  totalQueued: 0,
  unlockedQueued: 0,
  unlockedShares: 0n,
}

const mockStore = new Map<string, string>()
jest.mock('@/lib/walletStorage', () => ({
  walletSession: {
    getItem: (key: string) => mockStore.get(key) ?? null,
    setItem: (key: string, value: string) => void mockStore.set(key, value),
  },
  walletLocal: {
    getItem: (key: string) => mockStore.get(key) ?? null,
    setItem: (key: string, value: string) => void mockStore.set(key, value),
  },
}))

jest.mock('@/hooks/useInactivityLock', () => ({ useInactivityLock: () => undefined }))
jest.mock('@/lib/passkeyAuth', () => ({ requirePasskey: jest.fn().mockResolvedValue(undefined) }))
jest.mock('@/lib/txState', () => ({ beginTx: jest.fn(), endTx: jest.fn() }))
jest.mock('@/lib/network', () => ({
  getNetwork: () => ({
    name: 'mainnet',
    displayName: 'Mainnet',
    rpcUrl: 'https://rpc.invalid',
    networkPassphrase: 'Public Global Stellar Network ; September 2015',
  }),
}))

const mockSignAndSubmit = jest.fn().mockResolvedValue('abc123hash')
jest.mock('@/lib/sorobanTx', () => ({
  signAndSubmitSorobanXdr: (...args: unknown[]) => mockSignAndSubmit(...args),
}))

jest.mock('@/lib/blend', () => ({
  configuredPoolIds: () => ['CAJJZSGMMM3PD7N33TAPHGBUGTB43OC73HVIK2L2G6BNGGGYOSSYBXBD'],
}))

const mockLoadPositions = jest.fn()
const mockDeposit = jest.fn().mockResolvedValue('deposit-xdr')
const mockQueue = jest.fn().mockResolvedValue('queue-xdr')
const mockCancel = jest.fn().mockResolvedValue('cancel-xdr')
const mockWithdraw = jest.fn().mockResolvedValue('withdraw-xdr')
// The real module pulls @blend-capital/blend-sdk, whose nested
// @stellar/stellar-sdk ships ESM that this Jest config does not transform. The
// amount conversion is covered against the real implementation in
// lib/__tests__/backstop.test.ts; here it only has to behave the same way.
jest.mock('@/lib/backstop', () => ({
  configuredBackstopId: () => 'CAQQR5SWBXKIGZKPBZDH3KM5GQ5GUTPKB7JAFCINLZBC5WXPJKRG3IM7',
  sharesToStroops: (value: string) => {
    const [whole, fraction = ''] = value.trim().split('.')
    return BigInt(whole) * 10_000_000n + BigInt(fraction.padEnd(7, '0'))
  },
  stroopsToShares: (stroops: bigint) => (Number(stroops) / 1e7).toString(),
  loadBackstopPositions: (...args: unknown[]) => mockLoadPositions(...args),
  buildBackstopDepositXdr: (...args: unknown[]) => mockDeposit(...args),
  buildBackstopQueueWithdrawalXdr: (...args: unknown[]) => mockQueue(...args),
  buildBackstopCancelWithdrawalXdr: (...args: unknown[]) => mockCancel(...args),
  buildBackstopWithdrawXdr: (...args: unknown[]) => mockWithdraw(...args),
}))

import BackstopPage from '../page'

// A throwaway keypair, so the screen can resolve the signing address the same
// way it does in the browser. Nothing is signed: sorobanTx is mocked.
const USER = POSITION.userId
const TEST_SECRET = 'SDXVG52HFEC5ILTOSZX3FFWA24VFNKUFWBZGBIFSFRHH4432A37UEJPT'

beforeEach(() => {
  jest.clearAllMocks()
  mockStore.clear()
  mockStore.set('invisible_wallet_address', USER)
  // The page resolves the signing address from this key.
  mockStore.set('veil_signer_secret', TEST_SECRET)
  mockStore.set('veil_signer_public_key', USER)
  mockLoadPositions.mockResolvedValue([POSITION])
})

async function renderPage() {
  render(<BackstopPage />)
  await waitFor(() => expect(screen.getByText('Your position')).toBeTruthy())
}

describe('before the first deposit', () => {
  it('states what the position is and that nothing is at risk yet', async () => {
    mockLoadPositions.mockResolvedValue([EMPTY_POSITION])
    await renderPage()

    expect(screen.getByText('What this position is')).toBeTruthy()
    expect(
      screen.getByText(/first-loss capital for a Blend lending pool/i),
    ).toBeTruthy()
    expect(
      screen.getByText(/You have no backstop position in this pool yet, so nothing of yours is at risk here/i),
    ).toBeTruthy()
    expect(screen.getByText('no deposit')).toBeTruthy()
  })
})

describe('position display', () => {
  it('shows the current share value, not the deposited amount', async () => {
    await renderPage()
    expect(screen.getByText('31.4021')).toBeTruthy()
    expect(screen.getByText('LP tokens · current share value')).toBeTruthy()
  })

  it('shows emissions as a separate figure, not folded into the value', async () => {
    await renderPage()
    expect(screen.getByText('2.75 BLND')).toBeTruthy()
    expect(screen.getByText('Emissions earned')).toBeTruthy()
    expect(screen.getByText('separate')).toBeTruthy()
    // 31.4021 + 2.75 would be the merged figure; it must not appear anywhere.
    expect(screen.queryByText('34.1521')).toBeNull()
  })

  it('shows each queued entry with its lock state', async () => {
    await renderPage()
    expect(screen.getByText('4 LP')).toBeTruthy()
    expect(screen.getByText('locked')).toBeTruthy()
    expect(screen.getByText('4 LP queued')).toBeTruthy()
  })
})

describe('the deposit and withdrawal cycle', () => {
  it('deposits the amount the user typed', async () => {
    const user = userEvent.setup()
    await renderPage()

    await user.click(screen.getByRole('button', { name: 'Deposit' }))
    await user.type(screen.getByPlaceholderText('0.00'), '12.5')
    await user.click(screen.getByRole('button', { name: 'Deposit' }))

    await waitFor(() => expect(mockDeposit).toHaveBeenCalledTimes(1))
    expect(mockDeposit.mock.calls[0][0]).toMatchObject({
      poolId: POSITION.poolId,
      from: USER,
      sourceAddress: USER,
      amountStroops: 125_000_000n,
    })
    // Signed through the wallet's single Soroban path, with the XDR it built.
    expect(mockSignAndSubmit).toHaveBeenCalledWith(
      expect.objectContaining({ xdr: 'deposit-xdr' }),
    )
    await waitFor(() =>
      expect(screen.getByText('Backstop transaction submitted')).toBeTruthy(),
    )
  })

  it('queues shares for withdrawal', async () => {
    const user = userEvent.setup()
    await renderPage()

    await user.click(screen.getByRole('button', { name: 'Queue withdrawal' }))
    await user.click(screen.getByRole('button', { name: 'Use all' }))
    await user.click(screen.getByRole('button', { name: 'Queue' }))

    await waitFor(() => expect(mockQueue).toHaveBeenCalledTimes(1))
    expect(mockQueue.mock.calls[0][0]).toMatchObject({ amountStroops: 250_000_000n })
  })

  it('cancels a queued withdrawal', async () => {
    const user = userEvent.setup()
    await renderPage()

    await user.click(screen.getByRole('button', { name: 'Manage queue' }))
    await user.type(screen.getByPlaceholderText('0.00'), '4')
    await user.click(screen.getByRole('button', { name: 'Cancel queued shares' }))

    await waitFor(() => expect(mockCancel).toHaveBeenCalledTimes(1))
    expect(mockCancel.mock.calls[0][0]).toMatchObject({ amountStroops: 40_000_000n })
  })

  it('withdraws unlocked shares', async () => {
    // 4 LP unlocked: the queue has been through its 17-day lock.
    mockLoadPositions.mockResolvedValue([
      { ...POSITION, unlockedQueued: 4, unlockedShares: 40_000_000n },
    ])
    const user = userEvent.setup()
    await renderPage()

    await user.click(screen.getByRole('button', { name: 'Manage queue' }))
    await user.click(screen.getByRole('button', { name: 'Use all withdrawable' }))
    await user.click(screen.getByRole('button', { name: 'Withdraw' }))

    await waitFor(() => expect(mockWithdraw).toHaveBeenCalledTimes(1))
    expect(mockWithdraw.mock.calls[0][0]).toMatchObject({ amountStroops: 40_000_000n })
  })

  it('cannot withdraw while nothing is unlocked', async () => {
    const user = userEvent.setup()
    await renderPage()

    await user.click(screen.getByRole('button', { name: 'Manage queue' }))
    await user.type(screen.getByPlaceholderText('0.00'), '4')
    expect(
      (screen.getByRole('button', { name: 'Withdraw' }) as HTMLButtonElement).disabled,
    ).toBe(true)
  })
})
