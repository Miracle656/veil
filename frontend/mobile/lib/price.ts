/**
 * Best-effort asset pricing for the mobile wallet — the native port of the web
 * wallet's `fetchPrice` (`frontend/wallet/lib/fetchPrice.ts`).
 *
 * Prices come from the Lens oracle, quoted in USDC. Lens gates requests behind
 * x402 micropayments; in the wallet we attempt the call without payment and
 * treat a 402 (and any timeout, unknown pair, or network error) as simply "no
 * price" rather than blocking the screen. Every path resolves to a number or
 * `null`, never throws.
 */

const LENS_BASE_URL = process.env['EXPO_PUBLIC_LENS_URL']?.trim() || 'https://lens-ldtu.onrender.com';
const TIMEOUT_MS = 5_000;

/** Testnet USDC issuer — everything is quoted against it. */
const USDC_QUOTE = 'USDC:GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN';

function assetParam(code: string, issuer: string | null | undefined): string {
  if (code === 'XLM') return 'native';
  if (!issuer) return code;
  return `${code}:${issuer}`;
}

/**
 * Fetches the USDC price of a single asset, or `null` when it can't be
 * determined. USDC is pinned to 1.0 so the pair against itself is never asked.
 */
export async function fetchPrice(
  code: string,
  issuer: string | null | undefined,
): Promise<number | null> {
  if (code.toUpperCase() === 'USDC') return 1.0;

  const url = `${LENS_BASE_URL}/price/${encodeURIComponent(assetParam(code, issuer))}/${encodeURIComponent(USDC_QUOTE)}`;
  const controller = new AbortController();
  const timerId = setTimeout(() => controller.abort(), TIMEOUT_MS);

  try {
    const res = await fetch(url, { signal: controller.signal });
    if (!res.ok) return null; // 402 payment-required, 404 unknown pair — no price
    const data = (await res.json()) as Record<string, unknown>;
    const price = data['price'] ?? data['ask'] ?? data['last'] ?? data['close'];
    return typeof price === 'number' ? price : null;
  } catch {
    return null; // timeout (abort), network, or parse error
  } finally {
    clearTimeout(timerId);
  }
}
