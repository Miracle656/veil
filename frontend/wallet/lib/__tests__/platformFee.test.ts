/**
 * The Veil fee on web.
 *
 * Two things these have to hold. The fee must be refused whenever it cannot be
 * described exactly — this builds a payment the user never asked for, so a
 * malformed or surprising response means no fee rather than a guess. And every
 * failure path must return null rather than throw, because a throw here would
 * block a cash-out over our own billing endpoint being asleep on a free dyno.
 *
 * `BASE_URL` is read once at module load, which is how the first version of the
 * equivalent mobile suite ended up vacuous: fourteen cases asserted null and got
 * null from an empty base URL, passing without ever reaching the parser. Hence
 * `jest.resetModules()` and a fresh `require` per case, with the env set first.
 */

const WRAITH = 'https://wraith.example'
const TREASURY = 'GB3JS2AJZ3FKIGVOOPXDEYYR3XOHQA474WGCYAMNFSGX6OW5HGWCKUZW'
const USDC_ISSUER = 'GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN'

/**
 * Load the module with the env in place, so BASE_URL is non-empty.
 *
 * `null` means "no backend configured", not `undefined`: passing `undefined`
 * explicitly triggers a default parameter, so it would quietly load WITH the
 * URL set and assert nothing.
 */
function loadModule(baseUrl: string | null = WRAITH) {
  jest.resetModules()
  if (baseUrl === null) delete process.env.NEXT_PUBLIC_WRAITH_URL
  else process.env.NEXT_PUBLIC_WRAITH_URL = baseUrl
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  return require('../platformFee') as typeof import('../platformFee')
}

function respondWith(body: unknown, ok = true) {
  global.fetch = jest.fn().mockResolvedValue({
    ok,
    json: async () => body,
  }) as unknown as typeof fetch
}

function requestedUrl(): string {
  const mock = global.fetch as jest.Mock
  return String(mock.mock.calls[mock.mock.calls.length - 1][0])
}

const ENABLED = {
  enabled: true,
  fees: {
    USDC: { amount: '0.1', assetCode: 'USDC', assetIssuer: USDC_ISSUER, destination: TREASURY },
    XLM: { amount: '0.5', assetCode: 'XLM', assetIssuer: null, destination: TREASURY },
  },
}

afterEach(() => {
  delete process.env.NEXT_PUBLIC_WRAITH_URL
  jest.restoreAllMocks()
})

