import { describe, it, expect, jest, afterEach, beforeEach } from '@jest/globals'
import {
  deepseekProvider,
  providerFromEnv,
  DEFAULT_DEEPSEEK_MODEL,
  DEEPSEEK_URL,
} from '../llm.js'
import { runAgent } from '../agent.js'

const realFetch = globalThis.fetch
const originalEnv = process.env

beforeEach(() => {
  process.env = { ...originalEnv }
  delete process.env.LLM_PROVIDER
  delete process.env.OPENROUTER_API_KEY
  delete process.env.DEEPSEEK_API_KEY
  delete process.env.DEEPSEEK_MODEL
  delete process.env.AGENT_MODELS
})

afterEach(() => {
  globalThis.fetch = realFetch
  process.env = originalEnv
})

function reply(status: number, body: unknown) {
  return {
    ok: status < 400,
    status,
    statusText: status === 200 ? 'OK' : 'Error',
    json: async () => body,
  }
}

describe('DeepSeek Provider (Issue #802)', () => {
  it('LLM_PROVIDER=deepseek with DEEPSEEK_API_KEY returns a working provider whose label names the model', () => {
    process.env.LLM_PROVIDER = 'deepseek'
    process.env.DEEPSEEK_API_KEY = 'mock-key'

    const provider = providerFromEnv()
    expect(provider.label).toBe(`deepseek:${DEFAULT_DEEPSEEK_MODEL}`)

    // With explicit model override
    process.env.DEEPSEEK_MODEL = 'deepseek-v4-pro'
    const providerCustom = providerFromEnv()
    expect(providerCustom.label).toBe('deepseek:deepseek-v4-pro')
  })

  it('LLM_PROVIDER=deepseek with no key throws an error naming DEEPSEEK_API_KEY', () => {
    process.env.LLM_PROVIDER = 'deepseek'
    delete process.env.DEEPSEEK_API_KEY

    expect(() => providerFromEnv()).toThrow('LLM_PROVIDER=deepseek needs DEEPSEEK_API_KEY')
  })

  it('Existing deployments are unaffected: with only OPENROUTER_API_KEY set, returns OpenRouter, and with only ANTHROPIC_API_KEY, returns Anthropic', () => {
    process.env.OPENROUTER_API_KEY = 'mock-openrouter-key'
    const orProvider = providerFromEnv()
    expect(orProvider.label).toMatch(/^openrouter:/)

    delete process.env.OPENROUTER_API_KEY
    process.env.ANTHROPIC_API_KEY = 'mock-anthropic-key'
    const anthropicProvider = providerFromEnv()
    expect(anthropicProvider.label).toMatch(/^anthropic:/)
  })

  it('with only DEEPSEEK_API_KEY set and no forced provider, selects DeepSeek', () => {
    process.env.DEEPSEEK_API_KEY = 'mock-deepseek-key'
    const provider = providerFromEnv()
    expect(provider.label).toBe(`deepseek:${DEFAULT_DEEPSEEK_MODEL}`)
  })

  describe('Error handling & error distinction', () => {
    it('insufficient balance is distinguished and clearly reported', async () => {
      globalThis.fetch = jest.fn(async () =>
        reply(402, { error: { code: 402, message: 'Insufficient Balance: prepaid account exhausted' } }),
      ) as any

      const provider = deepseekProvider({ apiKey: 'mock-key' })
      const session = provider.start('sys', [], 'hi', [])

      await expect(session.next()).rejects.toThrow(/DeepSeek insufficient balance: Insufficient Balance/)
    })

    it('rate limiting (429) is distinguished and clearly reported', async () => {
      globalThis.fetch = jest.fn(async () =>
        reply(429, { error: { code: 429, message: 'Rate limit exceeded: 60 rpm' } }),
      ) as any

      const provider = deepseekProvider({ apiKey: 'mock-key' })
      const session = provider.start('sys', [], 'hi', [])

      await expect(session.next()).rejects.toThrow(/DeepSeek rate limit exceeded: Rate limit exceeded/)
    })

    it('authentication failure (401) is distinguished and clearly reported', async () => {
      globalThis.fetch = jest.fn(async () =>
        reply(401, { error: { code: 401, message: 'Invalid API key provided' } }),
      ) as any

      const provider = deepseekProvider({ apiKey: 'mock-key' })
      const session = provider.start('sys', [], 'hi', [])

      await expect(session.next()).rejects.toThrow(/DeepSeek authentication failed: Invalid API key/)
    })

    it('an empty reply throws and does not enter the tool loop', async () => {
      globalThis.fetch = jest.fn(async () =>
        reply(200, { choices: [{ message: { content: '', tool_calls: [] } }] }),
      ) as any

      const provider = deepseekProvider({ apiKey: 'mock-key' })
      const session = provider.start('sys', [], 'hi', [])

      await expect(session.next()).rejects.toThrow('DeepSeek returned an empty reply')
    })

    it('upstream server failures are distinguishable', async () => {
      globalThis.fetch = jest.fn(async () =>
        reply(502, { error: { code: 502, message: 'Bad Gateway from model worker' } }),
      ) as any

      const provider = deepseekProvider({ apiKey: 'mock-key' })
      const session = provider.start('sys', [], 'hi', [])

      await expect(session.next()).rejects.toThrow(/DeepSeek provider error: 502 Bad Gateway/)
    })
  })

  describe('Multi-turn tool calling end to end', () => {
    it('completes a multi-turn tool call through the agent loop with existing tools (open_swap)', async () => {
      let callCount = 0
      const fetchMock = jest.fn(async (url: unknown, init: any) => {
        expect(url).toBe(DEEPSEEK_URL)
        expect(init.headers.Authorization).toBe('Bearer mock-key')
        callCount++

        if (callCount === 1) {
          // Turn 1: Model requests open_swap tool
          return reply(200, {
            choices: [
              {
                message: {
                  content: null,
                  tool_calls: [
                    {
                      id: 'call_swap_123',
                      type: 'function',
                      function: {
                        name: 'open_swap',
                        arguments: JSON.stringify({
                          from_asset: 'XLM',
                          to_asset: 'USDC',
                          amount: '50',
                        }),
                      },
                    },
                  ],
                },
              },
            ],
          })
        }

        // Turn 2: Verify tool result was sent in the messages array
        const body = JSON.parse(init.body)
        const toolMsg = body.messages.find((m: any) => m.role === 'tool')
        expect(toolMsg).toBeDefined()
        expect(toolMsg.tool_call_id).toBe('call_swap_123')
        expect(toolMsg.content).toContain('swap_screen_ready')

        // Model returns final assistant message
        return reply(200, {
          choices: [
            {
              message: {
                content: 'I have set up your swap of 50 XLM to USDC in the Swap screen.',
                tool_calls: null,
              },
            },
          ],
        })
      })

      globalThis.fetch = fetchMock as any

      const provider = deepseekProvider({ apiKey: 'mock-key' })
      const result = await runAgent('swap 50 XLM to USDC', 'CWALLET', [], undefined, undefined, provider)

      expect(fetchMock).toHaveBeenCalledTimes(2)
      expect(result.swapIntent).toEqual({ from: 'XLM', to: 'USDC', amount: '50' })
      expect(result.response).toBe('I have set up your swap of 50 XLM to USDC in the Swap screen.')
    })
  })
})
