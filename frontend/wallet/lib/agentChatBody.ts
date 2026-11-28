/**
 * The body of a chat request to /api/agent.
 *
 * `walletAddress` is always present. With a session the server checks it
 * against the session's wallet and refuses a mismatch; without one (the
 * person dismissed the passkey prompt, uses a classic wallet, or the token
 * was not accepted) it is the only thing that says whose question this is.
 * A body without it is refused with a 400 before the assistant sees anything.
 */
export interface AgentChatBody {
  message: string
  walletAddress: string
  feePayerAddress?: string
  profile?: unknown
  history: { role: 'user' | 'assistant'; content: string }[]
  sessionToken?: string
}

export function agentChatBody(input: {
  message: string
  walletAddress: string
  feePayerAddress?: string | null
  profile?: unknown
  history: { role: 'user' | 'assistant'; content: string }[]
  sessionToken?: string | null
}): AgentChatBody {
  return {
    message: input.message,
    walletAddress: input.walletAddress,
    ...(input.feePayerAddress ? { feePayerAddress: input.feePayerAddress } : {}),
    ...(input.profile !== undefined ? { profile: input.profile } : {}),
    history: input.history,
    ...(input.sessionToken ? { sessionToken: input.sessionToken } : {}),
  }
}
