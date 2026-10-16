/**
 * The naira rails on web.
 *
 * These pin the handful of decisions that are expensive and invisible. Every
 * one of them has already gone wrong once on mobile:
 *
 *   - the `customerRef` must never be regenerated, because Linq allows one
 *     verified customer per NIN forever and a new reference is a new person
 *     whose NIN is already spent;
 *   - the rate must be requested per coin, because the endpoint used to answer
 *     in naira per dollar for every asset and priced XLM at five times its
 *     worth;
 *   - `x-network` must be on every request, because wraith's own default is
 *     testnet and Linq moves real money;
 *   - the NIN must never reach storage, because it is personal data under the
 *     NDPA and a stored copy outlives the reason it was collected.
 */

// jsdom supplies neither, and `lib/ngn` reaches the Stellar SDK through
// walletStorage → network. Same shim the other suites here use.
import { webcrypto } from 'crypto'
import { TextEncoder, TextDecoder } from 'util'

Object.defineProperty(globalThis, 'crypto', { value: webcrypto, configurable: true, writable: true })
Object.assign(globalThis, { TextEncoder, TextDecoder })

const WRAITH = 'https://wraith.example'
const WALLET = 'CCDRZY5F4IRZFPIOIAHOJTCURLTFF736NAFB7WU3FPTP4SJJJZWAMDOE'

function loadModule() {
  jest.resetModules()
  process.env.NEXT_PUBLIC_WRAITH_URL = WRAITH
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  return require('../ngn') as typeof import('../ngn')
}

function respondWith(body: unknown, ok = true, status = 200) {
  global.fetch = jest.fn().mockResolvedValue({
    ok,
    status,
    text: async () => JSON.stringify(body),
  }) as unknown as typeof fetch
}

function lastRequest() {
  const mock = global.fetch as jest.Mock
  const [url, init] = mock.mock.calls[mock.mock.calls.length - 1]
  return { url: String(url), init: init as RequestInit }
}

beforeEach(() => {
  localStorage.clear()
  localStorage.setItem('invisible_wallet_address', WALLET)
})

afterEach(() => {
  delete process.env.NEXT_PUBLIC_WRAITH_URL
  jest.restoreAllMocks()
})

describe('getCustomerRef', () => {
  it('seeds from the wallet address, matching the mobile derivation', () => {
    const { getCustomerRef } = loadModule()
    expect(getCustomerRef()).toBe('veil_4sjjjzwamdoe')
  })

  // The one behaviour that must never regress: a reference that changes is a
  // person Linq has never met, holding a NIN that is already spent.
  it('keeps the stored reference even after the wallet address changes', () => {
    const { getCustomerRef } = loadModule()
    const first = getCustomerRef()

    localStorage.setItem('invisible_wallet_address', 'C' + 'A'.repeat(55))

    expect(getCustomerRef()).toBe(first)
  })

  it('has no reference before there is a wallet', () => {
    localStorage.removeItem('invisible_wallet_address')
    const { getCustomerRef } = loadModule()
    expect(getCustomerRef()).toBeNull()
  })
})

describe('getOnrampRate', () => {
  it('asks per coin, and says which', async () => {
    respondWith({ rate: 280.34 })
    const { getOnrampRate } = loadModule()

    await expect(getOnrampRate('xlm')).resolves.toBe(280.34)
    expect(lastRequest().url).toContain('/ngn/onramp/rate?coin=xlm')
  })

  // A zero or negative rate divides into an absurd amount of crypto, or throws
  // on the way. Refusing is the only answer that cannot be mistaken for one.
  it.each([[0], [-1]])('refuses an unusable rate (%s)', async (rate) => {
    respondWith({ rate })
    const { getOnrampRate } = loadModule()

    await expect(getOnrampRate('usdc')).rejects.toThrow(/unusable rate/)
  })
})

describe('every request', () => {
  it('names mainnet, because wraith defaults to testnet and Linq moves real money', async () => {
    respondWith({ rate: 1 })
    const { getOnrampRate } = loadModule()

    await getOnrampRate('usdc')

    const headers = lastRequest().init.headers as Record<string, string>
    expect(headers['x-network']).toBe('mainnet')
  })
})

describe('errors', () => {
  it("carries Linq's machine-readable code so callers need not read the prose", async () => {
    respondWith({ error: 'NIN already used', code: 'nin_already_used' }, false, 409)
    const { submitKyc } = loadModule()

    const err = await submitKyc('veil_abc', '12345678901').catch((e) => e)
    expect(err.code).toBe('nin_already_used')
  })

  it('scrubs the provider name out of anything a user reads', () => {
    const { withoutProviderName } = loadModule()
    expect(withoutProviderName('Linq rejected the request')).not.toMatch(/linq/i)
  })
})

