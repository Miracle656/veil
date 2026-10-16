/**
 * A sleeping backend is not a broken one.
 *
 * The naira rails run on a tier that stops an idle service. The first request
 * to reach it gets a 503 from the edge — empty body, a fraction of a second —
 * while the container starts. Both clients treated that as final and told the
 * user the rails were unavailable, which is how "wraith is up but I can't
 * onramp" happens.
 *
 * These pin the two halves of the fix: a transient status is retried, and a
 * request that must not be sent twice still isn't.
 */

// jsdom supplies neither, and `lib/ngn` reaches the Stellar SDK through
// walletStorage → network. Same shim the other suites here use.
import { webcrypto } from 'crypto'
import { TextEncoder, TextDecoder } from 'util'

Object.defineProperty(globalThis, 'crypto', { value: webcrypto, configurable: true, writable: true })
Object.assign(globalThis, { TextEncoder, TextDecoder })

const BASE = 'https://backend.example'

/** Settle without ever leaving an unhandled rejection while timers are advanced. */
function settle<T>(p: Promise<T>): Promise<{ ok: true; value: T } | { ok: false; error: unknown }> {
  return p.then((value) => ({ ok: true as const, value }), (error: unknown) => ({ ok: false as const, error }))
}


function response(status: number, body: string, ok = status >= 200 && status < 300) {
  return { status, ok, text: async () => body } as unknown as Response
}

/** A cold start: N edge 503s, then the real answer. */
function wakingBackend(cold: number, payload: unknown) {
  let calls = 0
  const fn = jest.fn(async () => {
    calls += 1
    return calls <= cold ? response(503, '') : response(200, JSON.stringify(payload))
  })
  return { fn, get calls() { return calls } }
}

describe('a backend that is waking up', () => {
  beforeEach(() => {
    jest.resetModules()
    process.env['NEXT_PUBLIC_WRAITH_URL'] = BASE
    jest.useFakeTimers()
  })

  afterEach(() => {
    jest.useRealTimers()
    delete process.env['NEXT_PUBLIC_WRAITH_URL']
  })

  it('retries the offramp rate through a cold start instead of reporting it down', async () => {
    const backend = wakingBackend(2, { coin: 'USDC', currency: 'NGN', rate: 1352.65, indicative: true })
    ;(globalThis as { fetch?: unknown }).fetch = backend.fn

    const { getOfframpRate } = await import('../offramp')
    const settled = settle(getOfframpRate())
    await jest.advanceTimersByTimeAsync(30_000)

    expect(await settled).toMatchObject({ ok: true, value: { rate: 1352.65 } })
    expect(backend.calls).toBe(3)
  })

  it('retries the onramp rate too', async () => {
    const backend = wakingBackend(1, { coin: 'usdc', rate: 1452.65 })
    ;(globalThis as { fetch?: unknown }).fetch = backend.fn

    const { getOnrampRate } = await import('../ngn')
    const settled = settle(getOnrampRate('usdc'))
    await jest.advanceTimersByTimeAsync(30_000)

    expect(await settled).toEqual({ ok: true, value: 1452.65 })
    expect(backend.calls).toBe(2)
  })

  // The reason the backend refuses to generate an idempotency key: a retried
  // order that is not the same order is two orders, and the second one is paid
  // for too.
  it('never repeats an order creation that carries no idempotency key', async () => {
    let calls = 0
    ;(globalThis as { fetch?: unknown }).fetch = jest.fn(async () => {
      calls += 1
      return response(503, '')
    })

    const { createOrder } = await import('../offramp')
    const settled = settle(createOrder({
      amount: '10', bankAccount: '8023302683', bankCode: '999992', bankName: 'OPay',
      accountName: 'A Tester', walletAddress: 'GB3JS2AJZ3FKIGVOOPXDEYYR3XOHQA474WGCYAMNFSGX6OW5HGWCKUZW',
      refundAddress: 'GB3JS2AJZ3FKIGVOOPXDEYYR3XOHQA474WGCYAMNFSGX6OW5HGWCKUZW',
    } as never))
    await jest.advanceTimersByTimeAsync(30_000)

    expect((await settled).ok).toBe(false)
    expect(calls).toBe(1)
  })

  // A 400 is an answer. Asking again just makes the user wait for it twice.
  it('does not retry a refusal', async () => {
    let calls = 0
    ;(globalThis as { fetch?: unknown }).fetch = jest.fn(async () => {
      calls += 1
      return response(400, JSON.stringify({ error: 'amount is below the minimum' }))
    })

    const { getOfframpRate } = await import('../offramp')
    const settled = settle(getOfframpRate())
    await jest.advanceTimersByTimeAsync(30_000)

    const result = await settled
    expect(result.ok).toBe(false)
    expect(String((result as { error: unknown }).error)).toMatch(/below the minimum/)
    expect(calls).toBe(1)
  })

  // Render serves an HTML holding page while a container starts; JSON.parse on
  // it throws a SyntaxError that used to reach the user as itself.
  it('survives a non-JSON body from the edge', async () => {
    let calls = 0
    ;(globalThis as { fetch?: unknown }).fetch = jest.fn(async () => {
      calls += 1
      return calls === 1
        ? response(503, '<html><body>Service Unavailable</body></html>')
        : response(200, JSON.stringify({ coin: 'USDC', currency: 'NGN', rate: 1352.65, indicative: true }))
    })

    const { getOfframpRate } = await import('../offramp')
    const settled = settle(getOfframpRate())
    await jest.advanceTimersByTimeAsync(30_000)

    expect(await settled).toMatchObject({ ok: true, value: { rate: 1352.65 } })
  })

  it('gives up inside the budget rather than hanging on a backend that never wakes', async () => {
    let calls = 0
    ;(globalThis as { fetch?: unknown }).fetch = jest.fn(async () => {
      calls += 1
      return response(503, '')
    })

    const { getOfframpRate } = await import('../offramp')
    const settled = settle(getOfframpRate())
    await jest.advanceTimersByTimeAsync(60_000)

    expect((await settled).ok).toBe(false)
    expect(calls).toBeGreaterThan(1)
    expect(calls).toBeLessThanOrEqual(5)
  })
})
