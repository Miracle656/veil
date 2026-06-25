import { mapHorizonOpToEvent, createActivityFeed, type RawHorizonOp } from '../events'

jest.mock('@stellar/stellar-sdk', () => ({
  Horizon: {
    Server: jest.fn(),
  },
}))

const sdk = jest.requireMock('@stellar/stellar-sdk') as Record<string, any>
const MockHorizonServer: jest.Mock = sdk.Horizon.Server

function makeOp(overrides: Partial<RawHorizonOp> = {}): RawHorizonOp {
  return {
    id: '1',
    paging_token: 'pt-1',
    type: 'payment',
    from: 'GAAA',
    to: 'GBBB',
    amount: '10.0000000',
    asset_type: 'native',
    created_at: '2024-01-01T00:00:00Z',
    transaction_hash: 'abc123',
    ...overrides,
  }
}

const ACCOUNT_ID = 'GAAA'

// ── mapHorizonOpToEvent ────────────────────────────────────────────────────────

describe('mapHorizonOpToEvent', () => {
  it('maps an incoming native payment to payment_received', () => {
    const event = mapHorizonOpToEvent(makeOp({ from: 'GBBB', to: ACCOUNT_ID }), ACCOUNT_ID)
    expect(event).not.toBeNull()
    expect(event!.type).toBe('payment_received')
    expect(event!.amount).toBe('10.0000000')
    expect(event!.asset).toBe('XLM')
    expect(event!.counterparty).toBe('GBBB')
    expect(event!.hash).toBe('abc123')
    expect(event!.id).toBe('pt-1')
  })

  it('maps an outgoing native payment to payment_sent', () => {
    const event = mapHorizonOpToEvent(makeOp({ from: ACCOUNT_ID, to: 'GBBB' }), ACCOUNT_ID)
    expect(event!.type).toBe('payment_sent')
    expect(event!.counterparty).toBe('GBBB')
  })

  it('maps a non-native asset payment and sets the correct asset code', () => {
    const event = mapHorizonOpToEvent(
      makeOp({ from: 'GBBB', to: ACCOUNT_ID, asset_type: 'credit_alphanum4', asset_code: 'USDC' }),
      ACCOUNT_ID,
    )
    expect(event!.asset).toBe('USDC')
  })

  it('includes memo from nested transaction object', () => {
    const event = mapHorizonOpToEvent(
      makeOp({ from: 'GBBB', to: ACCOUNT_ID, transaction: { memo: 'invoice-42' } }),
      ACCOUNT_ID,
    )
    expect(event!.memo).toBe('invoice-42')
  })

  it('maps create_account to account_created', () => {
    const event = mapHorizonOpToEvent(
      makeOp({ type: 'create_account', funder: 'GFRIEND', starting_balance: '100.0000000' }),
      ACCOUNT_ID,
    )
    expect(event!.type).toBe('account_created')
    expect(event!.counterparty).toBe('GFRIEND')
    expect(event!.amount).toBe('100.0000000')
    expect(event!.asset).toBe('XLM')
  })

  it('defaults counterparty to "Friendbot" when funder is missing', () => {
    const event = mapHorizonOpToEvent(
      makeOp({ type: 'create_account', starting_balance: '1.0000000' }),
      ACCOUNT_ID,
    )
    expect(event!.counterparty).toBe('Friendbot')
  })

  it('maps path_payment_strict_send to path_payment with source and dest fields', () => {
    const event = mapHorizonOpToEvent(
      makeOp({
        type: 'path_payment_strict_send',
        source_asset_type: 'native',
        source_amount: '5.0000000',
        asset_type: 'credit_alphanum4',
        asset_code: 'USDC',
        amount: '4.9000000',
      }),
      ACCOUNT_ID,
    )
    expect(event!.type).toBe('path_payment')
    expect(event!.asset).toBe('XLM')
    expect(event!.amount).toBe('5.0000000')
    expect(event!.destAsset).toBe('USDC')
    expect(event!.destAmount).toBe('4.9000000')
    expect(event!.counterparty).toBe('Stellar DEX')
  })

  it('returns null for op types that are not tracked', () => {
    expect(mapHorizonOpToEvent(makeOp({ type: 'manage_buy_offer' }), ACCOUNT_ID)).toBeNull()
    expect(mapHorizonOpToEvent(makeOp({ type: 'set_options' }), ACCOUNT_ID)).toBeNull()
    expect(mapHorizonOpToEvent(makeOp({ type: 'change_trust' }), ACCOUNT_ID)).toBeNull()
  })

  it('sets timestamp from created_at', () => {
    const event = mapHorizonOpToEvent(
      makeOp({ created_at: '2024-06-15T12:00:00Z' }),
      ACCOUNT_ID,
    )
    expect(event!.timestamp).toBe(Math.floor(new Date('2024-06-15T12:00:00Z').getTime() / 1000))
  })
})

