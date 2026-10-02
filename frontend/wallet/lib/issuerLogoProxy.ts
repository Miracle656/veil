/**
 * Server side of the issuer logo route (app/api/issuer-logo).
 *
 * Many logo hosts (cdn.ondo.finance among them) send no CORS headers, so the
 * browser cannot read a logo's bytes to size-check it. This fetches the logo
 * on the server and returns the checked bytes from the wallet's own origin.
 *
 * It is not an open proxy: the caller names only an asset code and issuer.
 * Anything outside the registry is refused without a network request, and the
 * image URL always comes from that issuer's own stellar.toml.
 */

import { StellarToml } from '@stellar/stellar-sdk'

import { getRegisteredAsset, isRegisteredIssuer } from './assets'
import {
  isHttpsImageUrl,
  readBoundedImage,
  selectRegisteredCurrency,
  type BoundedImage,
  type IssuerCurrency,
} from './issuerToml'

const FETCH_TIMEOUT_MS = 10_000
const MAX_REDIRECTS = 3

export interface IssuerLogoDeps {
  resolveToml?: (domain: string) => Promise<{ CURRENCIES?: IssuerCurrency[] }>
  fetchImpl?: typeof fetch
}

/** Follows at most a few redirects, each of which must stay on HTTPS. */
export async function fetchLogoOverHttps(url: string, fetchImpl: typeof fetch = fetch): Promise<BoundedImage | null> {
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS)
  try {
    let current = url
    for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
      if (!isHttpsImageUrl(current)) return null
      const response = await fetchImpl(current, {
        redirect: 'manual',
        signal: controller.signal,
        headers: { accept: 'image/*' },
        cache: 'no-store',
      })
      if (response.status >= 300 && response.status < 400) {
        const location = response.headers.get('location')
        if (!location) return null
        current = new URL(location, current).toString()
        continue
      }
      return await readBoundedImage(response)
    }
    return null
  } catch {
    return null
  } finally {
    controller.abort()
    clearTimeout(timeout)
  }
}

function refuse(status: number): Response {
  return new Response(null, { status, headers: { 'cache-control': 'public, max-age=300' } })
}

export async function serveIssuerLogo(requestUrl: string, deps: IssuerLogoDeps = {}): Promise<Response> {
  const params = new URL(requestUrl).searchParams
  const code = params.get('code') ?? ''
  const issuer = params.get('issuer') ?? ''
  const asset = getRegisteredAsset(code)
  // `homeDomain` is optional: the genuine USDT0 issuer publishes none, while
  // every impostor of that code does. No domain simply means no toml to read,
  // and the caller falls back to a letter avatar — it is not a signal either way.
  const homeDomain = asset?.homeDomain?.trim()
  if (!asset || asset.code !== code || !homeDomain || !isRegisteredIssuer(code, issuer)) {
    return refuse(404)
  }

  const resolveToml =
    deps.resolveToml ??
    ((domain: string) => StellarToml.Resolver.resolve(domain, { timeout: FETCH_TIMEOUT_MS }))
  let image: string | undefined
  try {
    image = selectRegisteredCurrency((await resolveToml(homeDomain)).CURRENCIES, code, issuer)?.image
  } catch {
    return refuse(502)
  }
  if (typeof image !== 'string' || !isHttpsImageUrl(image)) return refuse(404)

  const logo = await fetchLogoOverHttps(image, deps.fetchImpl ?? fetch)
  if (!logo) return refuse(502)
  return new Response(logo.bytes, {
    status: 200,
    headers: {
      'content-type': logo.type,
      'content-length': String(logo.bytes.byteLength),
      'cache-control': 'public, max-age=86400, s-maxage=86400',
      'x-content-type-options': 'nosniff',
      // An SVG opened directly from this origin must not run script. next.config.js
      // sets the same policy, since its page CSP would otherwise replace this one.
      'content-security-policy': "default-src 'none'; style-src 'unsafe-inline'; frame-ancestors 'none'; sandbox",
    },
  })
}
