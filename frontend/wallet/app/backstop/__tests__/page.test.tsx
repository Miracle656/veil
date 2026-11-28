/**
 * The backstop screen.
 *
 * What matters here is that nothing is signed that the user was not shown, and
 * that the screen never guesses when it cannot see the position:
 *   1. Before the first deposit it says what the position is, in the wallet's
 *      own words, instead of showing a zero balance with no explanation.
 *   2. The share value and the emissions are different numbers from different
 *      sources, and they must not be merged into one "total".
 *   3. Deposit, queue, cancel and withdraw each stop at a review step that
 *      repeats the amount, the unit and any unlock date before the passkey.
 *   4. The queue limit for a cancel is the queued shares, not the balance.
 *   5. A position that failed to load blocks Deposit and never reads as
 *      "nothing at risk".
 *
 * The real transaction construction (contract invocation, footprint, auth
 * entries) is proved against the actual SDK in `lib/__tests__/backstop.test.ts`;
 * this suite mocks `lib/backstop` because rendering the screen in jsdom must not
 * talk to an RPC, and asserts what the screen asks for and what it refuses.
 *
 * The amount and date helpers are *not* mocked: `lib/backstopAmounts.ts` has no
 * SDK import, so the formatting asserted here is the implementation that ships
 * rather than a copy of it kept in step by hand.
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
  // 4 shares queued, still locked.
  queued: [{ shares: 40_000_000n, exp: 1_900_000_000 }],
  queuedShares: 40_000_000n,
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
  queuedShares: 0n,
  unlockedShares: 0n,
}

const LOCK_SECONDS = 17 * 24 * 60 * 60
const FULL_TX_HASH =
  'f1e2d3c4b5a6978877665544332211ffeeddccbbaa99887766554433221100ff'

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
    displayName: 'Stellar Mainnet',
    rpcUrl: 'https://rpc.invalid',
    horizonUrl: 'https://horizon.invalid',
    networkPassphrase: 'Public Global Stellar Network ; September 2015',
  }),
}))

const mockSignAndSubmit = jest.fn().mockResolvedValue(FULL_TX_HASH)
jest.mock('@/lib/sorobanTx', () => ({
  signAndSubmitSorobanXdr: (...args: unknown[]) => mockSignAndSubmit(...args),
}))

jest.mock('@/lib/blend', () => ({
  configuredPoolIds: () => ['CAJJZSGMMM3PD7N33TAPHGBUGTB43OC73HVIK2L2G6BNGGGYOSSYBXBD'],
}))

const mockIsBackstopEnabled = jest.fn().mockReturnValue(true)
jest.mock('@/lib/backstopFeature', () => ({
  isBackstopEnabled: (...args: unknown[]) => mockIsBackstopEnabled(...args),
}))

const mockLoadPositions = jest.fn()
const mockLoadQueueLock = jest.fn()
const mockPreflight = jest.fn()
const mockDeposit = jest.fn().mockResolvedValue('deposit-xdr')
const mockQueue = jest.fn().mockResolvedValue('queue-xdr')
const mockCancel = jest.fn().mockResolvedValue('cancel-xdr')
const mockWithdraw = jest.fn().mockResolvedValue('withdraw-xdr')

// The real module pulls @blend-capital/blend-sdk, whose nested
// @stellar/stellar-sdk ships ESM that this Jest config does not transform, so
// the ledger reads and the XDR builders are mocked here and covered against the
// real implementation in lib/__tests__/backstop.test.ts. The amount and date
// helpers come from the real `@/lib/backstopAmounts`, which imports no SDK.
jest.mock('@/lib/backstop', () => ({
  configuredBackstopId: () => 'CAQQR5SWBXKIGZKPBZDH3KM5GQ5GUTPKB7JAFCINLZBC5WXPJKRG3IM7',
  loadBackstopPositions: (...args: unknown[]) => mockLoadPositions(...args),
  loadBackstopQueueLockSeconds: (...args: unknown[]) => mockLoadQueueLock(...args),
  runBackstopPreflight: (...args: unknown[]) => mockPreflight(...args),
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
  mockLoadPositions.mockResolvedValue({ positions: [POSITION], failedPoolIds: [] })
  mockLoadQueueLock.mockResolvedValue(LOCK_SECONDS)
  mockPreflight.mockResolvedValue({
    ok: true,
    problems: [],
    xlmBalance: 100,
    requiredXlm: 1.01,
    lpBalance: '5000',
  })
  mockIsBackstopEnabled.mockReturnValue(true)
})

async function renderPage() {
  render(<BackstopPage />)
  await waitFor(() => expect(screen.getByText('Your position')).toBeTruthy())
}

/** The review step's confirm button only enables once the pre-flight clears. */
async function waitForConfirm() {
  await waitFor(() =>
    expect(
      (screen.getByRole('button', { name: 'Confirm and sign' }) as HTMLButtonElement).disabled,
    ).toBe(false),
  )
}

