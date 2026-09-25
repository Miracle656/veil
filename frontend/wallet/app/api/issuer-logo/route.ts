/**
 * Same-origin logo fetch for registered issuers whose logo host sends no CORS
 * headers. Takes `code` and `issuer` only; see lib/issuerLogoProxy.ts.
 */

import { serveIssuerLogo } from '@/lib/issuerLogoProxy'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export function GET(request: Request): Promise<Response> {
  return serveIssuerLogo(request.url)
}
