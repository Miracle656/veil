import { NextResponse } from "next/server";

const configuredOrigins = [
  process.env.NEXT_PUBLIC_HORIZON_URL,
  process.env.NEXT_PUBLIC_SOROBAN_RPC_URL,
  process.env.NEXT_PUBLIC_MAINNET_RPC_URL,
  process.env.NEXT_PUBLIC_WRAITH_URL,
  process.env.NEXT_PUBLIC_LENS_URL,
];

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
