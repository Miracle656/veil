// @stellar/stellar-sdk needs TextEncoder at module load and jsdom omits it.
// Same two lines the other suites in this repo open with.
import { TextEncoder, TextDecoder } from 'util'
Object.assign(globalThis, { TextEncoder, TextDecoder })

import { BillPoller, MAX_CONSECUTIVE_POLL_ERRORS, MAX_POLL_ATTEMPTS } from '../billPolling';
import { classifyBillStatus, getBillStatus, type BillStatus } from '../ngn';
import * as ngn from '../ngn';

/**
 * A complete BillStatus with only the field under test varied. The poller
 * branches on `status` alone, but the type carries seven fields and a partial
 * object does not typecheck against it.
 */
const billStatus = (status: string): BillStatus =>
  ({
    orderId: 'order456',
    customerRef: 'ref123',
    billCategory: 'airtime',
    amountNgn: 500,
    status,
  }) as BillStatus;

jest.mock('../ngn');

describe('BillPoller (wallet)', () => {
  let mockGetStatus: jest.MockedFunction<typeof getBillStatus>;
  let mockClassify: jest.MockedFunction<typeof classifyBillStatus>;
  let callbacks: any;

  beforeEach(() => {
    jest.useFakeTimers();
    // jest.mock('../ngn') already replaced these with mocks; take them as
    // they are rather than assigning over the module's exports.
    mockGetStatus = ngn.getBillStatus as jest.MockedFunction<typeof getBillStatus>;
    mockClassify = ngn.classifyBillStatus as jest.MockedFunction<typeof classifyBillStatus>;
    mockGetStatus.mockReset();
    mockClassify.mockReset();

    callbacks = {
      onDone: jest.fn(),
      onFailed: jest.fn(),
      onUnconfirmed: jest.fn(),
      onErrorCountChange: jest.fn(),
    };
  });

  afterEach(() => {
    jest.runOnlyPendingTimers();
    jest.useRealTimers();
  });

  it('should poll and call onDone when status is complete', async () => {
    mockGetStatus.mockResolvedValue(billStatus('completed'));
    mockClassify.mockReturnValue('done');

    const poller = new BillPoller('ref123', 'order456', callbacks);
    poller.start();

    await jest.runAllTimersAsync();

    expect(callbacks.onDone).toHaveBeenCalledWith(billStatus('completed'));
    expect(callbacks.onFailed).not.toHaveBeenCalled();
    expect(callbacks.onUnconfirmed).not.toHaveBeenCalled();
  });

  it('should poll and call onFailed when status is failed', async () => {
    mockGetStatus.mockResolvedValue(billStatus('failed'));
    mockClassify.mockReturnValue('failed');

    const poller = new BillPoller('ref123', 'order456', callbacks);
    poller.start();

    await jest.runAllTimersAsync();

    expect(callbacks.onFailed).toHaveBeenCalledWith(billStatus('failed'));
    expect(callbacks.onDone).not.toHaveBeenCalled();
    expect(callbacks.onUnconfirmed).not.toHaveBeenCalled();
  });

  it('should retry on poll errors up to MAX_CONSECUTIVE_POLL_ERRORS then call onUnconfirmed with error', async () => {
    mockGetStatus.mockRejectedValue(new Error('Network error'));

    const poller = new BillPoller('ref123', 'order456', callbacks);
    poller.start();

    // Run the initial check plus retries
    for (let i = 0; i < MAX_CONSECUTIVE_POLL_ERRORS; i++) {
      await jest.advanceTimersByTimeAsync(10_000);
    }

    expect(callbacks.onUnconfirmed).toHaveBeenCalledWith('error');
    // +1 for the reset to zero that start() fires before the first poll, so
    // a retried purchase does not inherit the previous attempt's errors.
    expect(callbacks.onErrorCountChange).toHaveBeenCalledTimes(MAX_CONSECUTIVE_POLL_ERRORS + 1);
  });

  it('should call onUnconfirmed with timeout after MAX_POLL_ATTEMPTS', async () => {
    mockGetStatus.mockResolvedValue(billStatus('pending'));
    mockClassify.mockReturnValue('pending');

    const poller = new BillPoller('ref123', 'order456', callbacks);
    poller.start();

    // Run MAX_POLL_ATTEMPTS polls
    for (let i = 0; i < MAX_POLL_ATTEMPTS; i++) {
      await jest.advanceTimersByTimeAsync(10_000);
    }

    expect(callbacks.onUnconfirmed).toHaveBeenCalledWith('timeout');
    expect(callbacks.onDone).not.toHaveBeenCalled();
    expect(callbacks.onFailed).not.toHaveBeenCalled();
  });

  it('should stop polling when stop is called', async () => {
    mockGetStatus.mockResolvedValue(billStatus('pending'));
    mockClassify.mockReturnValue('pending');

    const poller = new BillPoller('ref123', 'order456', callbacks);
    poller.start();

    await jest.advanceTimersByTimeAsync(10_000);
    poller.stop();

    // Verify no more polls happen
    const pollCount = mockGetStatus.mock.calls.length;
    await jest.advanceTimersByTimeAsync(50_000);
    expect(mockGetStatus).toHaveBeenCalledTimes(pollCount);
  });
});
