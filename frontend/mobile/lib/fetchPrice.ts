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

/**
 * Everything is quoted against USDC — but USDC is a different asset on each
 * network, and asking for the wrong one is indistinguishable from asking for a
 * pair nobody trades: Lens answers 404 and the wallet shows no price.
 *
 * The mainnet issuer is Circle's, confirmed by its home domain (circle.com)
 * rather than by asset code; Horizon lists many unrelated assets called USDC.
 * The testnet issuer is the one the Lens deployment actually watches.
 *
 * This was previously a single constant holding the *mainnet* issuer under a
 * comment claiming it was testnet, which is why testnet quotes never resolved.
 */
const USDC_ISSUERS = {
  mainnet: 'GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN',
  testnet: 'GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5',
} as const;

/**
 * Lens gates reads behind an API key (`REQUIRE_API_KEY`). Without one every
 * request comes back 401, which the wallet cannot tell apart from "no such
 * pair" — so a perfectly healthy oracle reads as a missing price. Sent when
 * configured; without it every quote comes back 401 and the wallet shows no
 * fiat value at all, which is the honest outcome rather than a guessed one.
 *
 * Public by construction: anything shipped in an app bundle is readable. This
 * should be a rate-limited read key, never one that can spend.
 */
const LENS_API_KEY = process.env['EXPO_PUBLIC_LENS_API_KEY']?.trim() || '';

/**
 * Resolved lazily: `./network` pulls in the Stellar SDK, and importing that at
 * module scope drags it into every test that touches pricing.
 */
async function activeNetworkName(): Promise<'testnet' | 'mainnet'> {
  try {
    const { getNetwork } = await import('./network');
    return getNetwork().name === 'mainnet' ? 'mainnet' : 'testnet';
  } catch {
    return 'testnet';
  }
}

async function usdcIssuer(): Promise<string> {
  return (await activeNetworkName()) === 'mainnet' ? USDC_ISSUERS.mainnet : USDC_ISSUERS.testnet;
}

/**
 * No hardcoded price fallback.
 *
 * There used to be one — `{ XLM: 0.11 }` — on the reasoning that a plausible
 * fiat figure beats an em dash. It does not. While Lens was answering 401 the
 * wallet quietly valued 5.35 XLM at $0.59 against a real $0.99: a 40% error,
 * shown as fact, with nothing on screen suggesting it was a guess. A number a
 * user might act on is worse wrong than absent, and any baked-in rate is wrong
 * within days of being written.
 *
 * Callers already handle `null` by showing "no price yet", which is true.
 */

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

/**
 * Mid-price from Stellar's own order book, when Lens cannot answer.
 *
 * This is not the estimate that was removed. That was a constant compiled into
 * the build (0.11 XLM) that valued 5.35 XLM at $0.59 against a real $0.99 and
 * went stale the day it was written. This is the live mid of the SDEX book
 * between the asset and Circle's USDC — a real market price, from the same
 * Horizon the wallet already reads balances from, with no key, no database and
 * no RPC quota behind it.
 *
 * Lens stays the preferred source: it is volume-weighted across venues, where
 * this is the top of one book. But an unreachable oracle should cost accuracy,
 * not the number entirely.
 */
async function orderBookPrice(
  code: string,
  issuer: string | null | undefined,
  network: 'testnet' | 'mainnet',
): Promise<number | null> {
  const horizon =
    network === 'mainnet' ? 'https://horizon.stellar.org' : 'https://horizon-testnet.stellar.org';
  const quoteIssuer = USDC_ISSUERS[network];

  const selling =
    code.toUpperCase() === 'XLM' || !issuer
      ? 'selling_asset_type=native'
      : `selling_asset_type=credit_alphanum4&selling_asset_code=${encodeURIComponent(code)}&selling_asset_issuer=${encodeURIComponent(issuer)}`;

  const url =
    `${horizon}/order_book?${selling}` +
    `&buying_asset_type=credit_alphanum4&buying_asset_code=USDC` +
    `&buying_asset_issuer=${encodeURIComponent(quoteIssuer)}&limit=1`;

  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(TIMEOUT_MS) });
    if (!res.ok) return null;
    const book = (await res.json()) as {
      bids?: { price?: string }[];
      asks?: { price?: string }[];
    };
    const bid = Number(book.bids?.[0]?.price);
    const ask = Number(book.asks?.[0]?.price);
    // Both sides required: a one-sided book has no mid, and taking whichever
    // side exists would quote a price nobody is willing to trade against.
    if (!isFinite(bid) || !isFinite(ask) || bid <= 0 || ask <= 0) return null;
    return (bid + ask) / 2;
  } catch {
    return null;
  }
}

export async function fetchPrice(
  code: string,
  issuer: string | null | undefined,
): Promise<number | null> {
  const upper = code.toUpperCase();
  // USDC is the quote asset, so its price against itself is 1 by definition —
  // not an estimate.
  if (upper === 'USDC') return 1.0;

  const network = await activeNetworkName();
  const assetA = assetParam(code, issuer);
  const assetB = `USDC:${USDC_ISSUERS[network]}`;
  // Lens serves both networks from one deployment and falls back to its own
  // STELLAR_NETWORK when the caller does not say. That default is testnet, so
  // asking for mainnet USDC without this returned a testnet quote — XLM at
  // 1.72 rather than ~0.18, because testnet SDEX has no real liquidity behind
  // it. The wallet knows which chain it is on; it has to say so.
  const url =
    `${LENS_BASE_URL}/price/${encodeURIComponent(assetA)}/${encodeURIComponent(assetB)}` +
    `?network=${network}`;

  const controller = new AbortController();
  const timerId = setTimeout(() => controller.abort(), TIMEOUT_MS);

  try {
    const res = await fetch(url, {
      signal: controller.signal,
      headers: LENS_API_KEY ? { Authorization: `Bearer ${LENS_API_KEY}` } : undefined,
    });
    // 401 = no API key, 402 = payment required, 404 = unknown pair. None of
    // these is a price, so none of them may become one.
    if (!res.ok) return orderBookPrice(code, issuer, network);
    const data = (await res.json()) as Record<string, unknown>;
    // Lens may return the price under any of several field names.
    const price = data['price'] ?? data['ask'] ?? data['last'] ?? data['close'];
    return typeof price === 'number' ? price : orderBookPrice(code, issuer, network);
  } catch {
    return orderBookPrice(code, issuer, network);
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
