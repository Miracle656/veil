jest.mock('@sentry/nextjs', () => ({ init: jest.fn() }), { virtual: true })

import * as SentryMock from '@sentry/nextjs'
import {
  getSentryOptIn,
  setSentryOptIn,
  scrubEvent,
  initSentry,
  resetSentryInitForTesting,
} from '../sentry'

beforeEach(() => {
  localStorage.clear()
  jest.clearAllMocks()
  resetSentryInitForTesting()
})

describe('getSentryOptIn / setSentryOptIn', () => {
  it('defaults to false', () => {
    expect(getSentryOptIn()).toBe(false)
  })

  it('round-trips true', () => {
    setSentryOptIn(true)
    expect(getSentryOptIn()).toBe(true)
  })

  it('round-trips false after true', () => {
    setSentryOptIn(true)
    setSentryOptIn(false)
    expect(getSentryOptIn()).toBe(false)
  })

  it('returns false for arbitrary stored value', () => {
    localStorage.setItem('veil_sentry_opt_in', 'yes')
    expect(getSentryOptIn()).toBe(false)
  })
})

describe('scrubEvent', () => {
  function makeEvent(message: string) {
    return { message, exception: undefined }
  }

  it('scrubs Stellar public address from message', () => {
    const addr = 'G' + 'A'.repeat(55)
    const event = makeEvent(`sent 5 XLM to ${addr}`)
    const result = scrubEvent(event as any)
    expect(result?.message).not.toContain(addr)
    expect(result?.message).toContain('[address]')
  })

  it('scrubs Stellar secret key from message', () => {
    const secret = 'S' + 'A'.repeat(55)
    const event = makeEvent(`key=${secret}`)
    const result = scrubEvent(event as any)
    expect(result?.message).not.toContain(secret)
    expect(result?.message).toContain('[secret]')
  })

  it('scrubs amounts with asset suffix from message', () => {
    const event = makeEvent('transferred 12.5 XLM to friend')
    const result = scrubEvent(event as any)
    expect(result?.message).not.toMatch(/12\.5 XLM/)
    expect(result?.message).toContain('[amount]')
  })

  it('scrubs exception value', () => {
    const addr = 'G' + 'B'.repeat(55)
    const event = {
      message: undefined,
      exception: { values: [{ value: `Error sending to ${addr}` }] },
    }
    const result = scrubEvent(event as any)
    expect(result?.exception?.values?.[0]?.value).not.toContain(addr)
    expect(result?.exception?.values?.[0]?.value).toContain('[address]')
  })

  it('returns the event unchanged when no PII present', () => {
    const event = makeEvent('TypeError: Cannot read properties of undefined')
    const result = scrubEvent(event as any)
    expect(result?.message).toBe('TypeError: Cannot read properties of undefined')
  })
})

describe('initSentry', () => {
  it('does not call Sentry.init when opt-in is off (default)', () => {
    initSentry()
    expect(SentryMock.init).not.toHaveBeenCalled()
  })

  it('calls Sentry.init when opted in', () => {
    setSentryOptIn(true)
    initSentry()
    expect(SentryMock.init).toHaveBeenCalledTimes(1)
    const cfg = (SentryMock.init as jest.Mock).mock.calls[0][0]
    expect(cfg).toMatchObject({
      tracesSampleRate: 0,
      environment: expect.any(String),
    })
    expect(typeof cfg.beforeSend).toBe('function')
  })

  it('is idempotent — second call does not re-init', () => {
    setSentryOptIn(true)
    initSentry()
    initSentry()
    expect(SentryMock.init).toHaveBeenCalledTimes(1)
  })
})
