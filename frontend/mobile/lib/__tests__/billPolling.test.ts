import { BillPoller, MAX_CONSECUTIVE_POLL_ERRORS, MAX_POLL_ATTEMPTS } from '../billPolling';
import { classifyBillStatus } from '../onramp';

describe('BillPoller', () => {
  let mockGetStatus: jest.Mock;
  let mockClassify: jest.Mock;
  let callbacks: any;

  beforeEach(() => {
    jest.useFakeTimers();
    mockGetStatus = jest.fn();
    mockClassify = jest.fn(classifyBillStatus);
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
    mockGetStatus.mockResolvedValue({ status: 'completed' });
    mockClassify.mockReturnValue('done');

    const poller = new BillPoller('ref123', 'order456', callbacks, mockGetStatus, mockClassify);
    poller.start();

    await jest.runAllTimersAsync();

    expect(callbacks.onDone).toHaveBeenCalledWith({ status: 'completed' });
    expect(callbacks.onFailed).not.toHaveBeenCalled();
    expect(callbacks.onUnconfirmed).not.toHaveBeenCalled();
  });

  it('should poll and call onFailed when status is failed', async () => {
    mockGetStatus.mockResolvedValue({ status: 'failed' });
    mockClassify.mockReturnValue('failed');

    const poller = new BillPoller('ref123', 'order456', callbacks, mockGetStatus, mockClassify);
    poller.start();

    await jest.runAllTimersAsync();

    expect(callbacks.onFailed).toHaveBeenCalledWith({ status: 'failed' });
    expect(callbacks.onDone).not.toHaveBeenCalled();
    expect(callbacks.onUnconfirmed).not.toHaveBeenCalled();
  });

  it('should retry on poll errors up to MAX_CONSECUTIVE_POLL_ERRORS then call onUnconfirmed with error', async () => {
    mockGetStatus.mockRejectedValue(new Error('Network error'));

    const poller = new BillPoller('ref123', 'order456', callbacks, mockGetStatus, mockClassify);
    poller.start();

    // Run the initial check plus retries
    for (let i = 0; i < MAX_CONSECUTIVE_POLL_ERRORS; i++) {
      await jest.advanceTimersByTimeAsync(10_000);
    }

    expect(callbacks.onUnconfirmed).toHaveBeenCalledWith('error');
    expect(callbacks.onErrorCountChange).toHaveBeenCalledTimes(MAX_CONSECUTIVE_POLL_ERRORS);
  });

  it('should call onUnconfirmed with timeout after MAX_POLL_ATTEMPTS', async () => {
    mockGetStatus.mockResolvedValue({ status: 'pending' });
    mockClassify.mockReturnValue('pending');

    const poller = new BillPoller('ref123', 'order456', callbacks, mockGetStatus, mockClassify);
    poller.start();

    // Run MAX_POLL_ATTEMPTS polls
    for (let i = 0; i < MAX_POLL_ATTEMPTS; i++) {
      await jest.advanceTimersByTimeAsync(10_000);
    }

    expect(callbacks.onUnconfirmed).toHaveBeenCalledWith('timeout');
    expect(callbacks.onDone).not.toHaveBeenCalled();
    expect(callbacks.onFailed).not.toHaveBeenCalled();
  });

  it('should increment error count on consecutive errors', async () => {
    mockGetStatus.mockRejectedValue(new Error('Network error'));

    const poller = new BillPoller('ref123', 'order456', callbacks, mockGetStatus, mockClassify);
    poller.start();

    await jest.advanceTimersByTimeAsync(10_000);
    expect(callbacks.onErrorCountChange).toHaveBeenCalledWith(1);

    await jest.advanceTimersByTimeAsync(10_000);
    expect(callbacks.onErrorCountChange).toHaveBeenCalledWith(2);
  });

  it('should reset error count on successful poll', async () => {
    mockGetStatus
      .mockRejectedValueOnce(new Error('Network error'))
      .mockResolvedValue({ status: 'pending' });
    mockClassify.mockReturnValue('pending');

    const poller = new BillPoller('ref123', 'order456', callbacks, mockGetStatus, mockClassify);
    poller.start();

    await jest.advanceTimersByTimeAsync(10_000);
    expect(callbacks.onErrorCountChange).toHaveBeenCalledWith(1);

    await jest.advanceTimersByTimeAsync(10_000);
    expect(callbacks.onErrorCountChange).toHaveBeenCalledWith(0);
  });

  it('should stop polling when stop is called', async () => {
    mockGetStatus.mockResolvedValue({ status: 'pending' });
    mockClassify.mockReturnValue('pending');

    const poller = new BillPoller('ref123', 'order456', callbacks, mockGetStatus, mockClassify);
    poller.start();

    await jest.advanceTimersByTimeAsync(10_000);
    poller.stop();

    // Verify no more polls happen
    const pollCount = mockGetStatus.mock.calls.length;
    await jest.advanceTimersByTimeAsync(50_000);
    expect(mockGetStatus).toHaveBeenCalledTimes(pollCount);
  });

  it('should support manual check', async () => {
    mockGetStatus.mockResolvedValue({ status: 'completed' });
    mockClassify.mockReturnValue('done');

    const poller = new BillPoller('ref123', 'order456', callbacks, mockGetStatus, mockClassify);
    const result = await poller.manualCheck();

    expect(result).toBe('done');
    expect(callbacks.onDone).toHaveBeenCalledWith({ status: 'completed' });
  });

  it('should manual check return error on failure', async () => {
    mockGetStatus.mockRejectedValue(new Error('Network error'));

    const poller = new BillPoller('ref123', 'order456', callbacks, mockGetStatus, mockClassify);
    const result = await poller.manualCheck();

    expect(result).toBe('error');
  });

  it('should manual check return timeout on pending', async () => {
    mockGetStatus.mockResolvedValue({ status: 'pending' });
    mockClassify.mockReturnValue('pending');

    const poller = new BillPoller('ref123', 'order456', callbacks, mockGetStatus, mockClassify);
    const result = await poller.manualCheck();

    expect(result).toBe('timeout');
  });
});
