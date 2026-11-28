import { agentChatBody } from '../agentChatBody'

// Made-up, well-formed addresses.
const WALLET = 'C' + 'A'.repeat(55)
const FEE_PAYER = 'G' + 'B'.repeat(55)

/**
 * The server's session-less path (parseChatRequest in packages/agent) refuses
 * a body whose walletAddress is not a Stellar address. These tests pin the
 * client half: the address is in every body, whatever the session state.
 */
describe('agentChatBody', () => {
  const base = { message: 'hi', walletAddress: WALLET, history: [] }

  it.each([
    ['no token (prompt dismissed, classic wallet)', ''],
    ['a null token', null],
    ['an undefined token', undefined],
    ['a session token', 'token'],
  ])('carries the wallet address with %s', (_label, sessionToken) => {
    const body = agentChatBody({ ...base, sessionToken })
    expect(body.walletAddress).toBe(WALLET)
    expect(body.walletAddress).toMatch(/^[GC][A-Z2-7]{55}$/)
  })

  it('survives being sent as JSON with the address intact', () => {
    const sent = JSON.parse(
      JSON.stringify(
        agentChatBody({
          message: 'what is my balance?',
          walletAddress: WALLET,
          feePayerAddress: FEE_PAYER,
          history: [{ role: 'user', content: 'hello' }],
          sessionToken: '',
        }),
      ),
    )
    expect(sent).toEqual({
      message: 'what is my balance?',
      walletAddress: WALLET,
      feePayerAddress: FEE_PAYER,
      history: [{ role: 'user', content: 'hello' }],
    })
  })

  it('leaves out an empty token, fee payer and profile instead of sending blanks', () => {
    const body = agentChatBody({ ...base, sessionToken: '', feePayerAddress: '' })
    expect(Object.keys(body).sort()).toEqual(['history', 'message', 'walletAddress'])
  })

  it('sends the token only when there is one', () => {
    expect(agentChatBody({ ...base, sessionToken: 'abc' }).sessionToken).toBe('abc')
    expect('sessionToken' in agentChatBody({ ...base, sessionToken: '' })).toBe(false)
  })
})
