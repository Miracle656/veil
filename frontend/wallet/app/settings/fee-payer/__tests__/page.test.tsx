import { TextEncoder, TextDecoder } from 'util'
Object.assign(globalThis, { TextEncoder, TextDecoder })

import * as React from 'react'
Object.assign(globalThis, { React })

import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { Keypair } from '@stellar/stellar-sdk'
import { useRouter } from 'next/navigation'
import { useInactivityLock } from '@/hooks/useInactivityLock'
import {
  ensureFeePayer,
  peekFeePayerKeypair,
  getFeePayerMode,
  getFeePayerDiagnostics,
  isFeePayerPrfDowngrade,
  formatFeePayerDiagnostics,
  retryPrfFeePayer,
  type FeePayerMode,
  type FeePayerDiagnostics,
  type PrfRetryResult,
} from '@/lib/feePayer'
import FeePayerSettingsPage from '../page'

jest.mock('@/lib/feePayer')
jest.mock('next/navigation')
jest.mock('@/hooks/useInactivityLock')

describe('FeePayerSettingsPage interaction tests', () => {
  const mockPush = jest.fn()

  beforeEach(() => {
    jest.clearAllMocks()

    ;(useRouter as jest.Mock).mockReturnValue({
      push: mockPush,
      replace: jest.fn(),
      back: jest.fn(),
      forward: jest.fn(),
      prefetch: jest.fn(),
    })

    ;(useInactivityLock as jest.Mock).mockReturnValue(undefined)

    ;(ensureFeePayer as jest.Mock).mockResolvedValue(null)
    ;(peekFeePayerKeypair as jest.Mock).mockReturnValue(null)
    ;(getFeePayerMode as jest.Mock).mockReturnValue(null)
    ;(getFeePayerDiagnostics as jest.Mock).mockReturnValue(null)
    ;(isFeePayerPrfDowngrade as jest.Mock).mockReturnValue(false)
    ;(formatFeePayerDiagnostics as jest.Mock).mockReturnValue('')
    ;(retryPrfFeePayer as jest.Mock).mockResolvedValue({
      ok: false,
      reason: 'cancelled',
      message: 'Cancelled',
    })
  })

  // Test 1: on mount, ensureFeePayer is called exactly once with { passive: true }
  it('on mount, ensureFeePayer is called exactly once with { passive: true }', () => {
    render(<FeePayerSettingsPage />)

    expect(ensureFeePayer).toHaveBeenCalledTimes(1)
    expect(ensureFeePayer).toHaveBeenCalledWith(undefined, { passive: true })
    expect(retryPrfFeePayer).not.toHaveBeenCalled()
  })

  // Test 2: on mount, retryPrfFeePayer is not called
  it('on mount, retryPrfFeePayer is not called', () => {
    render(<FeePayerSettingsPage />)

    expect(retryPrfFeePayer).not.toHaveBeenCalled()
  })

  // Test 3: repair card shows when mode is random
  it('repair card shows when mode is random', async () => {
    ;(getFeePayerMode as jest.Mock).mockReturnValue('random')
    render(<FeePayerSettingsPage />)

    const cardHeading = await screen.findByText('Move this onto your passkey')
    expect(cardHeading).not.toBeNull()

    const retryButton = screen.getByRole('button', { name: 'Try your passkey again' })
    expect(retryButton).not.toBeNull()
  })

  // Test 4: repair card shows when mode is legacy
  it('repair card shows when mode is legacy', async () => {
    ;(getFeePayerMode as jest.Mock).mockReturnValue('legacy')
    render(<FeePayerSettingsPage />)

    const cardHeading = await screen.findByText('Is this the wrong address?')
    expect(cardHeading).not.toBeNull()

    const retryButton = screen.getByRole('button', { name: 'Try your passkey again' })
    expect(retryButton).not.toBeNull()
  })

  // Test 5: repair card does not show when mode is prf-raw
  it('repair card does not show when mode is prf-raw', async () => {
    const kp = Keypair.random()
    ;(peekFeePayerKeypair as jest.Mock).mockReturnValue(kp)
    ;(getFeePayerMode as jest.Mock).mockReturnValue('prf-raw')
    render(<FeePayerSettingsPage />)

    await screen.findByText('PRF (raw)')

    expect(screen.queryByText('Move this onto your passkey')).toBeNull()
    expect(screen.queryByText('Is this the wrong address?')).toBeNull()
    expect(screen.queryByRole('button', { name: 'Try your passkey again' })).toBeNull()
  })

  // Test 6: repair card does not show when mode is prf-hkdf
  it('repair card does not show when mode is prf-hkdf', async () => {
    const kp = Keypair.random()
    ;(peekFeePayerKeypair as jest.Mock).mockReturnValue(kp)
    ;(getFeePayerMode as jest.Mock).mockReturnValue('prf-hkdf')
    render(<FeePayerSettingsPage />)

    await screen.findByText('PRF (HKDF)')

    expect(screen.queryByText('Move this onto your passkey')).toBeNull()
    expect(screen.queryByText('Is this the wrong address?')).toBeNull()
    expect(screen.queryByRole('button', { name: 'Try your passkey again' })).toBeNull()
  })

  // Test 7: clicking "Try your passkey again" calls retryPrfFeePayer once and disables the button while it runs
  it('clicking "Try your passkey again" calls retryPrfFeePayer once and disables the button while it runs', async () => {
    const user = userEvent.setup()
    let resolveRetry!: (value: PrfRetryResult) => void
    const pendingPromise = new Promise<PrfRetryResult>((resolve) => {
      resolveRetry = resolve
    })
    ;(retryPrfFeePayer as jest.Mock).mockReturnValue(pendingPromise)
    ;(getFeePayerMode as jest.Mock).mockReturnValue('random')

    render(<FeePayerSettingsPage />)

    const button = await screen.findByRole('button', { name: 'Try your passkey again' })
    await user.click(button)

    expect(retryPrfFeePayer).toHaveBeenCalledTimes(1)
    expect((button as HTMLButtonElement).disabled).toBe(true)

    await React.act(async () => {
      resolveRetry({
        ok: false,
        reason: 'cancelled',
        message: 'Cancelled',
      })
    })
  })

  // Test 8: after a successful retry the success text stays on screen
  it('after a successful retry the success text stays on screen', async () => {
    const user = userEvent.setup()
    const oldKeypair = Keypair.random()
    const newKeypair = Keypair.random()

    let currentMode: FeePayerMode | null = 'random'
    ;(getFeePayerMode as jest.Mock).mockImplementation(() => currentMode)
    ;(peekFeePayerKeypair as jest.Mock).mockReturnValue(oldKeypair)

    const successResult: PrfRetryResult = {
      ok: true,
      mode: 'prf-raw',
      publicKey: newKeypair.publicKey(),
      previousPublicKey: oldKeypair.publicKey(),
      foundOnChain: false,
    }
    ;(retryPrfFeePayer as jest.Mock).mockImplementation(async () => {
      currentMode = 'prf-raw'
      return successResult
    })

    render(<FeePayerSettingsPage />)

    const button = await screen.findByRole('button', { name: 'Try your passkey again' })
    await user.click(button)

    const successMessage = await screen.findByRole('status')
    expect(successMessage).not.toBeNull()
    expect(successMessage.textContent).toBe(
      'Done. Your fee payer is now derived from your passkey, so any device with it can rebuild this account.',
    )
    expect(screen.queryByRole('button', { name: 'Try your passkey again' })).toBeNull()
  })

  // Test 9: a failed retry shows retry.message
  it('a failed retry shows retry.message', async () => {
    const user = userEvent.setup()
    ;(getFeePayerMode as jest.Mock).mockReturnValue('random')

    const failureResult: PrfRetryResult = {
      ok: false,
      reason: 'cancelled',
      message: 'The passkey prompt was dismissed, so nothing changed. Tap again and complete it.',
    }
    ;(retryPrfFeePayer as jest.Mock).mockResolvedValue(failureResult)

    render(<FeePayerSettingsPage />)

    const button = await screen.findByRole('button', { name: 'Try your passkey again' })
    await user.click(button)

    const statusEl = await screen.findByRole('status')
    expect(statusEl).not.toBeNull()
    expect(statusEl.textContent).toBe(failureResult.message)
  })

  // Test 10: the copy button writes the address to the clipboard
  it('the copy button writes the address to the clipboard', async () => {
    const user = userEvent.setup()
    const writeTextMock = jest.fn().mockResolvedValue(undefined)
    Object.defineProperty(navigator, 'clipboard', {
      value: { writeText: writeTextMock },
      writable: true,
      configurable: true,
    })

    const testKeypair = Keypair.random()
    const expectedAddress = testKeypair.publicKey()
    ;(peekFeePayerKeypair as jest.Mock).mockReturnValue(testKeypair)

    render(<FeePayerSettingsPage />)

    const copyButton = await screen.findByRole('button', { name: 'Copy fee payer address' })
    await user.click(copyButton)

    expect(writeTextMock).toHaveBeenCalledWith(expectedAddress)
  })
})
