import { describe, it, expect } from '@jest/globals'
import { runAgent } from '../agent.js'
import type { LlmProvider, LlmTurn, ToolSpec } from '../llm.js'

interface CapturedRequest {
  system: string
  tools: ToolSpec[]
  results: { id: string; content: string }[]
}

function scripted(turns: LlmTurn[], captured?: CapturedRequest): LlmProvider {
  return {
    label: 'scripted',
    start(system, _history, _userMessage, tools) {
      if (captured) Object.assign(captured, { system, tools })
      let i = 0
      return {
        async next() {
          return turns[Math.min(i++, turns.length - 1)]
        },
        addToolResults(results) {
          captured?.results.push(...results)
        },
      }
    },
  }
}

const wallet = 'CWALLET'

describe('agent capabilities', () => {
  it('answers an in-scope asset question using the registered asset lookup tool', async () => {
    const captured = { system: '', tools: [] as ToolSpec[], results: [] as { id: string; content: string }[] }
    const llm = scripted([
      { text: '', toolCalls: [{ id: 'asset', name: 'get_asset_info', input: { code: 'USDY' } }] },
      { text: 'USDY is issued by Ondo Finance.', toolCalls: [] },
    ], captured)

    const result = await runAgent('What is USDY?', wallet, [], undefined, undefined, llm)

    expect(result.response).toContain('Ondo Finance')
    expect(captured.results[0].content).toContain('Ondo Finance')
  })

  it('answers out-of-scope requests with a screen from the generated tool capabilities', async () => {
    const captured = { system: '', tools: [] as ToolSpec[], results: [] as { id: string; content: string }[] }
    const llm = scripted([
      { text: 'I cannot stake XLM from chat. Check the Earn screen for available options.', toolCalls: [] },
    ], captured)

    const result = await runAgent('Can you stake XLM?', wallet, [], undefined, undefined, llm)

    expect(result.response).toMatch(/cannot.*stake/i)
    expect(result.response).toMatch(/Earn screen/i)
    for (const tool of captured.tools) {
      expect(captured.system).toContain(`- ${tool.name}: ${tool.description}`)
    }
    expect(captured.system).toContain('REGISTERED CAPABILITIES (generated from the tools available in this agent)')
  })

  it('refuses to estimate a number without a registered data source', async () => {
    const captured = { system: '', tools: [] as ToolSpec[], results: [] as { id: string; content: string }[] }
    const llm = scripted([
      { text: 'I cannot see your Ethereum balance. Check your Ethereum wallet screen.', toolCalls: [] },
    ], captured)

    const result = await runAgent('What is my ETH balance on Ethereum?', wallet, [], undefined, undefined, llm)

    expect(result.response).toMatch(/cannot see/i)
    expect(result.response).not.toMatch(/\d/)
    expect(captured.system).toMatch(/do not estimate, guess, or use remembered data/i)
  })
})
