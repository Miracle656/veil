/**
 * The wallet's Content-Security-Policy, asserted against the source of
 * middleware.js.
 *
 * Two invariants, both of which have been broken by accident:
 *
 * 1. `connect-src` must stay a closed allowlist. A bare `https:` there lets a
 *    `fetch` reach any origin, and the signer secret lives in sessionStorage,
 *    so it is the exfiltration path the rest of the policy exists to close
 *    (#705, August audit H1). Two PRs added it in one week to turn a CI job
 *    green; the symptom it was chasing is invariant 2.
 *
 * 2. Every registered issuer's `homeDomain` must be in `connect-src`, because
 *    `loadRegisteredIssuerMetadata` resolves `https://<homeDomain>/.well-known/
 *    stellar.toml` from the browser. When it is missing, nothing throws where a
 *    user can see it: the fetch is blocked, the metadata falls back to registry
 *    text, and the issuer's own name and description silently never appear.
 *
 * Read as text rather than imported: middleware.js is an edge-runtime module,
 * and the policy is a literal string there, so the source is the thing to pin.
 */

import { readFileSync } from 'fs'
import { join } from 'path'

import { ASSET_REGISTRY } from '../assets'

const source = readFileSync(join(__dirname, '..', '..', 'middleware.js'), 'utf8')

/** The literal origins in the `REGISTERED_ISSUER_ORIGINS` array. */
function sep1Origins(): string[] {
  const block = source.slice(
    source.indexOf('const REGISTERED_ISSUER_ORIGINS'),
    source.indexOf('const configuredOrigins'),
  )
  return (block.match(/"https:\/\/[^"]+"/g) ?? []).map(token => token.slice(1, -1))
}

/**
 * The tokens `connect-src` ends up with: the literals in its own array, plus
 * the SEP-1 origins it spreads in. `...origins` (the env-configured endpoints)
 * is runtime-only and deliberately not resolved here.
 */
function connectSrcTokens(): string[] {
  const start = source.indexOf('"connect-src"')
  expect(start).toBeGreaterThan(-1)
  const end = source.indexOf('].join(" ")', start)
  expect(end).toBeGreaterThan(start)
  const block = source.slice(start, end)
  const literals = (block.match(/"[^"]*"/g) ?? []).map(token => token.slice(1, -1))
  // If the spread is ever dropped, the SEP-1 origins stop applying and the
  // registry assertion below must fail rather than read them from the constant.
  expect(block).toContain('...REGISTERED_ISSUER_ORIGINS')
  return [...literals, ...sep1Origins()]
}

describe('wallet CSP', () => {
  it('keeps connect-src a closed allowlist', () => {
    const tokens = connectSrcTokens()
    // `https:` / `http:` / `*` would each make every other entry pointless.
    for (const wildcard of ['https:', 'http:', '*', 'data:']) {
      expect(tokens).not.toContain(wildcard)
    }
  })

  it('allows a SEP-1 read for every registered issuer home domain', () => {
    const tokens = connectSrcTokens()
    const domains = Object.values(ASSET_REGISTRY)
      .map(asset => asset.homeDomain?.trim())
      .filter((domain): domain is string => !!domain)

    // The registry is meant to carry at least one issuer with a toml; if this
    // ever reads zero, the assertion below would pass by vacuum.
    expect(domains.length).toBeGreaterThan(0)

    const missing = domains.filter(domain => !tokens.includes(`https://${domain}`))
    expect(missing).toEqual([])
  })

  it('does not allow an issuer origin the registry does not name', () => {
    const registered = new Set(
      Object.values(ASSET_REGISTRY)
        .map(asset => asset.homeDomain?.trim())
        .filter((domain): domain is string => !!domain)
        .map(domain => `https://${domain}`),
    )
    // Everything in the SEP-1 group must correspond to a registry entry, so a
    // removed issuer's domain does not linger in the policy.
    const listed = sep1Origins()
    expect(listed.length).toBeGreaterThan(0)
    expect(listed.filter(origin => !registered.has(origin))).toEqual([])
  })

  it('still names the directives the policy depends on', () => {
    for (const directive of [
      "default-src 'self'",
      'frame-ancestors',
      "object-src 'none'",
      "base-uri 'self'",
      "form-action 'self'",
    ]) {
      expect(source).toContain(directive)
    }
  })
})
