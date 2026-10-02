import {
  createIdleWatcher,
  getIdleTimeout,
  setIdleTimeout,
  idleTimeoutToMs,
  DEFAULT_IDLE_TIMEOUT,
} from '../idle-lock'

describe('idle-lock timeout config', () => {
  beforeEach(() => localStorage.clear())

  it('defaults to 5 minutes', () => {
    expect(getIdleTimeout()).toBe(5)
    expect(DEFAULT_IDLE_TIMEOUT).toBe(5)
  })

  it('round-trips each valid option (5 / 15 / 30 / never)', () => {
    for (const option of [5, 15, 30, 'never'] as const) {
      setIdleTimeout(option)
      expect(getIdleTimeout()).toBe(option)
    }
  })

  it('falls back to the default for an invalid stored value', () => {
    localStorage.setItem('veil_idle_lock_minutes', '999')
    expect(getIdleTimeout()).toBe(5)
  })

  it('maps options to milliseconds (never → null)', () => {
    expect(idleTimeoutToMs(5)).toBe(5 * 60 * 1000)
    expect(idleTimeoutToMs(30)).toBe(30 * 60 * 1000)
    expect(idleTimeoutToMs('never')).toBeNull()
  })
})

describe('createIdleWatcher', () => {
  afterEach(() => {
    jest.clearAllTimers()
    jest.useRealTimers()
    localStorage.clear()
  })

  it('locks after the idle timeout elapses', () => {
    jest.useFakeTimers()
    const onLock = jest.fn()
    const watcher = createIdleWatcher({ onLock, getTimeoutMs: () => 1000 })
    watcher.start()

    jest.advanceTimersByTime(999)
    expect(onLock).not.toHaveBeenCalled()
    jest.advanceTimersByTime(1)
    expect(onLock).toHaveBeenCalledTimes(1)
    watcher.stop()
  })

  it('resets the timer on user activity', () => {
    jest.useFakeTimers()
    const onLock = jest.fn()
    const watcher = createIdleWatcher({ onLock, getTimeoutMs: () => 1000 })
    watcher.start()

    jest.advanceTimersByTime(800)
    window.dispatchEvent(new Event('keydown')) // activity → reset
    jest.advanceTimersByTime(800)
    expect(onLock).not.toHaveBeenCalled() // only 800ms since the reset
    jest.advanceTimersByTime(200)
    expect(onLock).toHaveBeenCalledTimes(1)
    watcher.stop()
  })

  it('resets the timer on visibilitychange', () => {
    jest.useFakeTimers()
    const onLock = jest.fn()
    const watcher = createIdleWatcher({ onLock, getTimeoutMs: () => 1000 })
    watcher.start()

    jest.advanceTimersByTime(700)
    document.dispatchEvent(new Event('visibilitychange')) // reset
    jest.advanceTimersByTime(700)
    expect(onLock).not.toHaveBeenCalled()
    jest.advanceTimersByTime(300)
    expect(onLock).toHaveBeenCalledTimes(1)
    watcher.stop()
  })

  it('never locks when the timeout is disabled (never)', () => {
    jest.useFakeTimers()
    const onLock = jest.fn()
    const watcher = createIdleWatcher({ onLock, getTimeoutMs: () => null })
    watcher.start()

    jest.advanceTimersByTime(60 * 60 * 1000)
    expect(onLock).not.toHaveBeenCalled()
    watcher.stop()
  })

  it('defers locking while shouldDefer holds, then locks once clear', () => {
    jest.useFakeTimers()
    const onLock = jest.fn()
    let busy = true
    const watcher = createIdleWatcher({
      onLock,
      getTimeoutMs: () => 1000,
      shouldDefer: () => busy,
      deferMs: 500,
    })
    watcher.start()

    jest.advanceTimersByTime(1000) // timeout fires, but busy → defer
    expect(onLock).not.toHaveBeenCalled()
    busy = false
    jest.advanceTimersByTime(500) // defer elapses, no longer busy → lock
    expect(onLock).toHaveBeenCalledTimes(1)
    watcher.stop()
  })

  it('applies a timeout change immediately (config-changed event)', () => {
    jest.useFakeTimers()
    localStorage.clear()
    const onLock = jest.fn()
    // No getTimeoutMs override → reads the persisted setting (default 5 min).
    const watcher = createIdleWatcher({ onLock })
    watcher.start()

    setIdleTimeout('never') // dispatches the change event → watcher disables
    jest.advanceTimersByTime(60 * 60 * 1000)
    expect(onLock).not.toHaveBeenCalled()
    watcher.stop()
  })

  it('stops listening after stop()', () => {
    jest.useFakeTimers()
    const onLock = jest.fn()
    const watcher = createIdleWatcher({ onLock, getTimeoutMs: () => 1000 })
    watcher.start()
    watcher.stop()

    jest.advanceTimersByTime(5000)
    window.dispatchEvent(new Event('keydown'))
    jest.advanceTimersByTime(5000)
    expect(onLock).not.toHaveBeenCalled()
  })
})
