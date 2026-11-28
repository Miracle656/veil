/**
 * The bytes the agent login ceremony signs.
 *
 * Kept dependency-free (no stellar-sdk, no node builtins) so the wallet's
 * client bundle can import it: the page composes exactly these bytes and the
 * agent route recomputes them before verifying — one definition, both sides.
 * The purpose line is what makes an agent-login signature useless for any
 * other Veil operation, and any other Veil signature useless here.
 */

/** The purpose bound into the signed bytes. */
export const AGENT_LOGIN_PURPOSE = 'veil-agent-login-v1'

/**
 * The exact bytes the client signs for an agent login: the purpose line, then
 * the challenge token.
 */
export function agentLoginMessage(challenge: string): Uint8Array {
  return new TextEncoder().encode(`${AGENT_LOGIN_PURPOSE}\n${challenge}`)
}
