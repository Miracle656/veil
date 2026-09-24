import { describe, it, expect } from '@jest/globals'
import { runAgent } from '../agent.js'
import type { LlmProvider, LlmTurn } from '../llm.js'
import { USDY_MAINNET_ISSUER, ASSET_REGISTRY } from '../assets.js'

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

describe('runAgent - Invest Asset Queries', () => {
  it('returns a hand-off object with correct pre-filled fields for a buy request, never a transaction', async () => {
    const llm = scripted([
      {
        text: '',
        toolCalls: [
          {
            id: 'call_invest',
            name: 'open_invest',
            input: { code: 'USDY', amount: '50', quoteCurrency: 'USDC' },
          },
        ],
      },
      {
        text: `USDY is issued by Ondo Finance (address: ${USDY_MAINNET_ISSUER}) — review the asset details on the next screen before confirming.`,
        toolCalls: [],
      },
    ])

    const result = await runAgent('buy 50 USDC of USDY', wallet, [], undefined, undefined, llm)

    expect(result.pendingTxXdr).toBeUndefined()
    expect(result.investIntent).toEqual({
      code: 'USDY',
      issuer: USDY_MAINNET_ISSUER,
      amount: '50',
      quoteCurrency: 'USDC',
    })
    expect(result.response).toContain(USDY_MAINNET_ISSUER)
    expect(result.response).toContain('Ondo Finance')
    expect(result.response).toContain('review the asset details on the next screen before confirming')
  })

  it('returns a flat refusal with a pointer to the invest screen for a "should I buy" question', async () => {
    const llm = scripted([
      {
        text: 'I cannot give investment advice. Please review the asset details and metrics on the Invest screen to decide.',
        toolCalls: [],
      },
    ])

    const result = await runAgent('should I buy USDY?', wallet, [], undefined, undefined, llm)

    expect(result.pendingTxXdr).toBeUndefined()
    expect(result.swapIntent).toBeUndefined()
    expect(result.investIntent).toBeUndefined()
    expect(result.response).toMatch(/cannot give investment advice|refuse|Invest screen/i)
    expect(result.response).not.toMatch(/buy now|good opportunity|strong buy|bullish/i)
  })

  it('returns registry data, not hallucinated issuer info, for an explain question ("What is USDY?")', async () => {
    const llm = scripted([
      {
        text: '',
        toolCalls: [
          {
            id: 'call_info',
            name: 'get_asset_info',
            input: { code: 'USDY' },
          },
        ],
      },
      {
        text: `USDY (Ondo US Dollar Yield) is a treasury token issued by Ondo Finance (Address: ${ASSET_REGISTRY.USDY.issuer}, Home Domain: ${ASSET_REGISTRY.USDY.homeDomain}).`,
        toolCalls: [],
      },
    ])

    const result = await runAgent('What is USDY?', wallet, [], undefined, undefined, llm)

    expect(llm.results[0][0].content).toContain(USDY_MAINNET_ISSUER)
    expect(llm.results[0][0].content).toContain('Ondo Finance')
    expect(llm.results[0][0].content).toContain('ondo.finance')
    expect(llm.results[0][0].content).toContain('treasury')
    expect(result.response).toContain(USDY_MAINNET_ISSUER)
    expect(result.response).toContain('Ondo Finance')
  })

  it('returns an honest "unavailable", not a made-up number, when price lookup returns no data', async () => {
    const llm = scripted([
      {
        text: '',
        toolCalls: [
          {
            id: 'call_price',
            name: 'get_price',
            input: { asset_a: 'UNKNOWNASSET:GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5', asset_b: 'USDC' },
          },
        ],
      },
      {
        text: 'Price data is currently unavailable for UNKNOWNASSET.',
        toolCalls: [],
      },
    ])

    const result = await runAgent('what is the price of UNKNOWNASSET', wallet, [], undefined, undefined, llm)

    expect(llm.results[0][0].content).toContain('unavailable')
    expect(result.response).toMatch(/unavailable/i)
    expect(result.response).not.toMatch(/\$?\d+\.\d+/)
  })
})
