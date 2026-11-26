import { describe, it, expect, jest } from '@jest/globals'
import { runAgent, fetchHistory } from '../agent.js'
import type { LlmProvider, LlmTurn, ToolSpec } from '../llm.js'

const INVEST_ISSUER = 'GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN'
const TEST_ADDRESS = 'GC35JBERU4SFTDVOF32A2SIJN5FHSLSZFZSGP6VVFWCZNDVGJFLQBANK'
const COUNTERPARTY_ADDRESS = 'GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5'

/**
 * The agent loop, against a scripted provider — no model, no key, no network.
 *
 * Covers what the provider change must not break (tool results reach the model,
 * a transaction reaches the user) and the bound that was missing: the loop used
 * to run for as long as the model kept asking for tools.
 */

function scripted(turns: LlmTurn[]): LlmProvider & {
  results: { id: string; content: string }[][]
  systemPrompts: string[]
  availableTools: ToolSpec[]
} {
  const results: { id: string; content: string }[][] = []
  const systemPrompts: string[] = []
  const availableTools: ToolSpec[] = []
  return {
    label: 'scripted',
    results,
    systemPrompts,
    availableTools,
    start(system, _history, _userMessage, tools) {
      systemPrompts.push(system)
      availableTools.push(...tools)
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

  it('never repeats a bank account number in its response', async () => {
    const llm = scripted([{ text: 'The account number is 0123456789.', toolCalls: [] }])
    const result = await runAgent(
      'My Nigerian bank account number is 0123456789.',
      wallet,
      [],
      undefined,
      undefined,
      llm,
    )

    expect(result.response).not.toContain('0123456789')
    expect(result.response).toContain('[account number hidden]')
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
    expect(llm.systemPrompts[0]).toContain('open_swap:')
    expect(llm.systemPrompts[0]).toContain('(Screen: Swap screen)')
  })

  it('answers out-of-scope requests with a capability boundary and a registered screen', async () => {
    const llm = scripted([
      {
        text: 'I cannot see Solana balances from this chat. The Wallet screen shows your Stellar balances.',
        toolCalls: [],
      },
    ])
    const result = await runAgent('What is my SOL balance on Solana?', wallet, [], undefined, undefined, llm)

    expect(result.response).toMatch(/cannot see Solana balances/i)
    expect(result.response).toMatch(/Wallet screen/)
    expect(llm.systemPrompts[0]).toContain('REGISTERED CAPABILITIES (generated from the tools available to you)')
    expect(llm.systemPrompts[0]).toContain('get_wallet_balance:')
    expect(llm.systemPrompts[0]).toContain('(Screen: Wallet screen)')
    expect(llm.systemPrompts[0]).toContain('CAPABILITY BOUNDARY')
  })

  it('refuses to estimate a price when no registered price source can provide it', async () => {
    const llm = scripted([
      {
        text: '',
        toolCalls: [{ id: 'p', name: 'get_price', input: { asset_a: 'XLM', asset_b: 'ETH' } }],
      },
      { text: 'ETH trades at 12.4 XLM.', toolCalls: [] },
    ])
    const result = await runAgent('What is the current XLM price in ETH?', wallet, [], undefined, undefined, llm)

    expect(llm.results[0][0].content).toMatch(/unavailable.*cannot see.*Do not estimate/i)
    expect(result.response).toMatch(/cannot see it here/i)
    expect(result.response).toMatch(/won't estimate it/i)
    expect(result.response).not.toMatch(/\d+(?:\.\d+)?\s*(?:ETH|XLM)/i)
    expect(llm.systemPrompts[0]).toContain('Never estimate or infer a requested number.')
    expect(llm.systemPrompts[0]).toContain('get_price provides current Stellar market data only.')
  })

  it('reports an unavailable cash-out as unavailable and never creates an order', async () => {
    const fetchMock = jest.spyOn(global, 'fetch').mockResolvedValue({
      ok: false,
      status: 503,
      json: async () => ({ error: 'Cash-out is not configured' }),
    } as Response)
    try {
      const llm = scripted([
        { text: '', toolCalls: [{ id: 'r', name: 'get_offramp_rate', input: {} }] },
        { text: 'This is unavailable because your account is invalid.', toolCalls: [] },
      ])
      const result = await runAgent(
        'Cash out 25000 naira',
        wallet,
        [],
        undefined,
        undefined,
        llm,
        { wraithUrl: 'https://wraith.test' },
      )

      expect(JSON.parse(llm.results[0][0].content)).toEqual({ available: false, status: 'unavailable' })
      expect(result.response).toMatch(/Cash-out is unavailable right now/i)
      expect(result.response).not.toMatch(/account is invalid/i)
      expect(result.cashOutIntent).toBeUndefined()
      expect(fetchMock).toHaveBeenCalledTimes(1)
      expect(fetchMock.mock.calls[0][0]).toBe('https://wraith.test/offramp/rate')
      expect(llm.availableTools.map((tool) => tool.name)).not.toContain('create_offramp_order')
    } finally {
      fetchMock.mockRestore()
    }
  })

  it('tells an unverified user to verify their bank on Cash Out, not in chat', async () => {
    const fetchMock = jest.spyOn(global, 'fetch').mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ rate: 1500, currency: 'NGN', coin: 'USDC' }),
    } as Response)
    try {
      const llm = scripted([
        { text: '', toolCalls: [{ id: 'r', name: 'get_offramp_rate', input: {} }] },
        { text: '', toolCalls: [{ id: 'p', name: 'prepare_cash_out', input: { amount_ngn: 25000 } }] },
        { text: 'Your account is ready.', toolCalls: [] },
      ])
      const result = await runAgent(
        "I haven't verified my bank account. Cash out 25000 naira.",
        wallet,
        [],
        undefined,
        undefined,
        llm,
        { wraithUrl: 'https://wraith.test' },
      )

      expect(result.response).toMatch(/select and verify your bank account on the Cash Out screen/i)
      expect(result.response).not.toMatch(/account is ready/i)
      expect(result.cashOutIntent).toEqual({ amountNGN: 25000, rate: 1500 })
      expect(llm.availableTools.map((tool) => tool.name)).not.toContain('verify_bank_account')
      expect(llm.availableTools.find((tool) => tool.name === 'prepare_cash_out')?.input_schema.properties)
        .toEqual({ amount_ngn: expect.any(Object) })
      expect(fetchMock).toHaveBeenCalledTimes(1)
    } finally {
      fetchMock.mockRestore()
    }
  })

  it('hands off the requested amount and live rate without creating an order or sending a deposit', async () => {
    const fetchMock = jest.spyOn(global, 'fetch').mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ rate: 1525.75, currency: 'NGN', coin: 'USDC' }),
    } as Response)
    try {
      const llm = scripted([
        { text: '', toolCalls: [{ id: 'r', name: 'get_offramp_rate', input: {} }] },
        { text: '', toolCalls: [{ id: 'p', name: 'prepare_cash_out', input: { amount_ngn: 30000 } }] },
        {
          text: '',
          toolCalls: [
            {
              id: 'pay',
              name: 'build_payment',
              input: { to_address: 'GDEPOSIT', asset: 'USDC', amount: 20, wallet_address: 'GFEEPAYER' },
            },
          ],
        },
        { text: 'Cash-out prepared.', toolCalls: [] },
      ])
      const result = await runAgent(
        'Cash out 30000 naira',
        wallet,
        [],
        undefined,
        undefined,
        llm,
        { wraithUrl: 'https://wraith.test' },
      )

      expect(JSON.parse(llm.results[0][0].content)).toMatchObject({
        available: true,
        rate: 1525.75,
        currency: 'NGN',
        coin: 'USDC',
      })
      expect(JSON.parse(llm.results[1][0].content)).toMatchObject({
        status: 'cash_out_screen_ready',
        amountNGN: 30000,
        rate: 1525.75,
      })
      expect(result.cashOutIntent).toEqual({ amountNGN: 30000, rate: 1525.75 })
      expect(result.pendingTxXdr).toBeUndefined()
      expect(result.response).toMatch(/Cash Out screen/)
      expect(JSON.parse(llm.results[2][0].content)).toMatchObject({
        error: 'Cash-out deposits must be sent from the Cash Out screen.',
      })
      expect(fetchMock).toHaveBeenCalledTimes(1)
      expect(fetchMock.mock.calls[0][0]).toBe('https://wraith.test/offramp/rate')
      expect(llm.availableTools.map((tool) => tool.name)).not.toContain('create_offramp_order')
      expect(llm.availableTools.map((tool) => tool.name)).not.toContain('verify_bank_account')
    } finally {
      fetchMock.mockRestore()
    }
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
    expect(result.response).toMatch(/Invest section|Earn screen|Invest screen/)
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

  it('history helper returns operations from Horizon operations feed', async () => {
    const fetchMock = jest.spyOn(globalThis, 'fetch').mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({
        _embedded: {
          records: [
            {
              id: 'op_101',
              type: 'invoke_host_function',
              created_at: '2026-11-24T10:00:00Z',
              asset_balance_changes: [
                {
                  type: 'transfer',
                  asset_type: 'credit_alphanum4',
                  asset_code: 'USDC',
                  asset_issuer: INVEST_ISSUER,
                  from: TEST_ADDRESS,
                  to: COUNTERPARTY_ADDRESS,
                  amount: '42.5000000',
                },
              ],
            },
          ],
        },
      }),
    } as Response)

    try {
      const output = await fetchHistory(TEST_ADDRESS, 10, 'mainnet', {
        horizonUrl: 'https://horizon.stellar.org',
      })
      expect(output).toContain('Sent')
      expect(output).toContain('42.5000000')
      expect(output).toContain('USDC')
      expect(fetchMock).toHaveBeenCalled()
      const calledUrl = fetchMock.mock.calls[0][0] as string
      expect(calledUrl).toContain('/accounts/' + TEST_ADDRESS + '/operations')
    } finally {
      fetchMock.mockRestore()
    }
  })

  it('history helper returns indexer transfers when indexer answers', async () => {
    const fetchMock = jest.spyOn(globalThis, 'fetch').mockImplementation(async (url: any) => {
      const urlStr = String(url)
      if (urlStr.includes('/operations')) {
        return {
          ok: true,
          status: 200,
          json: async () => ({ _embedded: { records: [] } }),
        } as Response
      }
      if (urlStr.includes('/transfers/address/')) {
        return {
          ok: true,
          status: 200,
          json: async () => ({
            hasMore: false,
            nextCursor: null,
            limit: 10,
            offset: 0,
            transfers: [
              {
                id: 1,
                eventType: 'transfer',
                fromAddress: COUNTERPARTY_ADDRESS,
                toAddress: TEST_ADDRESS,
                amount: '100',
                ledger: 12345,
                ledgerClosedAt: '2026-11-24T10:00:00Z',
                txHash: '0xabc123',
                contractId: 'C123',
              },
            ],
          }),
        } as Response
      }
      return { ok: false, status: 404 } as Response
    })

    try {
      const output = await fetchHistory(TEST_ADDRESS, 10, 'mainnet', {
        wraithUrl: 'https://wraith.test',
        horizonUrl: 'https://horizon.stellar.org',
      })
      expect(output).toContain('Received')
      expect(output).toContain('100')
      expect(fetchMock).toHaveBeenCalled()
      const wraithCall = fetchMock.mock.calls.find((c) => String(c[0]).includes('/transfers/address/'))
      expect(String(wraithCall?.[0])).toContain('network=mainnet')
    } finally {
      fetchMock.mockRestore()
    }
  })

  it('/history 5000 is clamped to 50', async () => {
    const fetchMock = jest.spyOn(globalThis, 'fetch').mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ _embedded: { records: [] } }),
    } as Response)

    try {
      const llm = scripted([])
      await runAgent('/history 5000', wallet, [], TEST_ADDRESS, undefined, llm, {
        horizonUrl: 'https://horizon.stellar.org',
      })
      expect(fetchMock).toHaveBeenCalled()
      const calledUrl = String(fetchMock.mock.calls[0][0])
      expect(calledUrl).toContain('limit=50')
      expect(calledUrl).not.toContain('limit=5000')
    } finally {
      fetchMock.mockRestore()
    }
  })

  it('/history -1 is clamped to 1', async () => {
    const fetchMock = jest.spyOn(globalThis, 'fetch').mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ _embedded: { records: [] } }),
    } as Response)

    try {
      const llm = scripted([])
      await runAgent('/history -1', wallet, [], TEST_ADDRESS, undefined, llm, {
        horizonUrl: 'https://horizon.stellar.org',
      })
      expect(fetchMock).toHaveBeenCalled()
      const calledUrl = String(fetchMock.mock.calls[0][0])
      expect(calledUrl).toContain('limit=1')
    } finally {
      fetchMock.mockRestore()
    }
  })

  it('a failed Horizon read is reported as a failed read', async () => {
    const fetchMock = jest.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('Horizon offline'))

    try {
      const output = await fetchHistory(TEST_ADDRESS, 10, 'mainnet', {
        horizonUrl: 'https://horizon.stellar.org',
      })
      expect(output).toContain('could not be read')
      expect(output).not.toContain("You don't have any recent transactions")
    } finally {
      fetchMock.mockRestore()
    }
  })

  it('a failed indexer read is reported as a failed read', async () => {
    const fetchMock = jest.spyOn(globalThis, 'fetch').mockImplementation(async (url: any) => {
      const urlStr = String(url)
      if (urlStr.includes('/operations')) {
        return {
          ok: true,
          status: 200,
          json: async () => ({ _embedded: { records: [] } }),
        } as Response
      }
      throw new Error('Wraith indexer timeout')
    })

    try {
      const output = await fetchHistory(TEST_ADDRESS, 10, 'mainnet', {
        wraithUrl: 'https://wraith.test',
        horizonUrl: 'https://horizon.stellar.org',
      })
      expect(output).toContain('could not be read')
      expect(output).not.toContain("You don't have any recent transactions")
    } finally {
      fetchMock.mockRestore()
    }
  })

  it('get_transfer_history with valid address succeeds', async () => {
    const fetchMock = jest.spyOn(globalThis, 'fetch').mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({
        _embedded: {
          records: [
            {
              id: 'op_payment_1',
              type: 'payment',
              created_at: '2026-11-24T11:00:00Z',
              from: COUNTERPARTY_ADDRESS,
              to: TEST_ADDRESS,
              amount: '75.0000000',
              asset_type: 'native',
            },
          ],
        },
      }),
    } as Response)

    try {
      const llm = scripted([
        {
          text: '',
          toolCalls: [
            {
              id: 'th1',
              name: 'get_transfer_history',
              input: { address: TEST_ADDRESS, direction: 'both', limit: 10 },
            },
          ],
        },
        { text: 'Here is your history.', toolCalls: [] },
      ])

      const result = await runAgent('show my transfer history', wallet, [], TEST_ADDRESS, undefined, llm, {
        horizonUrl: 'https://horizon.stellar.org',
      })

      const toolResult = llm.results[0][0].content
      expect(toolResult).toContain('Received')
      expect(toolResult).toContain('75.0000000')
      expect(toolResult).toContain('XLM')
      expect(toolResult).toContain(COUNTERPARTY_ADDRESS)
      expect(result.response).toBe('Here is your history.')
    } finally {
      fetchMock.mockRestore()
    }
  })
})
