import { describe, it, expect } from '@jest/globals'
import {
  fetchPortfolioSummary,
  classifyPortfolioKind,
  type BlendPositionItem,
  type InFlightTransfer,
} from '../portfolio.js'
import { USDT0_MAINNET_ISSUER, USDY_MAINNET_ISSUER } from '../assets.js'
import { runAgent } from '../agent.js'
import type { LlmProvider, LlmTurn } from '../llm.js'

const FAKE_ISSUER = 'GC35JBERU4SFTDVOF32A2SIJN5FHSLSZFZSGP6VVFWCZNDVGJFLQBANK'
const USDC_ISSUER = 'GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN'

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

describe('classifyPortfolioKind', () => {
  it('classifies native XLM as cash with native verification in wallet', () => {
    const res = classifyPortfolioKind('XLM', null)
    expect(res).toEqual({ kind: 'cash', verification: 'native', location: 'wallet' })
  })

  it('classifies verified USDC as cash with verified label', () => {
    const res = classifyPortfolioKind('USDC', USDC_ISSUER)
    expect(res).toEqual({ kind: 'cash', verification: 'verified', location: 'wallet' })
  })

  it('classifies verified USDY as invest with verified label', () => {
    const res = classifyPortfolioKind('USDY', USDY_MAINNET_ISSUER)
    expect(res).toEqual({ kind: 'invest', verification: 'verified', location: 'invest' })
  })

  it('classifies authentic USDT0 as cash', () => {
    const res = classifyPortfolioKind('USDT0', USDT0_MAINNET_ISSUER)
    expect(res).toEqual({ kind: 'cash', verification: 'verified', location: 'wallet' })
  })

  it('classifies counterfeit USDT0 as invest with unverified label, never cash', () => {
    const res = classifyPortfolioKind('USDT0', FAKE_ISSUER)
    expect(res).toEqual({ kind: 'invest', verification: 'unverified', location: 'wallet' })
  })
})