describe('fetchPlatformFee', () => {
  it('returns the fee for the asset being sent', async () => {
    respondWith(ENABLED)
    const { fetchPlatformFee } = loadModule()

    await expect(fetchPlatformFee('USDC')).resolves.toEqual({
      amount: '0.1',
      assetCode: 'USDC',
      assetIssuer: USDC_ISSUER,
      destination: TREASURY,
    })
  })

  // XLM has no issuer at all, so demanding one would refuse every native fee.
  it('accepts a null issuer for native XLM', async () => {
    respondWith(ENABLED)
    const { fetchPlatformFee } = loadModule()

    await expect(fetchPlatformFee('XLM')).resolves.toMatchObject({
      assetCode: 'XLM',
      assetIssuer: null,
      amount: '0.5',
    })
  })

  it('charges nothing for an asset with no configured fee', async () => {
    respondWith(ENABLED)
    const { fetchPlatformFee } = loadModule()

    await expect(fetchPlatformFee('USDT0')).resolves.toBeNull()
  })

  it('charges nothing while fees are switched off', async () => {
    respondWith({ enabled: false, fees: {} })
    const { fetchPlatformFee } = loadModule()

    await expect(fetchPlatformFee('USDC')).resolves.toBeNull()
  })

  // Each of these describes a payment we cannot state exactly, and the response
  // comes from a server; the client builds the transaction, so it is the last
  // place that can refuse.
  it.each([
    ['a non-numeric amount', { amount: 'free', assetCode: 'USDC', assetIssuer: USDC_ISSUER, destination: TREASURY }],
    ['a zero amount', { amount: '0', assetCode: 'USDC', assetIssuer: USDC_ISSUER, destination: TREASURY }],
    ['more precision than Stellar has', { amount: '0.123456789', assetCode: 'USDC', assetIssuer: USDC_ISSUER, destination: TREASURY }],
    ['a negative amount', { amount: '-1', assetCode: 'USDC', assetIssuer: USDC_ISSUER, destination: TREASURY }],
    ['a non-XLM asset with no issuer', { amount: '0.1', assetCode: 'USDC', assetIssuer: null, destination: TREASURY }],
    ['an issuer that is not an account', { amount: '0.1', assetCode: 'USDC', assetIssuer: 'not-an-address', destination: TREASURY }],
    ['a contract as the destination', { amount: '0.1', assetCode: 'USDC', assetIssuer: USDC_ISSUER, destination: 'CDUS5S3AENE5QREEHCIEHGKMP6LMBDELUYB35ZSFYETXETN2674MXQHK' }],
    ['no destination at all', { amount: '0.1', assetCode: 'USDC', assetIssuer: USDC_ISSUER }],
  ])('refuses %s', async (_label, entry) => {
    respondWith({ enabled: true, fees: { USDC: entry } })
    const { fetchPlatformFee } = loadModule()

    await expect(fetchPlatformFee('USDC')).resolves.toBeNull()
  })

  // A server that answers about a different asset than the one asked about is
  // not an asset we can charge in: the fee must be in the asset being sent, or
  // a sender who can afford the payment may not be able to afford the fee.
  it('refuses a fee for a different asset than the one requested', async () => {
    respondWith({
      enabled: true,
      fees: { USDC: { amount: '0.5', assetCode: 'XLM', assetIssuer: null, destination: TREASURY } },
    })
    const { fetchPlatformFee } = loadModule()

    await expect(fetchPlatformFee('USDC')).resolves.toBeNull()
  })

  it.each([
    ['the endpoint errors', () => respondWith({}, false)],
    ['the response is not JSON', () => {
      global.fetch = jest.fn().mockResolvedValue({
        ok: true,
        json: async () => { throw new Error('not json') },
      }) as unknown as typeof fetch
    }],
    ['the network is unreachable', () => {
      global.fetch = jest.fn().mockRejectedValue(new Error('offline')) as unknown as typeof fetch
    }],
    ['the body has no fees object', () => respondWith({ enabled: true })],
  ])('charges nothing, and does not throw, when %s', async (_label, arrange) => {
    arrange()
    const { fetchPlatformFee } = loadModule()

    await expect(fetchPlatformFee('USDC')).resolves.toBeNull()
  })

  // A deployment with no backend configured must not even try.
  it('charges nothing, and makes no request, with no backend configured', async () => {
    respondWith(ENABLED)
    const { fetchPlatformFee } = loadModule(null)

    await expect(fetchPlatformFee('USDC')).resolves.toBeNull()
    expect(global.fetch).not.toHaveBeenCalled()
  })

  // Not cached: a fee held over from an earlier page load is one the user was
  // shown but never agreed to.
  it('asks again on every call', async () => {
    respondWith(ENABLED)
    const { fetchPlatformFee } = loadModule()

    await fetchPlatformFee('USDC')
    await fetchPlatformFee('USDC')

    expect(global.fetch).toHaveBeenCalledTimes(2)
  })
})

describe('the amount being sent', () => {
  // The server prices the fee, so it has to be told what is being sent. A flat
  // fee was 10% of a 1 USDC send and 0.01% of a 1,000 one.
  it('is passed to the server so the fee can scale with it', async () => {
    respondWith(ENABLED)
    const { fetchPlatformFee } = loadModule()

    await fetchPlatformFee('USDC', 100)

    expect(requestedUrl()).toContain('/fees?amount=100')
  })

  // Omitting it asks for the floor, which is what this did before it could say
  // what was being sent.
  it.each([
    ['no amount', undefined],
    ['zero', 0],
    ['a negative amount', -5],
    ['not a number', Number.NaN],
  ])('asks for the floor with %s', async (_label, amount) => {
    respondWith(ENABLED)
    const { fetchPlatformFee } = loadModule()

    await fetchPlatformFee('USDC', amount)

    expect(requestedUrl()).not.toContain('?amount=')
  })
})
