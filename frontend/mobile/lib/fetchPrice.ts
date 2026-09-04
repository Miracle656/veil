/**
 * Lens price-oracle client for the mobile app — the native port of the web
 * wallet's `frontend/wallet/lib/fetchPrice.ts`. It reads `EXPO_PUBLIC_LENS_URL`
 * (inlined by the Expo bundler) instead of the web's `NEXT_PUBLIC_LENS_URL`.
 *
 * Pricing is strictly best-effort: the balance is the load-bearing figure and
 * must render even when the oracle is slow, gated (Lens uses x402 micropayment
 * gating and may answer 402), or offline. Every failure path collapses to
 * `null`, and callers surface the balance without a fiat value.
 */

const LENS_BASE_URL =
  process.env['EXPO_PUBLIC_LENS_URL']?.trim() || 'https://lens-ldtu.onrender.com';
const TIMEOUT_MS = 5_000;

/** Testnet USDC issuer — everything is quoted against USDC. */
const USDC_ISSUER = 'GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN';

/**
 * Approximate USD prices used only when the Lens oracle can't answer (402-gated,
 * offline, testnet). Deliberately rough — like the currency `fallbackRate`, this
 * exists so the balance renders a plausible fiat figure (and switching display
 * currency visibly does something) rather than collapsing to an em dash. A live
 * quote always overrides it.
 */
const FALLBACK_USD: Record<string, number> = { XLM: 0.11 };

function assetParam(code: string, issuer: string | null | undefined): string {
  if (code === 'XLM') return 'native';
  if (!issuer) return code;
  return `${code}:${issuer}`;
}

/**
 * Fetch the USDC price of a single asset from the Lens oracle.
 *
 * Returns `null` on any error (402 payment-required, 404 unknown pair, network
 * timeout, malformed body). This is intentionally best-effort — callers must
 * handle `null` gracefully rather than blocking the UI.
 */
export async function fetchPrice(
  code: string,
  issuer: string | null | undefined,
): Promise<number | null> {
  const upper = code.toUpperCase();
  if (upper === 'USDC') return 1.0;
  const fallback = FALLBACK_USD[upper] ?? null;

  const assetA = assetParam(code, issuer);
  const assetB = `USDC:${USDC_ISSUER}`;
  const url = `${LENS_BASE_URL}/price/${encodeURIComponent(assetA)}/${encodeURIComponent(assetB)}`;

  const controller = new AbortController();
  const timerId = setTimeout(() => controller.abort(), TIMEOUT_MS);

  try {
    const res = await fetch(url, { signal: controller.signal });
    // 402 = payment required, 404 = unknown pair — both fall back to an estimate.
    if (!res.ok) return fallback;
    const data = (await res.json()) as Record<string, unknown>;
    // Lens may return the price under any of several field names.
    const price = data['price'] ?? data['ask'] ?? data['last'] ?? data['close'];
    return typeof price === 'number' ? price : fallback;
  } catch {
    return fallback; // AbortError (timeout), network error, or parse error.
  } finally {
    clearTimeout(timerId);
  }
}

/**
 * The fiat value of a balance at a given price, or `null` when the price is
 * unavailable. Pure and total, so the card's "handles price-fetch failure"
 * path is exercised without touching the network.
 */
export function usdValue(balance: string | number, price: number | null): number | null {
  if (price == null) return null;
  const amount = typeof balance === 'number' ? balance : parseFloat(balance);
  if (!isFinite(amount)) return null;
  return amount * price;
}

/** Formats a fiat amount as `$1,234.56`, or an em dash when unavailable. */
export function formatUsd(value: number | null): string {
  if (value == null) return '—';
  return `$${value.toLocaleString('en-US', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })}`;
}
