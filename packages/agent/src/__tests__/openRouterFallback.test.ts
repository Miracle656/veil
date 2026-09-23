import { describe, it, expect, jest, afterEach } from '@jest/globals'
import { openRouterProvider } from '../llm.js'

/**
 * Every free model sits behind one provider, so a 503 from one is routine. The
 * agent went down on 2026-09-22 when a single combined request got a 503 and the
 * error kept only the status. These pin the per-model fallback.
 */

const realFetch = globalThis.fetch
afterEach(() => {
  globalThis.fetch = realFetch
})

function reply(status: number, body: unknown) {
  return { ok: status < 400, status, statusText: '', json: async () => body }
}

function session(models = ['a:free', 'b:free', 'c:free']) {
  return openRouterProvider({ apiKey: 'k', models }).start('sys', [], 'hi', [])
}

describe('OpenRouter fallback', () => {
  it('moves to the next model when one is overloaded', async () => {
    const calls: string[] = []
    globalThis.fetch = jest.fn(async (_url: unknown, init: any) => {
      const model = JSON.parse(init.body).model
      calls.push(model)
      return model === 'a:free'
        ? reply(503, { error: { code: 503, message: 'Provider overloaded' } })
        : reply(200, { choices: [{ message: { content: 'hello' } }] })
    }) as any

    await expect(session().next()).resolves.toEqual({ text: 'hello', toolCalls: [] })
    expect(calls).toEqual(['a:free', 'b:free'])
  })

  it("stops at once on the account's rate limit — the next model would hit it too", async () => {
    const fetchMock = jest.fn(async () => reply(429, { error: { code: 429, message: 'free-models-per-day' } }))
    globalThis.fetch = fetchMock as any
    await expect(session().next()).rejects.toThrow(/busy right now/)
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it("keeps each model's reason for the server log when all fail", async () => {
    globalThis.fetch = jest.fn(async () =>
      reply(404, { error: { code: 404, message: 'No endpoints found matching your data policy' } }),
    ) as any
    await expect(session(['a:free', 'b:free']).next()).rejects.toThrow(/data policy.*\|.*data policy/)
  })

  it("moves on when a model's own provider is rate-limited", async () => {
    const calls: string[] = []
    globalThis.fetch = jest.fn(async (_url: unknown, init: any) => {
      const model = JSON.parse(init.body).model
      calls.push(model)
      return model === 'a:free'
        ? reply(429, { error: { code: 429, message: 'Provider returned error', metadata: { provider_name: 'Chutes' } } })
        : reply(200, { choices: [{ message: { content: 'hi' } }] })
    }) as any
    await expect(session().next()).resolves.toEqual({ text: 'hi', toolCalls: [] })
    expect(calls).toEqual(['a:free', 'b:free'])
  })

  it('treats an empty reply as that model failing, and asks the next', async () => {
    const calls: string[] = []
    globalThis.fetch = jest.fn(async (_url: unknown, init: any) => {
      const model = JSON.parse(init.body).model
      calls.push(model)
      return model === 'a:free'
        ? reply(200, { choices: [{ message: { content: '' }, finish_reason: 'length' }] })
        : reply(200, { choices: [{ message: { content: 'XLM is 0.21 USDC' } }] })
    }) as any
    await expect(session().next()).resolves.toEqual({ text: 'XLM is 0.21 USDC', toolCalls: [] })
    expect(calls).toEqual(['a:free', 'b:free'])
  })

  it('tries the whole list again when every model was rate-limited', async () => {
    let attempts = 0
    globalThis.fetch = jest.fn(async () => {
      attempts += 1
      return attempts <= 3
        ? reply(429, { error: { code: 429, message: 'Provider returned error', metadata: { provider_name: 'X' } } })
        : reply(200, { choices: [{ message: { content: 'second pass' } }] })
    }) as any

    const result = await session().next()
    expect(result.text).toBe('second pass')
    // Three models in the first pass, then the first model of the second.
    expect(attempts).toBe(4)
  }, 15_000)
})
