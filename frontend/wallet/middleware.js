import { NextResponse } from "next/server";

/**
 * Origins the wallet reads a SEP-1 `stellar.toml` from.
 *
 * Every toml read goes through `loadRegisteredIssuerMetadata`, which refuses
 * any issuer outside `lib/assets.ts`'s ASSET_REGISTRY and then resolves that
 * issuer's own `homeDomain` — so the set of domains is finite and known ahead
 * of time. Listed literally rather than imported because middleware runs in the
 * edge runtime and should not pull the asset registry (and the SDK types behind
 * it) into that bundle; `lib/__tests__/csp.test.ts` asserts the two stay in
 * step, which is what a comment alone cannot do.
 */
const REGISTERED_ISSUER_ORIGINS = [
  "https://ondo.finance",
  "https://circle.com",
  "https://stellar.org",
  "https://aqua.network",
];

const configuredOrigins = [
  process.env.NEXT_PUBLIC_HORIZON_URL,
  process.env.NEXT_PUBLIC_SOROBAN_RPC_URL,
  process.env.NEXT_PUBLIC_MAINNET_RPC_URL,
  process.env.NEXT_PUBLIC_WRAITH_URL,
  process.env.NEXT_PUBLIC_LENS_URL,
];

// Playwright serves issuer logos from this fake host
// (e2e/issuer-metadata.spec.ts). Allowed only when the e2e flag is set, as one
// exact origin, never a wildcard, so production connect-src stays closed.
const E2E_ORIGINS =
  process.env.VEIL_E2E === "1" ? ["https://logos.example"] : [];

function originOf(value) {
  if (!value) return null;
  try {
    return new URL(value).origin;
  } catch {
    return null;
  }
}

export function middleware(request) {
  const nonce = Buffer.from(crypto.randomUUID()).toString("base64");
  const origins = new Set(configuredOrigins.map(originOf).filter(Boolean));
  const csp = [
    "default-src 'self'",
    `script-src 'self' 'nonce-${nonce}' 'wasm-unsafe-eval'`,
    "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
    "img-src 'self' data: blob: https:",
    "font-src 'self' data: https://fonts.gstatic.com",
    [
      "connect-src",
      "'self'",
      // Deliberately an allowlist and never a bare `https:`. The signer secret
      // lives in sessionStorage, so an open connect-src is exactly the
      // exfiltration path the rest of this policy exists to close (#705,
      // audit H1).
      "https://horizon-testnet.stellar.org",
      "https://horizon.stellar.org",
      "https://soroban-testnet.stellar.org",
      "https://friendbot.stellar.org",
      "https://vlnwwekmukgoretgdkcj.supabase.co",
      "https://lens-ldtu.onrender.com",
      "https://api.soroswap.finance",
      "https://open.er-api.com",
      "https://raw.githubusercontent.com",
      "https://relay.walletconnect.com",
      "wss://relay.walletconnect.com",
      // SEP-1 reads. `loadRegisteredIssuerMetadata` only ever resolves the
      // `homeDomain` of an issuer already in ASSET_REGISTRY, so this set is
      // closed and known at build time — it is not an excuse for a bare
      // `https:`. Keep it in step with lib/assets.ts; lib/__tests__/csp.test.ts
      // fails if a registered homeDomain is missing here, because the symptom
      // otherwise is silently missing issuer names rather than an error.
      ...REGISTERED_ISSUER_ORIGINS,
      ...E2E_ORIGINS,
      ...origins,
    ].join(" "),
    "worker-src 'self' blob:",
    "frame-ancestors 'none'",
    "object-src 'none'",
    "base-uri 'self'",
    "form-action 'self'",
  ].join("; ");

  const requestHeaders = new Headers(request.headers);
  requestHeaders.set("x-nonce", nonce);
  requestHeaders.set("Content-Security-Policy", csp);
  const response = NextResponse.next({ request: { headers: requestHeaders } });
  response.headers.set("Content-Security-Policy", csp);
  return response;
}

export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon.ico).*)"],
};
