import {
  CONNECT_APPS,
  CONNECT_TEST_APPS,
  MAX_PAY_AMOUNT,
  decodePending,
  encodePending,
  getConnectApp,
  isAllowedOrigin,
  parseConnectRequest,
  requestFromMessage,
  sendPathFor,
} from '../connect'

// Placeholders with the right shape. No real account belongs in a test file.
const G_ADDRESS = 'G' + 'A'.repeat(55)
const C_ADDRESS = 'C' + 'B'.repeat(55)
const ISSUER = 'G' + 'C'.repeat(55)
const ID = 'request-0001'

const pay = (over: Record<string, unknown> = {}) => ({
  type: 'pay',
  id: ID,
  to: G_ADDRESS,
  amount: '20',
  asset: 'USDC',
  reference: 'order-123',
  ...over,
})

describe('which apps may use Veil Connect', () => {
  it('knows a listed app and nothing else', () => {
    expect(getConnectApp('stakesync')?.name).toBe('Stake-Sync')
    expect(getConnectApp('nobody')).toBeNull()
    expect(getConnectApp(null)).toBeNull()
    // Object keys that are not apps.
    expect(getConnectApp('constructor')).toBeNull()
    expect(getConnectApp('__proto__')).toBeNull()
  })

  it('offers the demo app only when asked to', () => {
    expect(getConnectApp('demo')).toBeNull()
    expect(getConnectApp('demo', true)?.id).toBe('demo')
  })

  it('accepts an exact origin and refuses look-alikes', () => {
    const app = CONNECT_APPS.stakesync
    expect(isAllowedOrigin(app, 'https://usestakesync.xyz')).toBe(true)
    expect(isAllowedOrigin(app, 'http://usestakesync.xyz')).toBe(false)
    expect(isAllowedOrigin(app, 'https://usestakesync.xyz.evil.example')).toBe(false)
    expect(isAllowedOrigin(app, 'https://evil.example/https://usestakesync.xyz')).toBe(false)
    expect(isAllowedOrigin(app, 'null')).toBe(false)
  })

  it("keeps a partner's test entry apart from the real one", () => {
    const test = getConnectApp('stakesync-test')
    expect(test?.name).toBe('Stake-Sync (test)')
    expect(isAllowedOrigin(test!, 'http://localhost:3000')).toBe(true)
    expect(isAllowedOrigin(test!, 'http://localhost:3001')).toBe(false)
    expect(isAllowedOrigin(test!, 'https://usestakesync.xyz')).toBe(false)
    // The real app never answers to a developer's machine.
    expect(isAllowedOrigin(CONNECT_APPS.stakesync, 'http://localhost:3000')).toBe(false)
    for (const app of Object.values(CONNECT_TEST_APPS)) {
      expect(app.name).toMatch(/\(test\)$/)
      for (const origin of app.origins) expect(origin).toMatch(/^http:\/\/localhost:\d+$/)
    }
  })

  it('lists only https origins for real apps', () => {
    for (const app of Object.values(CONNECT_APPS)) {
      for (const origin of app.origins) expect(origin).toMatch(/^https:\/\/[a-z0-9.-]+$/)
    }
  })
})

