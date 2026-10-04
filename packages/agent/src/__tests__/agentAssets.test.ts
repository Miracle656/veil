import { describe, it, expect, jest } from '@jest/globals'
import type { LlmProvider, LlmTurn } from '../llm.js'
import { USDT0_MAINNET_ISSUER, USDT0_MAINNET_SAC } from '../assets.js'

/**
 * The tool RESULTS the model receives for asset questions — asserted directly,
 * not the model's closing text, which is whatever the scripted provider says.
 */

const FAKE = 'GC35JBERU4SFTDVOF32A2SIJN5FHSLSZFZSGP6VVFWCZNDVGJFLQBANK'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const mockGetBalances: any = jest.fn()

jest.unstable_mockModule('../txBuilder.js', () => ({
  getBalances: mockGetBalances,
  buildPayment: jest.fn(),
}))

const { runAgent } = await import('../agent.js')

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

async function toolResult(name: string, input: Record<string, unknown>) {
  const llm = scripted([
    { text: '', toolCalls: [{ id: 't', name, input }] },
    { text: 'ok', toolCalls: [] },
  ])
  await runAgent('q', 'CWALLET', [], 'GFEEPAYER', undefined, llm)
  return JSON.parse(llm.results[0][0].content)
}

describe('get_wallet_balance', () => {
  it('tells a wallet holding a fake USDT0 it is unverified, with the issuer', async () => {
    mockGetBalances.mockResolvedValue({ XLM: '1.0000000', [`USDT0:${FAKE}`]: '50.0000000' })
    const out = await toolResult('get_wallet_balance', { address: 'GFEEPAYER' })
    expect(out.holdings).toHaveLength(1)
    expect(out.holdings[0]).toMatchObject({ code: 'USDT0', issuer: FAKE, status: 'unverified' })
    expect(out.holdings[0].message).toContain(FAKE)
    expect(out.holdings[0].message).toMatch(/UNVERIFIED/)
  })

  it('tells a wallet holding the real USDT0 which issuer it is', async () => {
    mockGetBalances.mockResolvedValue({ XLM: '1.0000000', [`USDT0:${USDT0_MAINNET_ISSUER}`]: '5.0000000' })
    const out = await toolResult('get_wallet_balance', { address: 'GFEEPAYER' })
    expect(out.holdings[0]).toMatchObject({ status: 'verified', issuer: USDT0_MAINNET_ISSUER })
    expect(out.holdings[0].message).toContain(USDT0_MAINNET_ISSUER)
  })

  it('never aliases one holding to the registry on code alone when both are held', async () => {
    mockGetBalances.mockResolvedValue({
      [`USDT0:${FAKE}`]: '1.0000000',
      [`USDT0:${USDT0_MAINNET_ISSUER}`]: '2.0000000',
    })
    const out = await toolResult('get_wallet_balance', { address: 'GFEEPAYER' })
    const byIssuer = Object.fromEntries(out.holdings.map((h: { issuer: string; status: string }) => [h.issuer, h.status]))
    expect(byIssuer).toEqual({ [FAKE]: 'unverified', [USDT0_MAINNET_ISSUER]: 'verified' })
  })

  it('keeps the flat balances the model already relied on', async () => {
    mockGetBalances.mockResolvedValue({ XLM: '3.0000000' })
    const out = await toolResult('get_wallet_balance', { address: 'GFEEPAYER' })
    expect(out.XLM).toBe('3.0000000')
    expect(out.holdings).toEqual([])
  })
})

describe('get_asset_info', () => {
  it('answers "what is USDT0" with the verified issuer, SAC and clawback/freeze property', async () => {
    const out = await toolResult('get_asset_info', { asset: 'USDT0' })
    expect(out).toMatchObject({
      status: 'verified',
      issuer: USDT0_MAINNET_ISSUER,
      sac: USDT0_MAINNET_SAC,
      issuerControls: { clawback: true, freeze: true },
    })
    expect(out.message).toMatch(/claw back/)
  })

  it('flags a specific impostor issuer', async () => {
    const out = await toolResult('get_asset_info', { asset: `USDT0:${FAKE}` })
    expect(out.status).toBe('unverified')
  })
})
