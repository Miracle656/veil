/**
 * Amount produced by a completed first plan step. Use the observed balance
 * delta, never the quote amount, as the input to a dependent step.
 */
export function realizedOutputAmount(before: number, after: number): string | null {
  if (!Number.isFinite(before) || !Number.isFinite(after) || before < 0 || after < 0) return null;
  const delta = Math.floor((after - before) * 1e7 + 1e-7) / 1e7;
  if (!(delta > 0)) return null;
  return delta.toFixed(7).replace(/\.?0+$/, '');
}
