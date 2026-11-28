/**
 * @jest-environment node
 *
 * Node, not a browser: the server parser pulls in the model client.
 */
import { parseChatRequest } from '@veil/agent-core'

import { agentChatBody } from '../agentChatBody'

// Made-up, well-formed addresses.
const WALLET = 'C' + 'A'.repeat(55)
const FEE_PAYER = 'G' + 'B'.repeat(55)

describe('agentChatBody', () => {
  it('always carries the wallet address, with or without a session', () => {
    const base = { message: 'hi', walletAddress: WALLET, history: [] }
    expect(agentChatBody({ ...base, sessionToken: '' }).walletAddress).toBe(WALLET)
    expect(agentChatBody({ ...base, sessionToken: null }).walletAddress).toBe(WALLET)
    expect(agentChatBody({ ...base, sessionToken: 'token' }).walletAddress).toBe(WALLET)
  })

  it('a message with no session is accepted by the server parser', () => {
    // This is the request that went out as a 400 when the address was dropped:
    // a dismissed passkey prompt, a classic wallet, or a token not accepted.
    const body = agentChatBody({
      message: 'what is my balance?',
      walletAddress: WALLET,
      feePayerAddress: FEE_PAYER,
      history: [{ role: 'user', content: 'hello' }],
      sessionToken: '',
    })
    const parsed = parseChatRequest(JSON.parse(JSON.stringify(body)))
    expect(parsed.ok).toBe(true)
  })

  it('the same body without the address is what the server refuses', () => {
    const { walletAddress: _dropped, ...withoutAddress } = agentChatBody({ message: 'hi', walletAddress: WALLET, history: [] })
    const parsed = parseChatRequest(withoutAddress)
    expect(parsed).toEqual({ ok: false, error: 'walletAddress is not a Stellar address' })
  })

  it('leaves out an empty token, fee payer and profile instead of sending blanks', () => {
    const body = agentChatBody({ message: 'hi', walletAddress: WALLET, history: [], sessionToken: '', feePayerAddress: '' })
    expect(Object.keys(body).sort()).toEqual(['history', 'message', 'walletAddress'])
  })
})
