/** @jest-environment node */

import { ASSET_REGISTRY } from '../assets'
import { MAX_ISSUER_LOGO_BYTES } from '../issuerToml'
import { fetchLogoOverHttps, serveIssuerLogo } from '../issuerLogoProxy'

const USDC = ASSET_REGISTRY.USDC
const UNREGISTERED_ISSUER = 'GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF'
const LOGO_URL = 'https://cdn.example/usdc.png'
const PNG = new Uint8Array([137, 80, 78, 71])

function route(code: string, issuer: string): string {
  return `https://wallet.example/api/issuer-logo?${new URLSearchParams({ code, issuer })}`
}

function image(bytes: Uint8Array<ArrayBuffer> = PNG, type = 'image/png'): Response {
  return new Response(bytes, { status: 200, headers: { 'content-type': type } })
}

function redirect(location: string): Response {
  return new Response(null, { status: 302, headers: { location } })
}

const toml = async () => ({ CURRENCIES: [{ code: 'USDC', issuer: USDC.issuer, image: LOGO_URL }] })

describe('serveIssuerLogo', () => {
  it.each([
    ['an unregistered issuer', 'USDC', UNREGISTERED_ISSUER],
    ['an unknown code', 'FAKE', USDC.issuer],
    ['a lowercase code', 'usdc', USDC.issuer],
  ])('refuses %s without any network request', async (_label, code, issuer) => {
    const resolveToml = jest.fn()
    const fetchImpl = jest.fn()
    const res = await serveIssuerLogo(route(code, issuer), { resolveToml, fetchImpl })
    expect(res.status).toBe(404)
    expect(resolveToml).not.toHaveBeenCalled()
    expect(fetchImpl).not.toHaveBeenCalled()
  })

  it('serves the logo named in the registered issuer toml', async () => {
    const resolveToml = jest.fn(toml)
    const fetchImpl = jest.fn(async () => image())
    const res = await serveIssuerLogo(route('USDC', USDC.issuer), { resolveToml, fetchImpl })
    expect(resolveToml).toHaveBeenCalledWith(USDC.homeDomain)
    expect(fetchImpl).toHaveBeenCalledWith(LOGO_URL, expect.objectContaining({ redirect: 'manual' }))
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toBe('image/png')
    expect(res.headers.get('content-security-policy')).toContain('sandbox')
    expect(res.headers.get('x-content-type-options')).toBe('nosniff')
    expect(new Uint8Array(await res.arrayBuffer())).toEqual(PNG)
  })

  it('ignores toml rows for other issuers and non-https images', async () => {
    for (const CURRENCIES of [
      [{ code: 'USDC', issuer: UNREGISTERED_ISSUER, image: LOGO_URL }],
      [{ code: 'USDC', issuer: USDC.issuer, image: 'http://cdn.example/usdc.png' }],
    ]) {
      const fetchImpl = jest.fn()
      const res = await serveIssuerLogo(route('USDC', USDC.issuer), { resolveToml: async () => ({ CURRENCIES }), fetchImpl })
      expect(res.status).toBe(404)
      expect(fetchImpl).not.toHaveBeenCalled()
    }
  })

  it('reports 502 when the toml or the logo cannot be loaded', async () => {
    const offline = await serveIssuerLogo(route('USDC', USDC.issuer), {
      resolveToml: async () => { throw new Error('offline') },
    })
    expect(offline.status).toBe(502)
    const oversized = await serveIssuerLogo(route('USDC', USDC.issuer), {
      resolveToml: toml,
      fetchImpl: async () => image(new Uint8Array(MAX_ISSUER_LOGO_BYTES + 1)),
    })
    expect(oversized.status).toBe(502)
    const notImage = await serveIssuerLogo(route('USDC', USDC.issuer), {
      resolveToml: toml,
      fetchImpl: async () => image(PNG, 'text/html'),
    })
    expect(notImage.status).toBe(502)
  })
})

describe('fetchLogoOverHttps', () => {
  it('follows https redirects', async () => {
    const fetchImpl = jest.fn(async (url: RequestInfo | URL) =>
      String(url) === LOGO_URL ? redirect('/moved.png') : image(),
    )
    await expect(fetchLogoOverHttps(LOGO_URL, fetchImpl)).resolves.toMatchObject({ type: 'image/png' })
    expect(fetchImpl).toHaveBeenLastCalledWith('https://cdn.example/moved.png', expect.anything())
  })

  it('stops at a redirect off https', async () => {
    const fetchImpl = jest.fn(async () => redirect('http://cdn.example/insecure.png'))
    await expect(fetchLogoOverHttps(LOGO_URL, fetchImpl)).resolves.toBeNull()
    expect(fetchImpl).toHaveBeenCalledTimes(1)
  })

  it('stops after too many redirects', async () => {
    let n = 0
    const fetchImpl = jest.fn(async () => redirect(`https://cdn.example/${++n}.png`))
    await expect(fetchLogoOverHttps(LOGO_URL, fetchImpl)).resolves.toBeNull()
    expect(fetchImpl).toHaveBeenCalledTimes(4)
  })
})