describe('feature flag', () => {
  it('does not open the screen where the flag is off', async () => {
    mockIsBackstopEnabled.mockReturnValue(false)
    render(<BackstopPage />)

    await waitFor(() =>
      expect(screen.getByText(/Backstop is not available on Stellar Mainnet yet/i)).toBeTruthy(),
    )
    expect(screen.queryByText('Your position')).toBeNull()
    expect(mockLoadPositions).not.toHaveBeenCalled()
  })
})

describe('before the first deposit', () => {
  it('states what the position is and that nothing is at risk yet', async () => {
    mockLoadPositions.mockResolvedValue({ positions: [EMPTY_POSITION], failedPoolIds: [] })
    await renderPage()

    expect(screen.getByText('What this position is')).toBeTruthy()
    expect(screen.getByText(/first-loss capital for a Blend lending pool/i)).toBeTruthy()
    expect(
      screen.getByText(/You have no backstop position in this pool yet, so nothing of yours is at risk here/i),
    ).toBeTruthy()
    expect(screen.getByText('no deposit')).toBeTruthy()
  })
})

describe('a position that failed to load', () => {
  it('says so, never says "nothing at risk", and disables Deposit', async () => {
    mockLoadPositions.mockResolvedValue({ positions: [], failedPoolIds: [POSITION.poolId] })
    await renderPage()

    expect(screen.getByText(/could not load your backstop position/i)).toBeTruthy()
    expect(screen.queryByText(/nothing of yours is at risk/i)).toBeNull()
    expect(screen.queryByText('no deposit')).toBeNull()
    expect((screen.getByRole('button', { name: 'Deposit' }) as HTMLButtonElement).disabled).toBe(
      true,
    )
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

  it('shows queued entries in shares, the unit the contract takes', async () => {
    await renderPage()
    expect(screen.getByText('4 shares')).toBeTruthy()
    expect(screen.getByText('4 shares queued')).toBeTruthy()
    expect(screen.getByText('locked')).toBeTruthy()
    // LP-token wording for the queue was the units bug.
    expect(screen.queryByText('4 LP')).toBeNull()
  })

  it('does not pay a contract round trip for the queue lock until a queue starts', async () => {
    mockLoadQueueLock.mockResolvedValue(3 * 24 * 60 * 60)
    const user = userEvent.setup()
    await renderPage()

    // Rendering the position is one ledger read; the lock is not a second one.
    expect(mockLoadQueueLock).not.toHaveBeenCalled()
    // And with no lock read there is no duration to print: the view screen
    // says "the queue lock" rather than quoting the 17-day fallback as fact.
    expect(screen.queryByText(/17 days/)).toBeNull()
    expect(screen.getByText(/wait out the queue lock, then withdraw/i)).toBeTruthy()

    await user.click(screen.getByRole('button', { name: 'Queue withdrawal' }))
    await waitFor(() => expect(mockLoadQueueLock).toHaveBeenCalledTimes(1))

    // And what it renders is the contract's lock, not the 17-day fallback.
    await waitFor(() =>
      expect(screen.getByText(/stay in the backstop for 3 days/i)).toBeTruthy(),
    )
  })
})

describe('the confirm step', () => {
  it('shows amount and unit before any deposit is signed', async () => {
    const user = userEvent.setup()
    await renderPage()

    await user.click(screen.getByRole('button', { name: 'Deposit' }))
    await user.type(screen.getByLabelText(/Deposit amount/i), '12.5')
    await user.click(screen.getByRole('button', { name: 'Review deposit' }))

    // The review step is shown and nothing has been built or signed yet.
    expect(screen.getByText('Unit')).toBeTruthy()
    expect(screen.getByText('BLND:USDC LP tokens')).toBeTruthy()
    expect(screen.getByText('12.5')).toBeTruthy()
    expect(mockDeposit).not.toHaveBeenCalled()
    expect(mockSignAndSubmit).not.toHaveBeenCalled()

    await waitForConfirm()
    await user.click(screen.getByRole('button', { name: 'Confirm and sign' }))

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

  it('shows the unlock date when queueing, before signing', async () => {
    const user = userEvent.setup()
    await renderPage()

    await user.click(screen.getByRole('button', { name: 'Queue withdrawal' }))
    await user.type(screen.getByLabelText(/Queue amount/i), '5')
    await user.click(screen.getByRole('button', { name: 'Review queue' }))

    expect(screen.getByText('Unlocks')).toBeTruthy()
    expect(screen.getByText(/in 17 days/)).toBeTruthy()
    expect(screen.getByText('backstop shares')).toBeTruthy()
    expect(mockQueue).not.toHaveBeenCalled()

    await waitForConfirm()
    await user.click(screen.getByRole('button', { name: 'Confirm and sign' }))

    await waitFor(() => expect(mockQueue).toHaveBeenCalledTimes(1))
    expect(mockQueue.mock.calls[0][0]).toMatchObject({ amountStroops: 50_000_000n })
  })
})

describe('the withdraw and cancel split', () => {
  it('limits a cancel to the queued shares, not the un-queued balance', async () => {
    const user = userEvent.setup()
    await renderPage()

    await user.click(screen.getByRole('button', { name: 'Manage queue' }))

    const cancel = screen.getByRole('button', { name: 'Review cancel' }) as HTMLButtonElement
    const cancelInput = screen.getByLabelText(/Cancel amount/i)

    // 5 shares is above the 4 queued but well below the 25 deposited.
    await user.type(cancelInput, '5')
    expect(cancel.disabled).toBe(true)

    await user.clear(cancelInput)
    await user.type(cancelInput, '4')
    expect(cancel.disabled).toBe(false)

    await user.clear(cancelInput)
    await user.type(cancelInput, '4')
    await user.click(cancel)
    await waitForConfirm()
    await user.click(screen.getByRole('button', { name: 'Confirm and sign' }))

    await waitFor(() => expect(mockCancel).toHaveBeenCalledTimes(1))
    expect(mockCancel.mock.calls[0][0]).toMatchObject({ amountStroops: 40_000_000n })
  })

  it('gives withdraw its own input, limited to unlocked shares', async () => {
    mockLoadPositions.mockResolvedValue({
      positions: [{ ...POSITION, unlockedShares: 40_000_000n }],
      failedPoolIds: [],
    })
    const user = userEvent.setup()
    await renderPage()

    await user.click(screen.getByRole('button', { name: 'Manage queue' }))
    await user.click(screen.getByRole('button', { name: 'Use all unlockable' }))
    await user.click(screen.getByRole('button', { name: 'Review withdraw' }))

    expect(screen.getByText('now — the lock has expired')).toBeTruthy()
    await waitForConfirm()
    await user.click(screen.getByRole('button', { name: 'Confirm and sign' }))

    await waitFor(() => expect(mockWithdraw).toHaveBeenCalledTimes(1))
    expect(mockWithdraw.mock.calls[0][0]).toMatchObject({ amountStroops: 40_000_000n })
  })

  it('cannot withdraw while nothing is unlocked', async () => {
    const user = userEvent.setup()
    await renderPage()

    await user.click(screen.getByRole('button', { name: 'Manage queue' }))
    await user.type(screen.getByLabelText(/Withdraw amount/i), '4')
    expect(
      (screen.getByRole('button', { name: 'Review withdraw' }) as HTMLButtonElement).disabled,
    ).toBe(true)
  })
})

describe('pre-flight', () => {
  it('blocks the signature when the fee or LP balance check fails', async () => {
    mockPreflight.mockResolvedValue({
      ok: false,
      problems: ['This deposit needs 12.5 BLND:USDC LP tokens and you hold 2.'],
      xlmBalance: 100,
      requiredXlm: 1.01,
      lpBalance: '2',
    })
    const user = userEvent.setup()
    await renderPage()

    await user.click(screen.getByRole('button', { name: 'Deposit' }))
    await user.type(screen.getByLabelText(/Deposit amount/i), '12.5')
    await user.click(screen.getByRole('button', { name: 'Review deposit' }))

    await waitFor(() =>
      expect(
        screen.getByText(/This deposit needs 12.5 BLND:USDC LP tokens and you hold 2\./),
      ).toBeTruthy(),
    )
    expect(
      (screen.getByRole('button', { name: 'Confirm and sign' }) as HTMLButtonElement).disabled,
    ).toBe(true)
    expect(mockDeposit).not.toHaveBeenCalled()
    expect(mockSignAndSubmit).not.toHaveBeenCalled()
  })
})

describe('the success screen', () => {
  it('shows the full, untruncated transaction hash', async () => {
    const user = userEvent.setup()
    await renderPage()

    await user.click(screen.getByRole('button', { name: 'Deposit' }))
    await user.type(screen.getByLabelText(/Deposit amount/i), '1')
    await user.click(screen.getByRole('button', { name: 'Review deposit' }))
    await waitForConfirm()
    await user.click(screen.getByRole('button', { name: 'Confirm and sign' }))

    await waitFor(() =>
      expect(screen.getByText('Backstop transaction submitted')).toBeTruthy(),
    )
    expect(screen.getByText(FULL_TX_HASH)).toBeTruthy()
    expect(screen.queryByText(/…/)).toBeNull()
  })
})
