import { NextResponse } from "next/server";

/**
 * CSP for the marketing site.
 *
 * No nonce and no `strict-dynamic` here, for the same reason the docs site
 * has none: every route is statically prerendered (`next build` marks them all
 * `○ Static`), and nothing in `app/` calls `headers()`, so a per-request nonce
 * from middleware never reaches the HTML. `strict-dynamic` makes browsers
 * ignore `'self'`, so a nonced policy over prerendered markup blocks every
 * script on the page — measured on a local `next build && next start`: 18
 * script tags, 0 carrying a nonce. The site would load with no JavaScript at
 * all, which on this site means no GSAP, no framer-motion and no three.js.
 *
 * `'unsafe-inline'` is needed for Next's own inline flight-data bootstrap
 * (`self.__next_f.push(...)`), six tags on `/`. The wallet is the origin that
 * holds signing material and it does run a strict nonced policy — see
 * `frontend/wallet/middleware.js`, where the layout threads `x-nonce` into the
 * one hand-written script; this site holds no keys.
 */
export function middleware(request) {
  const csp = [
    "default-src 'self'",
    "script-src 'self' 'unsafe-inline'",
    "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
    "img-src 'self' data: blob: https:",
    "font-src 'self' data: https://fonts.gstatic.com",
    "connect-src 'self' https:",
    "frame-ancestors 'none'",
    "object-src 'none'",
    "base-uri 'self'",
  ].join("; ");
  const requestHeaders = new Headers(request.headers);
  requestHeaders.set("Content-Security-Policy", csp);
  const response = NextResponse.next({ request: { headers: requestHeaders } });
  response.headers.set("Content-Security-Policy", csp);
  return response;
}

export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon.ico).*)"],
};
