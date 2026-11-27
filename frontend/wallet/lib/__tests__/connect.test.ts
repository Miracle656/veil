import {
  CONNECT_APPS,
  CONNECT_TEST_APPS,
  MAX_PAY_AMOUNT,
  decodePending,
  encodePending,
  getConnectApp,
  isAllowedContract,
  isAllowedOrigin,
  parseConnectRequest,
  referenceMemo,
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

  it('writes the reference on the payment as a text memo, unchanged', () => {
    const q = new URLSearchParams(sendPathFor(request({ reference: 'order_AB-123' }), ISSUER).split('?')[1])
    expect(q.get('memo')).toBe('order_AB-123')
    expect(q.get('memo_type')).toBe('text')
    // 28 characters is the most a text memo holds.
    const longest = 'a'.repeat(28)
    expect(referenceMemo(longest)).toBe(longest)
  })

  it('sends no memo rather than a shortened reference', () => {
    // A UUID is 36 characters. Cutting it would match nothing on the app's side.
    const uuid = '3f2b8c1e-9d4a-4b7c-8e21-5a6f0c9d1e2b'
    expect(referenceMemo(uuid)).toBeNull()
    const q = new URLSearchParams(sendPathFor(request({ reference: uuid }), ISSUER).split('?')[1])
    expect(q.get('memo')).toBeNull()
    expect(q.get('memo_type')).toBeNull()
  })

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

describe('contract calls (invoke)', () => {
  const invoke = (over: Record<string, unknown> = {}) => ({
    type: 'invoke',
    id: ID,
    contract: C_ADDRESS,
    method: 'join_challenge',
    args: [
      { type: 'address', value: C_ADDRESS },
      { type: 'u32', value: '7' },
      { type: 'i128', value: '50000000' },
    ],
    ...over,
  })
  const reason = (raw: unknown) => {
    const r = parseConnectRequest(raw)
    return r.ok ? null : r.reason
  }

  it('accepts a well-formed call and keeps only the fields it knows', () => {
    const r = parseConnectRequest(invoke({ extra: 'dropped', xdr: 'AAAA' }))
    expect(r).toEqual({
      ok: true,
      request: {
        type: 'invoke',
        id: ID,
        contract: C_ADDRESS,
        method: 'join_challenge',
        args: [
          { type: 'address', value: C_ADDRESS },
          { type: 'u32', value: '7' },
          { type: 'i128', value: '50000000' },
        ],
      },
    })
  })

  it('accepts a call with no arguments', () => {
    const r = parseConnectRequest(invoke({ args: undefined }))
    expect(r.ok && r.request.type === 'invoke' && r.request.args).toEqual([])
  })

  it('refuses a contract that is an account, or not an address', () => {
    expect(reason(invoke({ contract: G_ADDRESS }))).toMatch(/contract/)
    expect(reason(invoke({ contract: 'C123' }))).toMatch(/contract/)
  })

  it('refuses a function name that is not a symbol', () => {
    for (const method of ['', 'has space', 'x'.repeat(33), '9lives', 'a-b', 42]) {
      expect(reason(invoke({ method }))).toMatch(/function name/)
    }
  })

  it('refuses arguments that are not what their type says', () => {
    const bad: [string, unknown][] = [
      ['u32', '-1'],
      ['u32', '4294967296'],
      ['i32', '2147483648'],
      ['u64', '18446744073709551616'],
      ['i128', '170141183460469231731687303715884105728'],
      ['u128', '1.5'],
      ['address', 'not-an-address'],
      ['bool', 'yes'],
      ['symbol', 'has space'],
      ['bytes', 'abc'],
      ['string', 'x'.repeat(257)],
      ['u32', 7],
      ['vec', '[]'],
    ]
    for (const [type, value] of bad) {
      expect(reason(invoke({ args: [{ type, value }] }))).toMatch(/Argument 1/)
    }
  })

  it('accepts the largest and smallest values each number type holds', () => {
    const edge: [string, string][] = [
      ['u32', '4294967295'],
      ['i32', '-2147483648'],
      ['u64', '18446744073709551615'],
      ['i128', '-170141183460469231731687303715884105728'],
      ['u128', '340282366920938463463374607431768211455'],
    ]
    for (const [type, value] of edge) {
      expect(reason(invoke({ args: [{ type, value }] }))).toBeNull()
    }
  })

  it('refuses too many arguments, or arguments that are not a list', () => {
    expect(reason(invoke({ args: Array(13).fill({ type: 'u32', value: '1' }) }))).toMatch(/at most 12/)
    expect(reason(invoke({ args: 'u32:1' }))).toMatch(/not a list/)
  })

  it('survives being stored and read back', () => {
    const parsed = parseConnectRequest(invoke())
    if (!parsed.ok) throw new Error(parsed.reason)
    const origin = CONNECT_APPS.stakesync.origins[0]
    const back = decodePending(encodePending({ appId: 'stakesync', origin, request: parsed.request }))
    expect(back?.request).toEqual(parsed.request)
  })

  describe('which contracts an app may ask for', () => {
    const app = { id: 'fit', name: 'Fit', origins: ['https://fit.example'], contracts: { testnet: [C_ADDRESS] } }

    it('allows only a listed contract, on the network it is listed for', () => {
      expect(isAllowedContract(app, 'testnet', C_ADDRESS)).toBe(true)
      expect(isAllowedContract(app, 'mainnet', C_ADDRESS)).toBe(false)
      expect(isAllowedContract(app, 'testnet', 'C' + 'D'.repeat(55))).toBe(false)
    })

    it('allows nothing for an app with no list', () => {
      expect(isAllowedContract({ id: 'x', name: 'X', origins: [] }, 'mainnet', C_ADDRESS)).toBe(false)
    })

    it('no live or partner-test app may call any contract it likes', () => {
      for (const listed of [...Object.values(CONNECT_APPS), ...Object.values(CONNECT_TEST_APPS)]) {
        expect(listed.anyContract).toBeUndefined()
      }
    })

    it('the local demo app may, and only exists when demo is allowed', () => {
      expect(getConnectApp('demo')).toBeNull()
      const demo = getConnectApp('demo', true)
      expect(demo && isAllowedContract(demo, 'mainnet', C_ADDRESS)).toBe(true)
    })
  })
})
