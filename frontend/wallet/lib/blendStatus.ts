/**
 * What a Blend pool's status number means for someone supplying to it.
 *
 * The numbers are the pool contract's own (blend-contracts-v2,
 * pool/src/pool/status.rs):
 *
 *   0 active (set by the pool admin)   1 active
 *   2 on ice (set by the pool admin)   3 on ice
 *   4 frozen (set by the pool admin)   5 frozen
 *   6 setup
 *
 * And what each blocks (pool/src/pool/pool.rs, require_action_allowed):
 * above 1, nobody can borrow; above 3, nobody can supply. Withdrawing is
 * never blocked by status.
 *
 * A pool goes on ice or freezes by itself when its backstop, the first-loss
 * capital behind it, is too small or too much of it is queued to leave. So a
 * status other than active is a fact about risk that a depositor should see
 * before adding money, not a technical detail.
 */
export type PoolState = 'active' | 'on-ice' | 'frozen' | 'setup' | 'unknown'

export interface PoolStatusInfo {
  state: PoolState
  /** False when the pool contract would refuse a deposit. */
  canSupply: boolean
  /** Short label for a badge, or null when there is nothing to say. */
  label: string | null
  /** A sentence or two for the person, or null when the pool is active. */
  notice: string | null
}

export function poolStatusInfo(status: number | null | undefined): PoolStatusInfo {
  if (status === 0 || status === 1) {
    return { state: 'active', canSupply: true, label: null, notice: null }
  }
  if (status === 2 || status === 3) {
    return {
      state: 'on-ice',
      canSupply: true,
      label: 'Borrowing paused',
      notice:
        'This pool has paused new borrowing. That happens when the safety fund behind it is too small, or too much of it is waiting to leave. ' +
        'You can still deposit and withdraw. With no new borrowing, the rate shown may fall.',
    }
  }
  if (status === 4 || status === 5) {
    return {
      state: 'frozen',
      canSupply: false,
      label: 'Deposits closed',
      notice: 'This pool is frozen. It is not taking deposits or lending. You can still withdraw what you have in it.',
    }
  }
  if (status === 6) {
    return {
      state: 'setup',
      canSupply: false,
      label: 'Not open yet',
      notice: 'This pool is still being set up and is not open yet.',
    }
  }
  // Not a number the pool contract defines, or the pool did not report one.
  // Say so, and do not block: an unreadable status is not a known-bad one.
  return {
    state: 'unknown',
    canSupply: true,
    label: 'Status unknown',
    notice: 'Veil could not read the current status of this pool. Check again before adding money.',
  }
}
