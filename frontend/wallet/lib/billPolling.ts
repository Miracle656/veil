import {
  classifyBillStatus,
  getBillStatus,
  type BillStatus,
  type BillTerminalOutcome,
} from '@/lib/ngn'

export const POLL_INTERVAL_MS = 10_000
export const MAX_CONSECUTIVE_POLL_ERRORS = 3
export const MAX_POLL_ATTEMPTS = 12

export interface BillPollerCallbacks {
  onDone: (status: BillStatus) => void
  onFailed: (status: BillStatus) => void
  onUnconfirmed: (reason: 'error' | 'timeout') => void
  onErrorCountChange: (count: number) => void
}

/**
 * Manages status polling for a bill purchase.
 *
 * Implements bounded wait and distinguishable error retries (V276):
 * - Status polling is bounded (MAX_POLL_ATTEMPTS = 12 at 10s = 120s max).
 * - A poll error is retried visibly and gives up with an explanation (after MAX_CONSECUTIVE_POLL_ERRORS = 3).
 * - When polling times out or gives up on network errors, the user is moved to 'unconfirmed'
 *   and NEVER told the purchase failed, as crypto left the wallet and the top-up may already have landed.
 */
export class BillPoller {
  private timer: ReturnType<typeof setInterval> | null = null
  private consecutiveErrors = 0
  private totalPolls = 0
  private inFlight = false
  private stopped = false

  constructor(
    private customerRef: string,
    private orderId: string,
    private callbacks: BillPollerCallbacks,
    private getStatusFn: typeof getBillStatus = getBillStatus,
    private classifyFn: typeof classifyBillStatus = classifyBillStatus,
  ) {}

  start() {
    this.stopped = false
    this.consecutiveErrors = 0
    this.totalPolls = 0
    this.inFlight = false
    this.callbacks.onErrorCountChange(0)

    void this.check()
    this.timer = setInterval(() => void this.check(), POLL_INTERVAL_MS)
  }

  stop() {
    this.stopped = true
    if (this.timer) {
      clearInterval(this.timer)
      this.timer = null
    }
  }

  async check(): Promise<void> {
    if (this.inFlight || this.stopped) return
    this.inFlight = true
    this.totalPolls += 1

    try {
      const s = await this.getStatusFn(this.customerRef, this.orderId)
      if (this.stopped) return

      this.consecutiveErrors = 0
      this.callbacks.onErrorCountChange(0)

      const outcome: BillTerminalOutcome = this.classifyFn(s.status)
      if (outcome === 'done') {
        this.stop()
        this.callbacks.onDone(s)
        return
      }
      if (outcome === 'failed') {
        this.stop()
        this.callbacks.onFailed(s)
        return
      }

      if (this.totalPolls >= MAX_POLL_ATTEMPTS) {
        this.stop()
        this.callbacks.onUnconfirmed('timeout')
        return
      }
    } catch {
      if (this.stopped) return

      this.consecutiveErrors += 1
      const count = this.consecutiveErrors
      this.callbacks.onErrorCountChange(count)

      if (count >= MAX_CONSECUTIVE_POLL_ERRORS) {
        this.stop()
        this.callbacks.onUnconfirmed('error')
        return
      }

      if (this.totalPolls >= MAX_POLL_ATTEMPTS) {
        this.stop()
        this.callbacks.onUnconfirmed('timeout')
        return
      }
    } finally {
      this.inFlight = false
    }
  }

  async manualCheck(): Promise<'done' | 'failed' | 'timeout' | 'error'> {
    try {
      const s = await this.getStatusFn(this.customerRef, this.orderId)
      const outcome = this.classifyFn(s.status)
      if (outcome === 'done') {
        this.callbacks.onDone(s)
        return 'done'
      }
      if (outcome === 'failed') {
        this.callbacks.onFailed(s)
        return 'failed'
      }
      return 'timeout'
    } catch {
      return 'error'
    }
  }
}
