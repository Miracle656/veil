/**
 * @veil/agent — Library exports
 *
 * Use createVeilAgent() to spin up an agent instance with your own API key.
 * The agent manages conversation history, x402 micropayments, and tool execution.
 *
 * @example
 * ```typescript
 * import { createVeilAgent } from '@veil/agent'
 *
 * const agent = createVeilAgent({
 *   anthropicApiKey: 'sk-ant-...',
 *   agentKeypairSecret: 'S...',
 *   oracleUrl: 'https://oracle.example.com',
 *   wraithUrl: 'https://wraith.example.com',
 * })
 *
 * const result = await agent.chat('What is my balance?', {
 *   walletAddress: 'CABC...',
 *   feePayerAddress: 'GABC...',
 *   profile: { name: 'Alice', role: 'trader', language: 'English' },
 * })
 * ```
 */
export {
  createVeilAgent,
  type AgentConfig,
  type AgentResult,
  type ChatOptions,
  type InvestIntent,
  type SwapIntent,
  type UserProfile,
  type VeilAgent,
} from './agent.js'

export {
  ASSET_REGISTRY,
  getRegisteredAsset,
  isRegisteredIssuer,
  type RegisteredAsset,
} from './assets.js'