describe('fetchPortfolioSummary', () => {
  const mockBalances = async () => ({
    XLM: '500.0000000',
    [`USDC:${USDC_ISSUER}`]: '1000.0000000',
    [`USDY:${USDY_MAINNET_ISSUER}`]: '200.0000000',
  })

  const mockBlend = async (): Promise<BlendPositionItem[]> => [
    {
      poolId: 'CAJJZSGMMM3PD7N33TAPHGBUGTB43OC73HVIK2L2G6BNGGGYOSSYBXBD',
      asset: 'CCONTRACTUSDC',
      assetCode: 'USDC',
      deposited: '100000000', // 10 USDC (in stroops)
    },
  ]

  const mockPrices = async (from: string) => {
    if (from.startsWith('XLM')) return { price: 0.12 }
    if (from.startsWith('USDC')) return { price: 1.0 }
    if (from.startsWith('USDY')) return { price: 1.05 }
    return { price: 1.0 }
  }

  const mockInFlight = async (): Promise<InFlightTransfer[]> => [
    {
      type: 'sent',
      amount: '50.0000000',
      asset: 'USDC',
      counterparty: 'GDEMO1234',
      status: 'in_flight',
    },
  ]

  it('assembles a fully-reachable portfolio matching sum of parts', async () => {
    const res = await fetchPortfolioSummary('GFEEPAYER', 'CWALLET', {
      getBalances: mockBalances,
      loadBlendPositions: mockBlend,
      getPrice: mockPrices,
      getInFlight: mockInFlight,
    })

    expect(res.missingComponents).toHaveLength(0)
    expect(res.lines.length).toBe(4) // XLM, USDC, USDY, Blend USDC

    // Check lines
    const xlmLine = res.lines.find((l) => l.code === 'XLM')!
    expect(xlmLine).toBeDefined()
    expect(xlmLine.issuer).toBeNull()
    expect(xlmLine.location).toBe('wallet')
    expect(xlmLine.valueUsd).toBe(60) // 500 * 0.12

    const blendLine = res.lines.find((l) => l.location === 'Blend lending')!
    expect(blendLine).toBeDefined()
    expect(blendLine.amount).toBe('10.0000000')
    expect(blendLine.valueUsd).toBe(10) // 10 * 1.0

    const usdyLine = res.lines.find((l) => l.code === 'USDY')!
    expect(usdyLine).toBeDefined()
    expect(usdyLine.issuer).toBe(USDY_MAINNET_ISSUER)
    expect(usdyLine.location).toBe('invest')
    expect(usdyLine.valueUsd).toBe(210) // 200 * 1.05

    // Total: 60 (XLM) + 1000 (wallet USDC) + 210 (USDY) + 10 (Blend USDC) = 1280
    expect(res.totalUsd).toBe(1280)
    expect(res.cashUsd).toBe(1060) // 60 + 1000
    expect(res.lendingUsd).toBe(10)
    expect(res.investUsd).toBe(210)
    expect(res.totalUsd).toBe((res.cashUsd ?? 0) + (res.lendingUsd ?? 0) + (res.investUsd ?? 0))

    expect(res.inFlight).toHaveLength(1)
    expect(res.summarySentence).toContain('1,280.00 total')
    expect(res.summarySentence).not.toContain('excluding')
  })

  it('handles Blend single-source failure without omitting from notice', async () => {
    const res = await fetchPortfolioSummary('GFEEPAYER', 'CWALLET', {
      getBalances: mockBalances,
      loadBlendPositions: async () => {
        throw new Error('Blend node 503')
      },
      getPrice: mockPrices,
      getInFlight: mockInFlight,
    })

    expect(res.missingComponents).toContain('Blend, which I could not reach')
    // Total is 1270 (excluding Blend)
    expect(res.totalUsd).toBe(1270)
    expect(res.lendingUsd).toBeNull()
    expect(res.summarySentence).toContain('excluding Blend, which I could not reach')
  })

  it('handles Price feed single-source failure', async () => {
    const res = await fetchPortfolioSummary('GFEEPAYER', 'CWALLET', {
      getBalances: async () => ({ XLM: '100.0000000' }),
      loadBlendPositions: async () => [],
      getPrice: async () => {
        throw new Error('Lens aggregator timeout')
      },
      getInFlight: async () => [],
    })

    const xlmLine = res.lines.find((l) => l.code === 'XLM')!
    expect(xlmLine.status).toBe('unavailable')
    expect(xlmLine.valueUsd).toBeNull()
    expect(res.totalUsd).toBeNull()
    expect(res.summarySentence).toContain('total USD value cannot be fully calculated')
  })

  it('handles Balances / Horizon single-source failure', async () => {
    const res = await fetchPortfolioSummary('GFEEPAYER', 'CWALLET', {
      getBalances: async () => {
        throw new Error('Horizon 504')
      },
      loadBlendPositions: mockBlend,
      getPrice: mockPrices,
      getInFlight: async () => [],
    })

    expect(res.missingComponents).toContain('Wallet balances (Horizon unavailable)')
    // Only Blend lines appear
    expect(res.lines).toHaveLength(1)
    expect(res.lines[0].location).toBe('Blend lending')
    expect(res.totalUsd).toBe(10)
    expect(res.summarySentence).toContain('excluding Wallet balances, which I could not reach')
  })

  it('handles In-flight / Wraith single-source failure', async () => {
    const res = await fetchPortfolioSummary('GFEEPAYER', 'CWALLET', {
      getBalances: mockBalances,
      loadBlendPositions: async () => [],
      getPrice: mockPrices,
      getInFlight: async () => {
        throw new Error('Wraith offline')
      },
    })

    expect(res.missingComponents).toContain('In-flight transfers (Wraith unavailable)')
    expect(res.inFlight).toHaveLength(0)
    expect(res.summarySentence).toContain('excluding In-flight transfers, which I could not reach')
  })

  it('flags unverified/counterfeit assets by exact issuer and isolates them', async () => {
    const res = await fetchPortfolioSummary('GFEEPAYER', 'CWALLET', {
      getBalances: async () => ({
        [`USDT0:${FAKE_ISSUER}`]: '500.0000000',
      }),
      loadBlendPositions: async () => [],
      getPrice: async () => {
        throw new Error('No pool')
      },
      getInFlight: async () => [],
    })

    expect(res.lines).toHaveLength(1)
    const line = res.lines[0]
    expect(line.code).toBe('USDT0')
    expect(line.issuer).toBe(FAKE_ISSUER)
    expect(line.verification).toBe('unverified')
    expect(line.kind).toBe('invest') // Never classified as cash
    expect(line.valueUsd).toBeNull()
  })
})

describe('get_portfolio agent tool execution', () => {
  it('executes get_portfolio through runAgent and returns honest breakdown', async () => {
    const llm = scripted([
      { text: '', toolCalls: [{ id: 'call_1', name: 'get_portfolio', input: {} }] },
      { text: 'Here is what you have.', toolCalls: [] },
    ])

    const result = await runAgent('what do I have', 'CWALLET', [], 'GFEEPAYER', undefined, llm, {
      portfolioLoaders: {
        getBalances: async () => ({ XLM: '100.0000000' }),
        loadBlendPositions: async () => [],
        getPrice: async () => ({ price: 0.12 }),
        getInFlight: async () => [],
      },
    })
    expect(result.response).toBe('Here is what you have.')
    expect(llm.results).toHaveLength(1)

    const toolJson = JSON.parse(llm.results[0][0].content)
    expect(toolJson).toHaveProperty('summarySentence')
    expect(toolJson).toHaveProperty('lines')
    expect(toolJson).toHaveProperty('missingComponents')
    expect(toolJson.totalUsd).toBe(12)
    expect(toolJson.summarySentence).toContain('$12.00 total')
  })
})