describe('a request from another app', () => {
  it('accepts connect and fund', () => {
    expect(parseConnectRequest({ type: 'connect', id: ID })).toEqual({ ok: true, request: { type: 'connect', id: ID } })
    expect(parseConnectRequest({ type: 'fund', id: ID })).toEqual({ ok: true, request: { type: 'fund', id: ID } })
  })

  it('accepts cash out, and carries nothing the app sent with it', () => {
    // An app opens the screen. The amount and the bank are the person's to
    // choose in Veil, so anything extra on the request is dropped.
    expect(
      parseConnectRequest({ type: 'cashout', id: ID, amount: '500', bank: '058', account: 'x' }),
    ).toEqual({ ok: true, request: { type: 'cashout', id: ID } })
  })

  it('accepts a payment to an account or a contract', () => {
    expect(parseConnectRequest(pay())).toEqual({
      ok: true,
      request: { type: 'pay', id: ID, to: G_ADDRESS, amount: '20', asset: 'USDC', reference: 'order-123' },
    })
    expect(parseConnectRequest(pay({ to: C_ADDRESS, asset: 'XLM', amount: '0.5' })).ok).toBe(true)
  })

  it('defaults the asset to USDC', () => {
    const parsed = parseConnectRequest(pay({ asset: undefined }))
    expect(parsed.ok && parsed.request.type === 'pay' && parsed.request.asset).toBe('USDC')
  })

  it('drops fields it does not know', () => {
    const parsed = parseConnectRequest(pay({ issuer: ISSUER, memo: 'x', returnUrl: 'https://evil.example' }))
    expect(parsed.ok && Object.keys(parsed.request).sort()).toEqual(['amount', 'asset', 'id', 'reference', 'to', 'type'])
  })

  it.each([
    ['not an object', 'pay'],
    ['no id', pay({ id: undefined })],
    ['a short id', pay({ id: 'abc' })],
    ['an unknown type', pay({ type: 'sign' })],
    ['a short address', pay({ to: 'GABC' })],
    ['an address with a space', pay({ to: G_ADDRESS.slice(0, 55) + ' ' })],
    ['a muxed address', pay({ to: 'M' + 'A'.repeat(68) })],
    ['another asset', pay({ asset: 'USDT0' })],
    ['an amount as a number', pay({ amount: 20 })],
    ['a negative amount', pay({ amount: '-1' })],
    ['a zero amount', pay({ amount: '0' })],
    ['an amount in exponent form', pay({ amount: '1e3' })],
    ['eight decimals', pay({ amount: '1.00000001' })],
    ['an amount over the limit', pay({ amount: String(MAX_PAY_AMOUNT + 1) })],
    ['no reference', pay({ reference: '' })],
    ['a reference with a space', pay({ reference: 'order 1' })],
    ['a reference that is too long', pay({ reference: 'a'.repeat(65) })],
  ])('refuses %s', (_name, raw) => {
    expect(parseConnectRequest(raw).ok).toBe(false)
  })

  it('accepts an amount exactly at the limit', () => {
    expect(parseConnectRequest(pay({ amount: String(MAX_PAY_AMOUNT) })).ok).toBe(true)
  })
})

describe('messages', () => {
  it('reads a request only from a message on our channel', () => {
    const request = pay()
    expect(requestFromMessage({ channel: 'veil-connect', kind: 'request', request })).toBe(request)
    expect(requestFromMessage({ channel: 'other', kind: 'request', request })).toBeNull()
    expect(requestFromMessage({ channel: 'veil-connect', kind: 'result', request })).toBeNull()
    expect(requestFromMessage('veil-connect')).toBeNull()
    expect(requestFromMessage(null)).toBeNull()
  })
})

describe('what the Veil window remembers', () => {
  const stored = () => {
    const parsed = parseConnectRequest(pay())
    if (!parsed.ok) throw new Error('fixture')
    return { appId: 'stakesync', origin: 'https://usestakesync.xyz', request: parsed.request }
  }

  it('reads back what it stored', () => {
    expect(decodePending(encodePending(stored()))).toEqual(stored())
  })

  it('drops a stored value that no longer passes the rules', () => {
    expect(decodePending(null)).toBeNull()
    expect(decodePending('not json')).toBeNull()
    expect(decodePending(JSON.stringify({ ...stored(), appId: 'nobody' }))).toBeNull()
    expect(decodePending(JSON.stringify({ ...stored(), origin: 'https://evil.example' }))).toBeNull()
    expect(decodePending(JSON.stringify({ ...stored(), request: pay({ amount: '-5' }) }))).toBeNull()
  })
})

describe('the hand-off to the Send screen', () => {
  const request = (over: Record<string, unknown> = {}) => {
    const parsed = parseConnectRequest(pay(over))
    if (!parsed.ok || parsed.request.type !== 'pay') throw new Error('fixture')
    return parsed.request
  }

  it('names USDC by Veil\'s own issuer and locks the asset', () => {
    const q = new URLSearchParams(sendPathFor(request(), ISSUER).split('?')[1])
    expect(q.get('to')).toBe(G_ADDRESS)
    expect(q.get('amount')).toBe('20')
    expect(q.get('asset')).toBe('USDC')
    expect(q.get('issuer')).toBe(ISSUER)
    expect(q.get('lock')).toBe('asset')
  })

  it('names no asset for XLM', () => {
    const q = new URLSearchParams(sendPathFor(request({ asset: 'XLM' }), ISSUER).split('?')[1])
    expect(q.get('asset')).toBeNull()
    expect(q.get('issuer')).toBeNull()
  })
})
