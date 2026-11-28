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
  getAssetIssuer,
  isRegisteredIssuer,
  verifiedAsset,
  formatAssetLabel,
  sacContractIdForCode,
  getAssetControlDisclosure,
  fetchIssuerFlags,
  fetchAssetDisclosure,
  stellarAssetTypeForCode,
  ALL_REGISTERED_ASSETS,
  registeredAsset,
  classifyHolding,
  classifyBalances,
  describeAsset,
  deriveSac,
  USDY_MAINNET_ISSUER,
  USDC_MAINNET_ISSUER,
  USDC_TESTNET_ISSUER,
  EURC_MAINNET_ISSUER,
  AQUA_MAINNET_ISSUER,
  USDT0_MAINNET_ISSUER,
  USDT0_MAINNET_SAC,
  ETHERFUSE_MAINNET_ISSUER,
  KNOWN_SAC_CONTRACT_IDS,
  DISCLOSURE_UNAVAILABLE,
  type RegisteredAsset,
  type VerifiedAsset,
  type Holding,
  type HoldingStatus,
  type AssetAnswer,
  type HorizonIssuerFlags,
} from './assets.js'

export {
  createAgentAuth,
  verifyAgentMessage,
  addressForAgentKey,
  isAuthFailure,
  agentLoginMessage,
  AGENT_MESSAGE_DOMAIN,
  AGENT_LOGIN_PURPOSE,
  FACTORY_BY_NETWORK,
  DEFAULT_CHALLENGE_TTL_MS,
  DEFAULT_SESSION_TTL_MS,
  type AgentAuth,
  type AgentAuthOptions,
  type AgentSignedMessage,
  type AuthFailure,
  type ChallengeIssued,
  type SessionOpened,
  type VerifyContext,
} from './auth.js'

export {
  parseAuthenticatedChatRequest,
  parseAuthenticatedClearHistoryRequest,
  parseClaimedAddress,
} from './handler.js'
