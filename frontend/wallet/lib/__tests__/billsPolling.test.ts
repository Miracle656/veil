import { webcrypto } from 'crypto'
import { TextEncoder, TextDecoder } from 'util'

Object.defineProperty(globalThis, 'crypto', { value: webcrypto, configurable: true, writable: true })
Object.assign(globalThis, { TextEncoder, TextDecoder })

import {
  BillPoller,
  MAX_CONSECUTIVE_POLL_ERRORS,
  MAX_POLL_ATTEMPTS,
  POLL_INTERVAL_MS,
} from '../billPolling'
import type { BillStatus } from '../ngn'

describe('BillPoller (V276 status resolution)', () => {
  const customerRef = 'veil_cust_123'
  const orderId = 'ord_airtime_789'

  let mockGetBillStatus: jest.Mock
  let onDone: jest.Mock
  let onFailed: jest.Mock
  let onUnconfirmed: jest.Mock
  let onErrorCountChange: jest.Mock

  beforeEach(() => {
    jest.useFakeTimers()
    mockGetBillStatus = jest.fn()
    onDone = jest.fn()
    onFailed = jest.fn()
    onUnconfirmed = jest.fn()
    onErrorCountChange = jest.fn()
  })

  afterEach(() => {
    jest.useRealTimers()
  })

  function createPoller() {
    return new BillPoller(
      customerRef,
      orderId,
      { onDone, onFailed, onUnconfirmed, onErrorCountChange },
      mockGetBillStatus,
    )
  }

  it('drives real provider status value "completed" to done state', async () => {
    const status: BillStatus = {
      orderId,
      customerRef,
      status: 'completed',
      billCategory: 'airtime',
      amountNgn: 1000,
      amountStableCoin: 0.67,
      wallet: 'GB3JS2AJZ3FKIGVOOPXDEYYR3XOHQA474WGCYAMNFSGX6OW5HGWCKUZW',
      description: 'MTN 1000',
    }
    mockGetBillStatus.mockResolvedValue(status)

    const poller = createPoller()
    poller.start()

    // Immediate check runs
    await Promise.resolve()
    expect(mockGetBillStatus).toHaveBeenCalledWith(customerRef, orderId)
    expect(onDone).toHaveBeenCalledWith(status)
    expect(onFailed).not.toHaveBeenCalled()
    expect(onUnconfirmed).not.toHaveBeenCalled()
  })

  it('visibly retries when a poll errors, distinguishing it from pending', async () => {
    mockGetBillStatus.mockRejectedValueOnce(new Error('Network error'))

    const poller = createPoller()
    poller.start()

    // 1st attempt fails
    await Promise.resolve()
    expect(onErrorCountChange).toHaveBeenCalledWith(1)
    expect(onUnconfirmed).not.toHaveBeenCalled()

    // 2nd attempt succeeds with 'completed'
    const status: BillStatus = {
      orderId,
      customerRef,
      status: 'completed',
      billCategory: 'airtime',
      amountNgn: 1000,
      amountStableCoin: 0.67,
      wallet: 'GB3JS2AJZ3FKIGVOOPXDEYYR3XOHQA474WGCYAMNFSGX6OW5HGWCKUZW',
      description: 'MTN 1000',
    }
    mockGetBillStatus.mockResolvedValueOnce(status)

    jest.advanceTimersByTime(POLL_INTERVAL_MS)
    await Promise.resolve()

    expect(onErrorCountChange).toHaveBeenCalledWith(0)
    expect(onDone).toHaveBeenCalledWith(status)
    expect(onUnconfirmed).not.toHaveBeenCalled()
  })

  it('gives up after consecutive poll errors and transitions to unconfirmed with reason error', async () => {
    mockGetBillStatus.mockRejectedValue(new Error('Gateway timeout 504'))

    const poller = createPoller()
    poller.start()

    // 1st error
    await Promise.resolve()
    expect(mockGetBillStatus).toHaveBeenCalledTimes(1)
    expect(onErrorCountChange).toHaveBeenCalledWith(1)

    // 2nd error
    jest.advanceTimersByTime(POLL_INTERVAL_MS)
    await Promise.resolve()
    expect(mockGetBillStatus).toHaveBeenCalledTimes(2)
    expect(onErrorCountChange).toHaveBeenCalledWith(2)

    // 3rd error (hits MAX_CONSECUTIVE_POLL_ERRORS = 3)
    jest.advanceTimersByTime(POLL_INTERVAL_MS)
    await Promise.resolve()
    expect(mockGetBillStatus).toHaveBeenCalledTimes(3)
    expect(onErrorCountChange).toHaveBeenCalledWith(3)

    // Gives up: moves to unconfirmed with reason 'error'
    expect(onUnconfirmed).toHaveBeenCalledWith('error')
    expect(onDone).not.toHaveBeenCalled()
    // MUST NOT tell the user it failed
    expect(onFailed).not.toHaveBeenCalled()

    // Further timer advances do not trigger more calls
    jest.advanceTimersByTime(POLL_INTERVAL_MS * 5)
    expect(mockGetBillStatus).toHaveBeenCalledTimes(3)
  })

  it('enforces a bounded wait and moves to unconfirmed with reason timeout after max attempts', async () => {
    mockGetBillStatus.mockResolvedValue({
      orderId,
      customerRef,
      status: 'pending',
      billCategory: 'airtime',
      amountNgn: 1000,
      amountStableCoin: 0.67,
      wallet: 'GB3JS2AJZ3FKIGVOOPXDEYYR3XOHQA474WGCYAMNFSGX6OW5HGWCKUZW',
      description: 'MTN 1000',
    })

    const poller = createPoller()
    poller.start()

    // Check 1 runs immediately
    await Promise.resolve()
    expect(mockGetBillStatus).toHaveBeenCalledTimes(1)

    // Advance through the remaining attempts up to MAX_POLL_ATTEMPTS (12)
    for (let i = 2; i <= MAX_POLL_ATTEMPTS; i++) {
      jest.advanceTimersByTime(POLL_INTERVAL_MS)
      await Promise.resolve()
      expect(mockGetBillStatus).toHaveBeenCalledTimes(i)
    }

    // Bounded wait reached
    expect(onUnconfirmed).toHaveBeenCalledWith('timeout')
    expect(onDone).not.toHaveBeenCalled()
    expect(onFailed).not.toHaveBeenCalled()

    // No further calls
    jest.advanceTimersByTime(POLL_INTERVAL_MS * 5)
    expect(mockGetBillStatus).toHaveBeenCalledTimes(MAX_POLL_ATTEMPTS)
  })

  it('allows manual check status from unconfirmed and transitions to done if completed', async () => {
    const poller = createPoller()

    mockGetBillStatus.mockResolvedValue({
      orderId,
      customerRef,
      status: 'completed',
      billCategory: 'airtime',
      amountNgn: 1000,
      amountStableCoin: 0.67,
      wallet: 'GB3JS2AJZ3FKIGVOOPXDEYYR3XOHQA474WGCYAMNFSGX6OW5HGWCKUZW',
      description: 'MTN 1000',
    })

    const result = await poller.manualCheck()
    expect(result).toBe('done')
    expect(onDone).toHaveBeenCalled()
  })
})
