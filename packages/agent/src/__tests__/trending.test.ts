import { jest, describe, it, expect, afterEach } from '@jest/globals'
import { getTrendingActivity } from '../trending.js'
import { runAgent } from '../agent.js'
import type { LlmProvider, LlmTurn } from '../llm.js'

const UNKNOWN_ISSUER = 'GC35JBERU4SFTDVOF32A2SIJN5FHSLSZFZSGP6VVFWCZNDVGJFLQBANK'
const USDC_ISSUER = 'GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN'

function scripted(turns: LlmTurn[]): LlmProvider & { results: { id: string; content: string }[][] } {
  const results: { id: string; content: string }[][] = []
  return {
    label: 'scripted',
    results,
    start() {
      let i = 0
      return {
        async next() { return turns[Math.min(i++, turns.length - 1)] },
        addToolResults(value) { results.push(value) },
      }
    },
  }
}

afterEach(() => {
  jest.restoreAllMocks()
})

describe('get_trending_activity', () => {
  it('labels an unknown Lens feed issuer unverified and attributes measured volume', async () => {
    const fetchSpy = jest.spyOn(global, 'fetch')
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ data: { listPairs: [`SCAM:${UNKNOWN_ISSUER}/USDC:${USDC_ISSUER}`] } }),
      } as Response)
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          data: {
            p0: {
              assetA: `SCAM:${UNKNOWN_ISSUER}`,
              assetB: `USDC:${USDC_ISSUER}`,
              pairKey: `SCAM:${UNKNOWN_ISSUER}/USDC:${USDC_ISSUER}`,
              volume24h: 1234.5,
              lastUpdated: '2026-10-16T12:00:00.000Z',
            },
          },
        }),
      } as Response)

    const result = await getTrendingActivity('https://lens.example')

    expect(fetchSpy).toHaveBeenCalledTimes(2)
    expect(result).toMatchObject({ source: 'Lens GraphQL getPrice.volume24h', window: '24h' })
    expect(result.pairs[0]).toMatchObject({ volume: 1234.5, window: '24h' })
    expect(result.pairs[0].assets).toContainEqual({ code: 'SCAM', issuer: UNKNOWN_ISSUER, status: 'unverified' })
    expect(result.pairs[0].assets).toContainEqual(expect.objectContaining({ code: 'USDC', issuer: USDC_ISSUER }))
  })

  it('reports a Lens outage in the model-visible tool result', async () => {
    jest.spyOn(global, 'fetch').mockRejectedValue(new Error('Lens unavailable'))
    const llm = scripted([
      { text: '', toolCalls: [{ id: 'activity', name: 'get_trending_activity', input: {} }] },
      { text: 'I cannot see the market right now.', toolCalls: [] },
    ])

    await runAgent('What is trending on Stellar?', 'CWALLET', [], undefined, undefined, llm, {
      lensUrl: 'https://lens.example',
    })

    expect(llm.results[0][0].content).toContain('I cannot see the market right now')
  })
})
