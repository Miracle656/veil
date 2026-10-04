import { describe, it, expect } from '@jest/globals'
import { runAgent } from '../agent.js'
import type { LlmProvider, LlmTurn } from '../llm.js'

const INVEST_ISSUER = 'GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN'

/**
 * The agent loop, against a scripted provider — no model, no key, no network.
 *
 * Covers what the provider change must not break (tool results reach the model,
 * a transaction reaches the user) and the bound that was missing: the loop used
 * to run for as long as the model kept asking for tools.
 */

function scripted(turns: LlmTurn[]): LlmProvider & { results: { id: string; content: string }[][] } {
  const results: { id: string; content: string }[][] = []
  return {
    label: 'scripted',
    results,
    start() {
      let i = 0
      return {
        async next() {
          return turns[Math.min(i++, turns.length - 1)]
        },
        addToolResults(r) {
          results.push(r)
        },
      }
    },
  }
}

const wallet = 'CWALLET'

describe('runAgent', () => {
  it('returns the model text when no tools are called', async () => {
    const llm = scripted([{ text: 'Hello!', toolCalls: [] }])
    const result = await runAgent('hi', wallet, [], undefined, undefined, llm)
    expect(result.response).toBe('Hello!')
    expect(result.pendingTxXdr).toBeUndefined()
  })

  it('hands a transaction to the user for approval, with the tool result threaded back', async () => {
    const llm = scripted([
      {
        text: '',
        toolCalls: [
          {
            id: 'call_1',
            name: 'request_user_approval',
            input: { transaction_xdr: 'AAAA', summary: 'Send 1 XLM' },
          },
        ],
      },
      { text: 'Approve the payment in your wallet.', toolCalls: [] },
    ])

    const result = await runAgent('send 1 xlm', wallet, [], undefined, undefined, llm)

    expect(result.pendingTxXdr).toBe('AAAA')
    expect(result.pendingTxSummary).toBe('Send 1 XLM')
    expect(result.response).toBe('Approve the payment in your wallet.')
    expect(llm.results).toEqual([[{ id: 'call_1', content: JSON.stringify({ status: 'awaiting_approval' }) }]])
  })

  it('reports an unknown tool to the model instead of throwing', async () => {
    const llm = scripted([
      { text: '', toolCalls: [{ id: 'c', name: 'drain_wallet', input: {} }] },
      { text: 'Sorry, I cannot do that.', toolCalls: [] },
    ])
    const result = await runAgent('x', wallet, [], undefined, undefined, llm)
    expect(result.response).toBe('Sorry, I cannot do that.')
    expect(llm.results[0][0].content).toMatch(/Unknown tool/)
  })

  it('stops a model that never stops calling tools', async () => {
    const forever: LlmTurn = {
      text: '',
      toolCalls: [{ id: 'loop', name: 'request_user_approval', input: { transaction_xdr: 'X', summary: 's' } }],
    }
    const llm = scripted([forever])
    const result = await runAgent('loop', wallet, [], undefined, undefined, llm)

    expect(result.response).toMatch(/couldn't finish/)
    // Bounded: eight rounds of tool results, then it gives up.
    expect(llm.results).toHaveLength(8)
  })

  it('hands a swap to the Swap screen instead of building one', async () => {
    const llm = scripted([
      { text: '', toolCalls: [{ id: 's', name: 'open_swap', input: { from_asset: 'xlm', to_asset: 'USDC', amount: '10' } }] },
      { text: 'Opening Swap with 10 XLM to USDC.', toolCalls: [] },
    ])
    const result = await runAgent('swap 10 xlm to usdc', wallet, [], undefined, undefined, llm)
    expect(result.swapIntent).toEqual({ from: 'XLM', to: 'USDC', amount: '10' })
    expect(result.pendingTxXdr).toBeUndefined()
  })

  it('hands an issued asset to the Earn screen', async () => {
    const issuer = INVEST_ISSUER
    const llm = scripted([
      { text: '', toolCalls: [{ id: 'i', name: 'open_invest', input: { asset_code: 'USDY', asset_issuer: issuer, amount: '50' } }] },
      { text: 'Opening Earn.', toolCalls: [] },
    ])
    const result = await runAgent('buy 50 USDY', wallet, [], undefined, undefined, llm)
    expect(result.investIntent).toEqual({ asset: { code: 'USDY', issuer }, amount: '50' })
  })

  it('refuses a malformed investment intent', async () => {
    const llm = scripted([
      { text: '', toolCalls: [{ id: 'i', name: 'open_invest', input: { asset_code: 'USDY', asset_issuer: 'not-an-issuer', amount: '50' } }] },
      { text: 'done', toolCalls: [] },
    ])
    const result = await runAgent('buy USDY', wallet, [], undefined, undefined, llm)
    expect(result.investIntent).toBeUndefined()
    expect(llm.results[0][0].content).toMatch(/error/)
  })

  it("keeps a prepared investment when only the model's closing reply fails", async () => {
    const issuer = INVEST_ISSUER
    let calls = 0
    const llm: LlmProvider = {
      label: 'flaky',
      start() {
        return {
          async next() {
            calls += 1
            if (calls === 1) {
              return { text: '', toolCalls: [{ id: 'i', name: 'open_invest', input: { asset_code: 'USDY', asset_issuer: issuer, amount: '50' } }] }
            }
            throw new Error('Model provider error: all busy')
          },
          addToolResults() {},
        }
      },
    }
    const result = await runAgent('buy USDY', wallet, [], undefined, undefined, llm)
    expect(result.investIntent).toEqual({ asset: { code: 'USDY', issuer }, amount: '50' })
    expect(result.response).toMatch(/Earn screen/)
  })

  it('refuses a swap between unsupported or identical assets, and a malformed amount', async () => {
    for (const input of [
      { from_asset: 'XLM', to_asset: 'SCAMCOIN' },
      { from_asset: 'USDC', to_asset: 'USDC' },
      { from_asset: 'XLM', to_asset: 'USDC', amount: '10e9' },
    ]) {
      const llm = scripted([
        { text: '', toolCalls: [{ id: 'x', name: 'open_swap', input }] },
        { text: 'done', toolCalls: [] },
      ])
      const result = await runAgent('swap', wallet, [], undefined, undefined, llm)
      expect(result.swapIntent).toBeUndefined()
      expect(llm.results[0][0].content).toMatch(/error/)
    }
  })

  it("keeps a prepared swap when only the model's closing reply fails", async () => {
    let calls = 0
    const llm: LlmProvider = {
      label: 'flaky',
      start() {
        return {
          async next() {
            calls += 1
            if (calls === 1) {
              return { text: '', toolCalls: [{ id: 's', name: 'open_swap', input: { from_asset: 'XLM', to_asset: 'USDC' } }] }
            }
            throw new Error('Model provider error: all busy')
          },
          addToolResults() {},
        }
      },
    }
    const result = await runAgent('swap xlm to usdc', wallet, [], undefined, undefined, llm)
    expect(result.swapIntent).toEqual({ from: 'XLM', to: 'USDC' })
    expect(result.response).toMatch(/Swap screen/)
  })
})