describe('verify details', () => {
  // A type is a compile-time promise about a value that arrives from a form.
  // For the NIN that is not enough.
  it('stores the four contact fields and nothing else', () => {
    const { saveVerifyDetails } = loadModule()

    saveVerifyDetails({
      firstName: 'Ada',
      lastName: 'Obi',
      email: 'a@b.co',
      phone: '08030000000',
      // @ts-expect-error — deliberately passing a field the type forbids
      nin: '12345678901',
    })

    const raw = localStorage.getItem('veil_ngn_details') ?? ''
    expect(raw).not.toContain('12345678901')
    expect(JSON.parse(raw)).toEqual({
      firstName: 'Ada',
      lastName: 'Obi',
      email: 'a@b.co',
      phone: '08030000000',
    })
  })
})

describe('resetNairaVerification', () => {
  // Preserving the reference is the whole point: regenerating it turns a
  // recoverable state into the permanent one this exists to escape.
  it('clears both verdicts but keeps the customer reference', () => {
    const { getCustomerRef, setNairaVerified, setNairaKycMismatch, resetNairaVerification, isNairaVerified, isNairaKycMismatch } =
      loadModule()

    const ref = getCustomerRef()
    setNairaVerified(true)
    setNairaKycMismatch(true)

    resetNairaVerification()

    expect(isNairaVerified()).toBe(false)
    expect(isNairaKycMismatch()).toBe(false)
    expect(getCustomerRef()).toBe(ref)
  })
})

describe('getCustomerStatus', () => {
  // The whole point: a pure read, so a page can show the truth on load without
  // spending the one verification attempt a NIN ever gets.
  it('asks about the reference and creates nothing', async () => {
    respondWith({ customerRef: 'veil_etn2674mxqhk', verified: true })
    const { getCustomerStatus } = loadModule()

    await expect(getCustomerStatus('veil_etn2674mxqhk')).resolves.toMatchObject({ verified: true })

    const { url, init } = lastRequest()
    expect(url).toContain('/ngn/customers/status?customerRef=veil_etn2674mxqhk')
    expect(init.method ?? 'GET').toBe('GET')
  })

  it('url-encodes the reference rather than pasting it in', async () => {
    respondWith({ customerRef: 'x', verified: false })
    const { getCustomerStatus } = loadModule()

    await getCustomerStatus('veil_a b&c')

    expect(lastRequest().url).toContain('veil_a%20b%26c')
  })
})

describe('the active order survives a refresh', () => {
  const order = {
    orderId: 'ofr_123',
    customerRef: 'veil_abc',
    accountNumber: '0123456789',
    bankName: 'Test Bank',
    accountName: 'Veil Onramp',
    amountNgn: 1000,
    amountStableCoin: 0.69,
    fee: 0,
    expiresAt: new Date(Date.now() + 9 * 60_000).toISOString(),
    status: 'pending',
  }

  it('comes back with the account number and the clock intact', () => {
    const { rememberOnrampOrder, loadOnrampOrder } = loadModule()

    rememberOnrampOrder(order)

    // The whole order, not just the id: expiresAt is absent from the status
    // response, and a restored screen with no countdown cannot say whether the
    // account still accepts the payment.
    expect(loadOnrampOrder()).toMatchObject({
      orderId: 'ofr_123',
      accountNumber: '0123456789',
      expiresAt: order.expiresAt,
    })
  })

  // Restoring a dead order is how someone pays an account that has stopped
  // accepting it — worse than losing the order entirely.
  it('refuses an order whose window has closed, and clears it', () => {
    const { rememberOnrampOrder, loadOnrampOrder } = loadModule()

    rememberOnrampOrder({ ...order, expiresAt: new Date(Date.now() - 1000).toISOString() })

    expect(loadOnrampOrder()).toBeNull()
    expect(localStorage.getItem('veil_ngn_active_order')).toBeNull()
  })

  it.each([
    ['nothing stored', null],
    ['unparseable', '{{{'],
    ['missing an expiry', JSON.stringify({ orderId: 'x' })],
    ['missing an id', JSON.stringify({ expiresAt: new Date(Date.now() + 60_000).toISOString() })],
  ])('has no order when %s', (_label, raw) => {
    const { loadOnrampOrder } = loadModule()
    if (raw !== null) localStorage.setItem('veil_ngn_active_order', raw)

    expect(loadOnrampOrder()).toBeNull()
  })

  it('is gone once forgotten', () => {
    const { rememberOnrampOrder, forgetOnrampOrder, loadOnrampOrder } = loadModule()

    rememberOnrampOrder(order)
    forgetOnrampOrder()

    expect(loadOnrampOrder()).toBeNull()
  })
})