// ── createActivityFeed ────────────────────────────────────────────────────────

describe('createActivityFeed', () => {
  let capturedCallbacks: { onmessage?: (op: any) => void; onerror?: () => void }
  let capturedCursors: string[]
  let mockStopStream: jest.Mock
  let mockStreamFn: jest.Mock
  let mockCursorFn: jest.Mock

  beforeEach(() => {
    jest.useFakeTimers()
    jest.clearAllMocks()

    capturedCallbacks = {}
    capturedCursors = []
    mockStopStream = jest.fn()

    mockStreamFn = jest.fn().mockImplementation((cbs: any) => {
      capturedCallbacks = cbs
      return mockStopStream
    })

    mockCursorFn = jest.fn().mockImplementation((cursor: string) => {
      capturedCursors.push(cursor)
      return { stream: mockStreamFn }
    })

    MockHorizonServer.mockImplementation(() => ({
      payments: jest.fn().mockReturnValue({
        forAccount: jest.fn().mockReturnValue({
          cursor: mockCursorFn,
        }),
      }),
    }))
  })

  afterEach(() => {
    jest.useRealTimers()
  })

  it('opens a stream immediately on creation with cursor "now"', () => {
    const feed = createActivityFeed({
      accountId: ACCOUNT_ID,
      horizonUrl: 'https://horizon-testnet.stellar.org',
      onEvent: jest.fn(),
    })

    expect(mockStreamFn).toHaveBeenCalledTimes(1)
    expect(capturedCursors[0]).toBe('now')

    feed.stop()
  })

  it('calls onEvent with mapped events from the stream', () => {
    const onEvent = jest.fn()
    const feed = createActivityFeed({
      accountId: ACCOUNT_ID,
      horizonUrl: 'https://horizon-testnet.stellar.org',
      onEvent,
    })

    capturedCallbacks.onmessage!(makeOp({ from: 'GBBB', to: ACCOUNT_ID }))

    expect(onEvent).toHaveBeenCalledTimes(1)
    expect(onEvent.mock.calls[0][0].type).toBe('payment_received')

    feed.stop()
  })

  it('does not call onEvent for untracked op types', () => {
    const onEvent = jest.fn()
    const feed = createActivityFeed({
      accountId: ACCOUNT_ID,
      horizonUrl: 'https://horizon-testnet.stellar.org',
      onEvent,
    })

    capturedCallbacks.onmessage!(makeOp({ type: 'manage_buy_offer' }))

    expect(onEvent).not.toHaveBeenCalled()

    feed.stop()
  })

  it('calls onError and reconnects with the last seen cursor after a stream error', () => {
    const onEvent = jest.fn()
    const onError = jest.fn()
    const feed = createActivityFeed({
      accountId: ACCOUNT_ID,
      horizonUrl: 'https://horizon-testnet.stellar.org',
      onEvent,
      onError,
    })

    // Advance the cursor by receiving an event
    capturedCallbacks.onmessage!(makeOp({ paging_token: 'pt-42', from: 'GBBB', to: ACCOUNT_ID }))

    // Trigger a stream error
    capturedCallbacks.onerror!()
    expect(onError).toHaveBeenCalledTimes(1)

    // Before the timer fires, no reconnect yet
    jest.advanceTimersByTime(999)
    expect(mockStreamFn).toHaveBeenCalledTimes(1)

    // After the initial 1s delay, reconnect fires
    jest.advanceTimersByTime(1)
    expect(mockStreamFn).toHaveBeenCalledTimes(2)

    // Reconnect must resume from the last seen paging_token, not 'now'
    expect(capturedCursors[1]).toBe('pt-42')

    feed.stop()
  })

  it('applies exponential backoff on repeated stream failures', () => {
    createActivityFeed({
      accountId: ACCOUNT_ID,
      horizonUrl: 'https://horizon-testnet.stellar.org',
      onEvent: jest.fn(),
    })

    // 1st error: reconnect after 1 000 ms
    capturedCallbacks.onerror!()
    jest.advanceTimersByTime(1_000)
    expect(mockStreamFn).toHaveBeenCalledTimes(2)

    // 2nd error: reconnect after 2 000 ms
    capturedCallbacks.onerror!()
    jest.advanceTimersByTime(1_999)
    expect(mockStreamFn).toHaveBeenCalledTimes(2)
    jest.advanceTimersByTime(1)
    expect(mockStreamFn).toHaveBeenCalledTimes(3)

    // 3rd error: reconnect after 4 000 ms
    capturedCallbacks.onerror!()
    jest.advanceTimersByTime(3_999)
    expect(mockStreamFn).toHaveBeenCalledTimes(3)
    jest.advanceTimersByTime(1)
    expect(mockStreamFn).toHaveBeenCalledTimes(4)
  })

  it('caps reconnect delay at 30 000 ms', () => {
    createActivityFeed({
      accountId: ACCOUNT_ID,
      horizonUrl: 'https://horizon-testnet.stellar.org',
      onEvent: jest.fn(),
    })

    // Exhaust all doubling steps until the cap
    let delay = 1_000
    while (delay < 30_000) {
      capturedCallbacks.onerror!()
      jest.advanceTimersByTime(delay)
      delay = Math.min(delay * 2, 30_000)
    }
    const callsBeforeCap = mockStreamFn.mock.calls.length

    // Subsequent errors must not exceed 30 000 ms
    capturedCallbacks.onerror!()
    jest.advanceTimersByTime(29_999)
    expect(mockStreamFn).toHaveBeenCalledTimes(callsBeforeCap)
    jest.advanceTimersByTime(1)
    expect(mockStreamFn).toHaveBeenCalledTimes(callsBeforeCap + 1)
  })

  it('stops the stream and cancels pending reconnect on stop()', () => {
    const feed = createActivityFeed({
      accountId: ACCOUNT_ID,
      horizonUrl: 'https://horizon-testnet.stellar.org',
      onEvent: jest.fn(),
    })

    // Trigger an error to queue a reconnect, then stop before it fires
    capturedCallbacks.onerror!()
    feed.stop()

    jest.runAllTimers()

    // Stream must not have been reopened
    expect(mockStreamFn).toHaveBeenCalledTimes(1)
    expect(mockStopStream).toHaveBeenCalledTimes(1)
  })

  it('resets the reconnect delay after a successful message', () => {
    createActivityFeed({
      accountId: ACCOUNT_ID,
      horizonUrl: 'https://horizon-testnet.stellar.org',
      onEvent: jest.fn(),
    })

    // Drive the delay up to 2 000 ms with two errors
    capturedCallbacks.onerror!()
    jest.advanceTimersByTime(1_000)
    capturedCallbacks.onerror!()
    jest.advanceTimersByTime(2_000)
    expect(mockStreamFn).toHaveBeenCalledTimes(3)

    // A successful message resets the delay back to 1 000 ms
    capturedCallbacks.onmessage!(makeOp({ from: 'GBBB', to: ACCOUNT_ID }))

    capturedCallbacks.onerror!()
    jest.advanceTimersByTime(999)
    expect(mockStreamFn).toHaveBeenCalledTimes(3)
    jest.advanceTimersByTime(1)
    expect(mockStreamFn).toHaveBeenCalledTimes(4)
  })
})
