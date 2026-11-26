/** A manually recorded total USDC basis for the current token quantity. */
export interface RecordedCostBasis {
  amount: string
  costUsdc: string
  recordedAt: number
}

export type CostBasisResult =
  | { status: 'known'; costUsdc: number; changeUsdc: number }
  | { status: 'unknown'; reason: 'not-recorded' | 'holding-changed' | 'invalid' }

/**
 * Compare a holding only with its explicitly recorded basis. If its amount has
 * since changed, the old total no longer describes the whole current holding.
 */
export function compareCostBasis(
  amount: string | number,
  currentValueUsdc: number | null,
  basis: RecordedCostBasis | null | undefined,
): CostBasisResult {
  if (!basis) return { status: 'unknown', reason: 'not-recorded' }
  const held = Number(amount)
  const recordedAmount = Number(basis.amount)
  const costUsdc = Number(basis.costUsdc)
  if (![held, recordedAmount, costUsdc].every(Number.isFinite) || held <= 0 || recordedAmount <= 0 || costUsdc < 0) {
    return { status: 'unknown', reason: 'invalid' }
  }
  // Horizon amounts have at most seven decimal places. Permit a one-stroop
  // formatting difference, but never carry a basis across a real balance move.
  if (Math.abs(held - recordedAmount) > 0.0000001) {
    return { status: 'unknown', reason: 'holding-changed' }
  }
  if (currentValueUsdc === null || !Number.isFinite(currentValueUsdc)) {
    return { status: 'unknown', reason: 'invalid' }
  }
  return { status: 'known', costUsdc, changeUsdc: currentValueUsdc - costUsdc }
}

export function readRecordedCostBasis(storage: Pick<Storage, 'getItem'>, key: string): RecordedCostBasis | null {
  try {
    const raw = storage.getItem(key)
    if (!raw) return null
    const value = JSON.parse(raw) as Partial<RecordedCostBasis>
    if (typeof value.amount !== 'string' || typeof value.costUsdc !== 'string' || typeof value.recordedAt !== 'number') return null
    return { amount: value.amount, costUsdc: value.costUsdc, recordedAt: value.recordedAt }
  } catch {
    return null
  }
}

export function writeRecordedCostBasis(
  storage: Pick<Storage, 'getItem' | 'setItem'>,
  key: string,
  amount: string,
  costUsdc: string,
  recordedAt = Date.now(),
): boolean {
  const parsedAmount = Number(amount)
  const parsedCost = Number(costUsdc)
  if (!Number.isFinite(parsedAmount) || parsedAmount <= 0 || !Number.isFinite(parsedCost) || parsedCost < 0) return false
  try {
    const value = JSON.stringify({ amount, costUsdc, recordedAt } satisfies RecordedCostBasis)
    storage.setItem(key, value)
    return storage.getItem(key) === value
  } catch {
    return false
  }
}
