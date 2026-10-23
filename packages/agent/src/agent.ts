import {
  anthropicProvider,
  deepseekProvider,
  openRouterProvider,
  type ChatTurn,
  type LlmProvider,
} from './llm.js'
import { HORIZON_URL, NETWORK, SOROBAN_RPC_URL } from './network.js'
import { classifyBalances, describeAsset, getRegisteredAsset } from './assets.js'
import { getPrice } from './price.js'
import { buildPayment, getBalances } from './txBuilder.js'
import { getTrendingActivity } from './trending.js'
import { StrKey } from '@stellar/stellar-sdk'
import { redactSensitive, toModelTools, type VeilTool } from './boundary.js'

// ── Agent configuration ──────────────────────────────────────────────────────

export interface AgentConfig {
  /** Anthropic API key. Falls back to ANTHROPIC_API_KEY env var. */
  anthropicApiKey?: string
  /** OpenRouter API key. When set, free OpenRouter models are used instead of Claude. */
  openRouterApiKey?: string
  /** DeepSeek API key. When set, DeepSeek model is used instead of Claude/OpenRouter. */
  deepSeekApiKey?: string
  /** DeepSeek model ID. Default: deepseek-flash. */
  deepSeekModel?: string
  /** OpenRouter model ids, in preference order. Default: llm.ts DEFAULT_FREE_MODELS. */
  models?: string[]
  /** A ready-made provider; overrides the keys above. */
  provider?: LlmProvider
  /** Optional transfer indexer (Wraith) for Soroban token history. Horizon covers classic payments. */
  wraithUrl?: string
  /** Lens market-data API base URL. Defaults to LENS_URL or the hosted Lens service. */
  lensUrl?: string
  /** Horizon URL. Default: follows STELLAR_NETWORK (mainnet unless set to testnet). */
  horizonUrl?: string
  /** Soroban RPC URL. Default: follows STELLAR_NETWORK. */
  sorobanRpcUrl?: string
  /** Stellar network: "testnet" or "mainnet". Default: STELLAR_NETWORK, else "mainnet". */
  network?: string
  /** Claude model ID (Anthropic provider only). Default: CLAUDE_MODEL, else "claude-opus-5". */
  model?: string
  /** Max conversation history turns to keep per wallet. Default: 20. */
  maxHistoryTurns?: number
}

// ── Resolved config (with defaults filled in) ────────────────────────────────

interface ResolvedConfig {
  llm: LlmProvider
  wraithUrl: string
  lensUrl: string
  horizonUrl: string
  sorobanRpcUrl: string
  network: string
  maxHistoryTurns: number
}

function resolveConfig(config: AgentConfig): ResolvedConfig {
  let llm: LlmProvider
  if (config.provider) {
    llm = config.provider
  } else if (config.openRouterApiKey) {
    // Same order as providerFromEnv(). The two selectors disagreeing about
    // precedence would make an SDK consumer and a deployment pick differently
    // from the same set of keys.
    llm = openRouterProvider({ apiKey: config.openRouterApiKey, models: config.models })
  } else if (config.deepSeekApiKey) {
    llm = deepseekProvider({ apiKey: config.deepSeekApiKey, model: config.deepSeekModel })
  } else {
    llm = anthropicProvider({ apiKey: config.anthropicApiKey, model: config.model })
  }

  return {
    llm,
    wraithUrl: config.wraithUrl ?? '',
    lensUrl: config.lensUrl ?? process.env.LENS_URL?.trim() ?? 'https://lens-ldtu.onrender.com',
    horizonUrl: config.horizonUrl ?? HORIZON_URL,
    sorobanRpcUrl: config.sorobanRpcUrl ?? SOROBAN_RPC_URL,
    network: config.network ?? NETWORK,
    maxHistoryTurns: config.maxHistoryTurns ?? 20,
  }
}

/** Model rounds per user message before the agent gives up. */
const MAX_TOOL_ROUNDS = 8

// ── Tools ────────────────────────────────────────────────────────────────────

/**
 * The whole tool registry. Every tool declares its `kind` here, in the
 * definition — see boundary.ts and BOUNDARY.md. boundary.test.ts walks this.
 */
export const TOOL_REGISTRY: VeilTool[] = [
  {
    name: 'get_trending_activity',
    screen: 'Swap screen',
    kind: 'read',
    description:
      'Read the most active pairs among Lens watched markets, ranked only by Lens measured volume over the last 24 hours. ' +
      'Every issued asset includes its exact issuer and verified or unverified status. This is read-only market data, not investment advice.',
    input_schema: {
      type: 'object' as const,
      properties: {},
    },
  },
  {
    name: 'get_price',
    screen: 'Swap screen',
    kind: 'read',
    description:
      'Get the current price of one asset in terms of another on the Stellar DEX: ' +
      'how many units of asset_b one unit of asset_a sells for right now, and how many hops the best route takes.',
    input_schema: {
      type: 'object' as const,
      properties: {
        asset_a: { type: 'string', description: 'Asset to price: "XLM", "USDC", "USDY" or "CODE:ISSUER"' },
        asset_b: { type: 'string', description: 'Asset to price it in: "XLM", "USDC", "USDY" or "CODE:ISSUER"' },
      },
      required: ['asset_a', 'asset_b'],
    },
  },
  {
    name: 'get_offramp_rate',
    screen: 'Cash Out screen',
    kind: 'read',
    description:
      'Read whether cash-out is available and, if available, the live NGN-per-USDC rate. Read-only: this never creates an order or verifies a bank account.',
    input_schema: {
      type: 'object' as const,
      properties: {},
    },
  },
  {
    name: 'prepare_cash_out',
    screen: 'Cash Out screen',
    kind: 'prepare',
    approval: 'screen',
    description:
      'Prepare a cash-out hand-off with its NGN amount and the live rate from get_offramp_rate. The Cash Out screen collects and verifies the bank account and handles order creation and deposit. This tool cannot verify an account, create an order, or send a deposit.',
    input_schema: {
      type: 'object' as const,
      properties: {
        amount_ngn: { type: 'number', description: 'Amount of naira the user wants to receive.' },
      },
      required: ['amount_ngn'],
    },
  },
  {
    name: 'get_asset_info',
    screen: 'asset details screen',
    kind: 'read',
    description:
      'Look up an asset in Veil\'s verified registry (ASSET_REGISTRY): its verified issuer, metadata, and whether it can be frozen or clawed back. ' +
      'ALWAYS call this for asset information questions like "What is USDY?" or "What is USDT0?". Pass "CODE", "code" or "CODE:ISSUER". Never answer asset issuer details from LLM memory.',
    input_schema: {
      type: 'object' as const,
      properties: {
        code: { type: 'string', description: 'Asset code, e.g. "USDY" or "USDC"' },
        asset: { type: 'string', description: '"USDT0", "USDC" or "CODE:ISSUER"' },
      },
    },
  },
  {
    name: 'open_invest',
    screen: 'Earn screen',
    kind: 'prepare',
    approval: 'screen',
    description:
      'Hand off a buy request or investment to the wallet\'s Invest/Earn section. ' +
      'The agent must never construct or sign a transaction for buying invest assets.',
    input_schema: {
      type: 'object' as const,
      properties: {
        code: { type: 'string', description: 'Asset code to buy, e.g. "USDY"' },
        asset_code: { type: 'string', description: 'Issued asset code, e.g. "USDY"' },
        asset_issuer: { type: 'string', description: 'The asset issuer public key (G...)' },
        amount: { type: 'string', description: 'Amount to buy, e.g. "50" (omit if not specified by user)' },
        quoteCurrency: { type: 'string', description: 'Quote currency used to buy, e.g. "USDC"' },
      },
    },
  },
  {
    name: 'get_transfer_history',
    screen: 'Activity screen',
    kind: 'read',
    description:
      'Get recent transfer history for a wallet — includes both classic Stellar payments (XLM sends/receives) ' +
      'and Soroban token transfers. Returns classicPayments from Horizon and sorobanTransfers from Wraith.',
    input_schema: {
      type: 'object' as const,
      properties: {
        address: { type: 'string', description: 'Stellar wallet address (G...)' },
        direction: { type: 'string', enum: ['incoming', 'outgoing', 'both'] },
        limit: { type: 'number', description: 'Max results (default 10)' },
      },
      required: ['address', 'direction'],
    },
  },
  {
    name: 'get_wallet_balance',
    screen: 'Wallet screen',
    kind: 'read',
    description:
      'Get current XLM and token balances for a wallet address. Free. ' +
      'The result includes "holdings": every issued asset with its issuer and a status of verified, unverified or unlisted. ' +
      'Always name the issuer when reporting an issued asset, and report "unverified" holdings as unverified.',
    input_schema: {
      type: 'object' as const,
      properties: {
        address: { type: 'string', description: 'Stellar wallet address (G...)' },
      },
      required: ['address'],
    },
  },
  {
    name: 'open_swap',
    screen: 'Swap screen',
    kind: 'prepare',
    approval: 'screen',
    description:
      'Hand a swap to the wallet\'s Swap screen, filled in with the assets and amount. ' +
      'The Swap screen fetches its own live quote across Soroswap, Phoenix, Aqua and the Stellar DEX, ' +
      'shows the route and slippage, and the user confirms there with their passkey. ' +
      'Use this for every swap — do not build swap transactions yourself.',
    input_schema: {
      type: 'object' as const,
      properties: {
        from_asset: { type: 'string', description: 'Asset code to sell: XLM, USDC, EURC or AQUA' },
        to_asset: { type: 'string', description: 'Asset code to buy: XLM, USDC, EURC or AQUA' },
        amount: { type: 'string', description: 'Amount of from_asset to sell, e.g. "10" (omit if the user did not say)' },
      },
      required: ['from_asset', 'to_asset'],
    },
  },
  {
    name: 'build_payment',
    screen: 'Send screen',
    kind: 'prepare',
    approval: 'request_user_approval',
    description:
      'Build a Stellar payment transaction to send XLM or tokens. ' +
      'ALWAYS call request_user_approval after building.',
    input_schema: {
      type: 'object' as const,
      properties: {
        to_address: { type: 'string', description: 'Recipient Stellar address (G...)' },
        asset: { type: 'string', description: '"XLM" or "CODE:ISSUER"' },
        amount: { type: 'number' },
        wallet_address: { type: 'string' },
        memo: { type: 'string', description: 'Optional text memo' },
      },
      required: ['to_address', 'asset', 'amount', 'wallet_address'],
    },
  },
  {
    name: 'request_user_approval',
    screen: 'wallet approval screen',
    kind: 'prepare',
    approval: 'self',
    description:
      'ALWAYS call this before any transaction executes. ' +
      'Sends the transaction to the wallet UI for passkey (biometric) approval. ' +
      'The user must approve with Face ID / fingerprint before the tx is submitted.',
    input_schema: {
      type: 'object' as const,
      properties: {
        transaction_xdr: { type: 'string', description: 'Unsigned transaction XDR (base64)' },
        summary: {
          type: 'string',
          description: 'Plain English: what this transaction does, amounts, assets, recipient',
        },
        estimated_fee_xlm: { type: 'number', description: 'Estimated network fee in XLM' },
      },
      required: ['transaction_xdr', 'summary'],
    },
  },
]

// ── User profile & system prompt ─────────────────────────────────────────────

export interface UserProfile {
  name?: string
  language?: string
  persona?: string
  role?: string
}

const ROLE_CONTEXT: Record<string, string> = {
  trader: `The user is a TRADER. They actively swap and trade assets.
- Proactively suggest trade opportunities when they check prices.
- When they receive funds, ask if they'd like to swap or trade.
- Mention spread, slippage, and execution routes when relevant.
- Be quick and action-oriented — traders want speed.`,
  investor: `The user is an INVESTOR. They hold long-term and look for yield.
- When they receive funds, suggest yield opportunities or portfolio diversification.
- Emphasize value, market context, and long-term thinking.
- Mention price trends and whether timing seems favorable.
- Be analytical and informative.`,
  saver: `The user is a SAVER. They primarily save and send money.
- Focus on balance updates, transfers, and payment confirmations.
- When they receive funds, confirm the amount and updated balance.
- Keep things simple — avoid jargon about trading or DeFi unless asked.
- Be clear and reassuring.`,
  explorer: `The user is an EXPLORER — new to crypto/Stellar.
- Explain concepts briefly when relevant (what's a swap, what's XLM, etc.).
- Be encouraging and educational without being condescending.
- Suggest simple actions they can try to learn the ropes.
- When they receive funds, explain what they can do with them.`,
}

const SYSTEM_PROMPT = (walletAddress: string, feePayerAddress: string, profile?: UserProfile) => {
  const nameClause = profile?.name ? `The user's name is ${profile.name}. Address them by name occasionally.` : ''
  const langClause = profile?.language && profile.language !== 'English'
    ? `IMPORTANT: The user prefers ${profile.language}. Respond in ${profile.language} unless they write in a different language.`
    : ''
  const personaClause = profile?.persona
    ? `Personality note: The user wants you to be ${profile.persona}. Adjust your tone accordingly.`
    : ''
  const roleClause = profile?.role && ROLE_CONTEXT[profile.role]
    ? `\n${ROLE_CONTEXT[profile.role]}`
    : ''
  const capabilityList = TOOL_REGISTRY
    .map((tool) => `- ${tool.name}: ${tool.description} (Screen: ${tool.screen})`)
    .join('\n')

  return `\
You are a helpful AI agent embedded in the Veil passkey smart wallet on Stellar.

The user's wallet contract address is: ${walletAddress}
The user's fee-payer address (use this as wallet_address in ALL build_payment calls): ${feePayerAddress}
${nameClause}
${langClause}
${personaClause}
${roleClause}

REGISTERED CAPABILITIES (generated from the tools available to you):
${capabilityList}

RULES:
1. For any swap, call open_swap. Never build a swap transaction yourself; the Swap screen quotes it and the user confirms there.
2. Before a payment executes, ALWAYS call request_user_approval — never skip this.
3. Use get_price when the user asks about a price or wants to weigh a swap first. Use get_trending_activity for questions about what is active or trending on Stellar. Only report the measured Lens 24-hour pair volume and source returned by the tool; identify every issued asset by issuer and call unverified issuers unverified. If Lens is unavailable, say "I cannot see the market right now" and do not guess.
4. Prices come from Soroswap's aggregator when available, otherwise the Stellar DEX; say which when it matters. If price data is unavailable, state plainly that price data is currently unavailable — do NOT make up or estimate prices.
5. Format amounts clearly: "500 XLM", "47.3 USDC".
6. If you need a recipient address and the user hasn't provided one, ask before building.
7. Keep responses concise. Use bullet points for multi-step flows.
8. Always use the fee-payer address (not the contract address) as wallet_address when calling build_payment.
9. For asset explanation queries ("What is USDY?"), ALWAYS call get_asset_info. Base your answer strictly on the returned registry data (issuer name, issuer address, home domain, asset kind). NEVER invent or rely on LLM memory for asset issuer details. Asset codes are not identities: several issuers publish the same code (eight publish USDT0). When reporting holdings, name the issuer and report "unverified" holdings as unverified.
10. For holdings questions ("what do I hold", "how much USDY do I have"), call get_wallet_balance and report exact balances with verified registry labels.
11. For buy requests ("buy 50 USDC of USDY"), call open_invest. NEVER construct or sign a transaction for asset purchases. State that you are routing to the Invest section but that the destination screen is being built, not that it will be pre-filled and ready. Your response MUST include the issuer address and a one-line risk disclosure (e.g. "USDY is issued by Ondo Finance — review the asset details on the next screen before confirming"). Do NOT give an opinion on whether to buy.
12. REFUSE to give investment advice. If a user asks "should I buy USDY?" or "is USDY a good investment?" or similar advice questions, respond with a flat refusal pointing them to the Invest section for details, and NOTHING MORE.
13. CAPABILITY BOUNDARY: Only claim actions or data available through the registered capabilities above. If a request is outside them, plainly say what you cannot do from this chat and direct the user to the most relevant screen named above. Do not claim that screen supports an action unless its registered capability says so; if no screen applies, say so instead of inventing one.
14. DATA BOUNDARY: Never estimate or infer a requested number. get_wallet_balance and get_transfer_history provide Stellar data only; get_price provides current Stellar market data only. If the requested chain or figure has no available data source, say "I cannot see that data here" and do not give a guessed or approximate number. If a registered tool reports that data is unavailable, treat that as unavailable — do not fill the gap from memory.
15. For a cash-out, use get_offramp_rate first. If unavailable, say it is unavailable; do not blame the user or estimate a rate. If available, call prepare_cash_out with only the requested naira amount. Never select or verify a bank account, request or repeat an account number in chat, create a payout order, or send a deposit. Tell the user the Cash Out screen will collect and verify their bank account before order creation. An unverified account must be verified on that screen, not by you.`
}

/**
 * Soroban token transfers from Wraith, when it is configured and free to call.
 *
 * Wraith used to be called through an x402 client that paid per request from a
 * funded agent key. The agent no longer holds a key: a paywalled or failing
 * Wraith now just means no Soroban transfers in the answer, and Horizon still
 * supplies classic payments.
 */
async function fetchWraith(baseUrl: string, path: string): Promise<unknown[]> {
  if (!baseUrl) return []
  const res = await fetch(`${baseUrl.replace(/\/+$/, '')}${path}`, {
    signal: AbortSignal.timeout(15_000),
  })
  if (!res.ok) return []
  const body = await res.json()
  return Array.isArray(body) ? body : []
}

/**
 * Redact Nigerian bank account numbers if the model repeats user-provided text.
 *
 * Deliberately narrow, and applied only to the model's prose rather than to tool
 * results: a bare run of ten digits in a sentence is almost always an account
 * number, but in a tool result it is as likely to be an amount or an id.
 */
function redactBankAccountNumbers(text: string): string {
  return text.replace(/(?<!\d)(?:\d[ -]?){9}\d(?!\d)/g, '[account number hidden]')
}

// ── Core agent loop ──────────────────────────────────────────────────────────

export interface AgentResult {
  response: string
  pendingTxXdr?: string
  pendingTxSummary?: string
  /**
   * A swap for the app's Swap screen to open, pre-filled. The agent does not
   * build swaps: the Swap screen quotes across more venues than a single path
   * payment reaches and has its own review, so the agent hands off to it.
   */
  swapIntent?: SwapIntent
  /**
   * A buy request for the app's Invest screen to open. The agent never builds or signs buy transactions.
   */
  investIntent?: InvestIntent
  /** A read-rate cash-out hand-off; the Cash Out screen owns all payout steps. */
  cashOutIntent?: CashOutIntent
}

export interface SwapIntent {
  from: string
  to: string
  amount?: string
}

export interface InvestIntent {
  code?: string
  issuer?: string
  amount?: string
  quoteCurrency?: string
  asset?: { code: string; issuer: string }
}

export interface CashOutIntent {
  amountNGN: number
  rate: number
}

/** Assets the apps' Swap screens offer. */
const SWAP_CODES = new Set(['XLM', 'USDC', 'EURC', 'AQUA'])

/**
 * Run a single agent turn. Used internally by both the server and createVeilAgent.
 */
export async function runAgent(
  userMessage: string,
  walletAddress: string,
  conversationHistory: ChatTurn[],
  feePayerAddress: string | undefined,
  profile: UserProfile | undefined,
  /** The model provider (see llm.ts). Reuse one per process. */
  llm: LlmProvider,
  /** Service URLs — if not provided, falls back to process.env. */
  urls?: { wraithUrl?: string; horizonUrl?: string; lensUrl?: string },
): Promise<AgentResult> {
  let pendingTxXdr: string | undefined
  let pendingTxSummary: string | undefined
  let swapIntent: SwapIntent | undefined
  let investIntent: InvestIntent | undefined
  let unavailablePrice: { assetA: string; assetB: string } | undefined
  const unavailablePriceResponse = () =>
    unavailablePrice
      ? `Current Stellar price data for ${unavailablePrice.assetA}/${unavailablePrice.assetB} is unavailable. I cannot see it here, so I won't estimate it.`
      : undefined
  let cashOutIntent: CashOutIntent | undefined
  let cashOutRate: number | undefined
  let cashOutUnavailable = false
  let cashOutNeedsRate = false
  let cashOutPaymentBlocked = false
  // Set when a cash-out tool actually runs this turn, which is what gates the
  // payment tools below. Keying this off a regex over the user's message meant
  // that "what is my balance? I want to cash out later" disabled build_payment
  // and replaced the balance answer with a cash-out sentence.
  let cashOutToolUsed = false
  const cashOutResponse = () =>
    cashOutUnavailable
      ? 'Cash-out is unavailable right now. I have not created an order. Please try again later.'
      : cashOutIntent
        ? 'Your cash-out amount and live rate are ready. Select and verify your bank account on the Cash Out screen before creating an order.'
        : cashOutNeedsRate
          ? 'I need to check the live cash-out rate before preparing this. No order has been created.'
          : cashOutPaymentBlocked
            ? 'Cash-out orders and deposits must be handled on the Cash Out screen. I have not built or sent a payment.'
            : undefined

  // The Next API route does not pass `urls`, and the wallet app only ever sets
  // NEXT_PUBLIC_WRAITH_URL (see frontend/wallet/lib/offramp.ts). Without that
  // fallback every cash-out rate lookup reports unavailable in production.
  const wraithUrl = (
    urls?.wraithUrl || process.env.WRAITH_URL || process.env.NEXT_PUBLIC_WRAITH_URL || ''
  ).trim()
  const horizonUrl = urls?.horizonUrl ?? HORIZON_URL
  const lensUrl = urls?.lensUrl ?? process.env.LENS_URL?.trim() ?? 'https://lens-ldtu.onrender.com'

  // ── SLASH COMMAND INTERCEPTION ─────────────────────────────────────────────
  const trimmedMessage = userMessage.trim();
  if (trimmedMessage.startsWith('/history')) {
    const parts = trimmedMessage.split(' ');
    const parsedCount = parts.length > 1 ? parseInt(parts[1], 10) : 10;
    const count = isNaN(parsedCount) ? 10 : parsedCount;
    const targetAddress = feePayerAddress ?? walletAddress;

    try {
      const [wraithResult, horizonResult] = await Promise.allSettled([
        fetchWraith(wraithUrl, `/transfers/address/${targetAddress}?direction=both&limit=${count}`),
        fetch(`${horizonUrl}/accounts/${targetAddress}/payments?limit=${count}&order=desc`)
          .then((r) => r.json()),
      ]);

      const sorobanTransfers: any[] = wraithResult.status === 'fulfilled' ? (wraithResult.value as any[]) ?? [] : [];
      const classicPayments = horizonResult.status === 'fulfilled'
        ? (horizonResult.value as any)?._embedded?.records ?? []
        : [];

      if ((!sorobanTransfers || sorobanTransfers.length === 0) && (!classicPayments || classicPayments.length === 0)) {
        return { response: "You don't have any recent transactions." };
      }

      let responseText = `Here are your last ${count} transactions:\n\n`;
      
      if (sorobanTransfers && sorobanTransfers.length > 0) {
        responseText += `**Soroban Transfers:**\n`;
        sorobanTransfers.slice(0, count).forEach((tx: any) => {
          responseText += `- **${tx.type || 'Transfer'}**: ${tx.amount || '0'} ${tx.asset || ''} (Hash: \`${tx.hash || tx.transaction_hash}\`)\n`;
        });
        responseText += `\n`;
      }

      if (classicPayments && classicPayments.length > 0) {
        responseText += `**Classic Payments:**\n`;
        classicPayments.slice(0, count).forEach((tx: any) => {
          const amount = tx.amount || tx.starting_balance || "0";
          const asset = tx.asset_type === 'native' ? 'XLM' : (tx.asset_code || 'Unknown');
          responseText += `- **${tx.type}**: ${amount} ${asset} (Hash: \`${tx.transaction_hash}\`)\n`;
        });
      }

      return { response: redactBankAccountNumbers(responseText.trim()) };
    } catch (error) {
      console.error("History fetch failed:", error);
      return { response: "I couldn't fetch your transaction history at the moment. The Wraith indexer might be temporarily unavailable." };
    }
  }
  // ───────────────────────────────────────────────────────────────────────────

  async function executeTool(name: string, input: Record<string, unknown>): Promise<string> {
    switch (name) {
      case 'get_trending_activity': {
        try {
          return JSON.stringify(await getTrendingActivity(lensUrl))
        } catch {
          return JSON.stringify({ error: 'I cannot see the market right now because Lens market data is unavailable.' })
        }
      }

      case 'get_price': {
        try {
          return JSON.stringify(await getPrice(String(input.asset_a), String(input.asset_b)))
        } catch {
          unavailablePrice = { assetA: String(input.asset_a), assetB: String(input.asset_b) }
          return JSON.stringify({
            error: `Current Stellar price data for ${input.asset_a}/${input.asset_b} is unavailable. I cannot see it here. Do not estimate it.`,
          })
        }
      }

      case 'get_offramp_rate': {
        cashOutToolUsed = true
        if (NETWORK !== 'mainnet' || !wraithUrl) {
          cashOutUnavailable = true
          return JSON.stringify({ available: false, status: 'unavailable' })
        }
        try {
          const res = await fetch(`${wraithUrl.replace(/\/+$/, '')}/offramp/rate`, {
            signal: AbortSignal.timeout(15_000),
          })
          if (!res.ok) {
            cashOutUnavailable = true
            return JSON.stringify({ available: false, status: 'unavailable' })
          }
          const quote = (await res.json()) as { rate?: unknown; currency?: unknown; coin?: unknown }
          if (typeof quote.rate !== 'number' || !Number.isFinite(quote.rate) || quote.rate <= 0) {
            cashOutUnavailable = true
            return JSON.stringify({ available: false, status: 'unavailable' })
          }
          cashOutRate = quote.rate
          cashOutUnavailable = false
          return JSON.stringify({
            available: true,
            rate: quote.rate,
            currency: typeof quote.currency === 'string' ? quote.currency : 'NGN',
            coin: typeof quote.coin === 'string' ? quote.coin : 'USDC',
          })
        } catch (err) {
          console.warn('[agent] Cash-out rate lookup failed:', (err as Error).message)
          cashOutUnavailable = true
          return JSON.stringify({ available: false, status: 'unavailable' })
        }
      }

      case 'prepare_cash_out': {
        cashOutToolUsed = true
        const amountNGN = input.amount_ngn
        if (cashOutRate === undefined || cashOutUnavailable) {
          cashOutNeedsRate = !cashOutUnavailable
          return JSON.stringify({ error: 'Cash-out is unavailable or its live rate has not been checked.' })
        }
        if (
          typeof amountNGN !== 'number' ||
          !Number.isFinite(amountNGN) ||
          amountNGN <= 0 ||
          amountNGN > Number.MAX_SAFE_INTEGER
        ) {
          return JSON.stringify({ error: 'amount_ngn must be a positive finite amount.' })
        }
        cashOutIntent = { amountNGN, rate: cashOutRate }
        cashOutNeedsRate = false
        return JSON.stringify({
          status: 'cash_out_screen_ready',
          amountNGN,
          rate: cashOutRate,
          bankAccountVerification: 'required_on_screen',
        })
      }

      case 'get_asset_info': {
        const query = String(input.code ?? input.asset ?? '').trim()
        if (query.includes(':') || query.toUpperCase() === 'USDT0') {
          return JSON.stringify(describeAsset(query))
        }
        const asset = getRegisteredAsset(query)
        if (!asset) {
          return JSON.stringify(describeAsset(query))
        }
        return JSON.stringify(asset)
      }

      case 'open_invest': {
        if (input.asset_code || input.asset_issuer) {
          const code = String(input.asset_code ?? '').trim().toUpperCase()
          const issuer = String(input.asset_issuer ?? '').trim()
          const amount = String(input.amount ?? '').trim()
          if (!/^[A-Z0-9]{1,12}$/.test(code) || !StrKey.isValidEd25519PublicKey(issuer)) {
            return JSON.stringify({ error: 'asset_code and a valid asset_issuer are required.' })
          }
          if (amount && (!/^\d+(\.\d{1,7})?$/.test(amount) || Number(amount) <= 0)) {
            return JSON.stringify({ error: 'amount must be a plain positive number with at most seven decimals.' })
          }
          investIntent = { asset: { code, issuer }, amount }
          return JSON.stringify({ status: 'invest_screen_ready' })
        }

        const code = String(input.code ?? '').trim().toUpperCase()
        const asset = getRegisteredAsset(code)
        if (!asset) {
          return JSON.stringify({ error: `Asset "${code}" is not in the verified asset registry.` })
        }
        if (asset.network !== 'all' && asset.network !== NETWORK) {
          return JSON.stringify({ error: `Asset "${code}" is only supported on ${asset.network}.` })
        }
        const amount = input.amount === undefined ? undefined : String(input.amount).trim()
        if (amount !== undefined && !/^\d+(\.\d{1,7})?$/.test(amount)) {
          return JSON.stringify({ error: 'amount must be a plain number like "50" or "10.5"' })
        }
        const quoteCurrency = input.quoteCurrency ? String(input.quoteCurrency).trim().toUpperCase() : 'USDC'
        investIntent = { code, issuer: asset.issuer, ...(amount ? { amount } : {}), quoteCurrency }
        return JSON.stringify({
          status: 'invest_screen_ready',
          code,
          issuer: asset.issuer,
          issuerName: asset.issuerName,
          amount,
          quoteCurrency,
        })
      }

      case 'get_transfer_history': {
        const limit = (input.limit as number | undefined) ?? 10
        const horizonAddr = feePayerAddress ?? (input.address as string)

        const [wraithResult, horizonResult] = await Promise.allSettled([
          fetchWraith(
            wraithUrl,
            `/transfers/address/${input.address}?direction=${input.direction}&limit=${limit}`,
          ),
          fetch(`${horizonUrl}/accounts/${horizonAddr}/payments?limit=${limit}&order=desc`)
            .then(r => r.json()),
        ])

        const sorobanTransfers = wraithResult.status === 'fulfilled' ? wraithResult.value : []
        const classicPayments = horizonResult.status === 'fulfilled'
          ? (horizonResult.value as any)?._embedded?.records ?? []
          : []

        return JSON.stringify({ sorobanTransfers, classicPayments })
      }

      case 'get_wallet_balance': {
        const fpAddress = feePayerAddress ?? (input.address as string)
        const contractAddr = walletAddress?.startsWith('C') ? walletAddress : undefined
        const balances = await getBalances(fpAddress, contractAddr)
        // Keep the flat balances the model already sees, and add each issued
        // asset classified by issuer. A code match alone is never "verified".
        return JSON.stringify({ ...balances, holdings: classifyBalances(balances) })
      }

      case 'open_swap': {
        const from = String(input.from_asset ?? '').trim().toUpperCase()
        const to = String(input.to_asset ?? '').trim().toUpperCase()
        const amount = input.amount === undefined ? undefined : String(input.amount).trim()
        if (!SWAP_CODES.has(from) || !SWAP_CODES.has(to) || from === to) {
          return JSON.stringify({ error: 'Swaps support XLM, USDC, EURC and AQUA, between two different assets.' })
        }
        if (amount !== undefined && !/^\d+(\.\d{1,7})?$/.test(amount)) {
          return JSON.stringify({ error: 'amount must be a plain number like "10" or "2.5"' })
        }
        swapIntent = { from, to, ...(amount ? { amount } : {}) }
        return JSON.stringify({ status: 'swap_screen_ready' })
      }

      case 'build_payment': {
        if (cashOutToolUsed) {
          cashOutPaymentBlocked = true
          return JSON.stringify({ error: 'Cash-out deposits must be sent from the Cash Out screen.' })
        }
        const payInput = {
          ...(input as unknown as Parameters<typeof buildPayment>[0]),
          wallet_address: feePayerAddress ?? (input as any).wallet_address,
        }
        const xdr = await buildPayment(payInput)
        return JSON.stringify({ transaction_xdr: xdr, status: 'built' })
      }

      case 'request_user_approval': {
        if (cashOutToolUsed) {
          cashOutPaymentBlocked = true
          return JSON.stringify({ error: 'Cash-out deposits must be sent from the Cash Out screen.' })
        }
        pendingTxXdr = input.transaction_xdr as string
        pendingTxSummary = input.summary as string
        return JSON.stringify({ status: 'awaiting_approval' })
      }

      default:
        return JSON.stringify({ error: `Unknown tool: ${name}` })
    }
  }

  const session = llm.start(
    SYSTEM_PROMPT(walletAddress, feePayerAddress ?? walletAddress, profile),
    conversationHistory,
    userMessage,
    toModelTools(TOOL_REGISTRY),
  )

  // Agentic loop, bounded. Each round is a paid or rate-limited model call, so a
  // model that keeps calling tools — or a prompt written to make it — must not
  // be able to loop forever.
  let turn = await session.next()
  let rounds = 0
  while (turn.toolCalls.length > 0) {
    if (++rounds > MAX_TOOL_ROUNDS) {
      return {
        response:
          cashOutResponse() ??
          unavailablePriceResponse() ??
          "I couldn't finish that in one go. Try asking for one thing at a time.",
        pendingTxXdr,
        pendingTxSummary,
        swapIntent,
        investIntent,
        cashOutIntent,
      }
    }

    const results: { id: string; content: string }[] = []
    for (const call of turn.toolCalls) {
      let content: string
      try {
        content = await executeTool(call.name, call.input)
      } catch (err) {
        content = JSON.stringify({ error: (err as Error).message })
      }
      // Last gate before the model sees it: no secret or provider URL, even
      // inside an error message or a backend-supplied field.
      content = redactSensitive(content)
      results.push({ id: call.id, content })
    }
    session.addToolResults(results)
    try {
      turn = await session.next()
    } catch (err) {
      // A cash-out that was prepared, refused or blocked has a settled outcome to
      // report, and so does a price lookup that failed. Either beats re-throwing.
      const settled = cashOutResponse() ?? unavailablePriceResponse()
      if (settled) {
        return { response: settled, pendingTxXdr, pendingTxSummary, swapIntent, investIntent, cashOutIntent }
      }
      // The work is done — a swap or invest to open or a payment to approve — and only the
      // model's closing sentence failed. Hand the user the result rather than an
      // error that throws it away.
      if (swapIntent || investIntent || pendingTxXdr) {
        return {
          response: swapIntent
            ? 'Your swap is ready in the Swap screen.'
            : investIntent
            ? 'Routing to the Invest section (destination screen under construction).'
            : 'Your transaction is ready to review.',
          pendingTxXdr,
          pendingTxSummary,
          swapIntent,
          investIntent,
          cashOutIntent,
        }
      }
      throw err
    }
  }

  const response =
    cashOutResponse() ?? unavailablePriceResponse() ?? redactBankAccountNumbers(turn.text)
  return { response, pendingTxXdr, pendingTxSummary, swapIntent, investIntent, cashOutIntent }
}

// ── createVeilAgent — library-friendly wrapper ───────────────────────────────

export interface ChatOptions {
  walletAddress: string
  feePayerAddress?: string
  profile?: UserProfile
}

export interface VeilAgent {
  /** Send a message and get a response. Manages conversation history per wallet. */
  chat: (message: string, options: ChatOptions) => Promise<AgentResult>
  /** Clear conversation history for a wallet. */
  clearHistory: (walletAddress: string) => void
}

/**
 * Create a reusable Veil agent instance.
 *
 * @example
 * ```typescript
 * import { createVeilAgent } from '@veil/agent'
 *
 * const agent = createVeilAgent({
 *   anthropicApiKey: 'sk-ant-...',
 *   openRouterApiKey: 'sk-or-...', // or anthropicApiKey for Claude
 * })
 *
 * const result = await agent.chat('What is my balance?', {
 *   walletAddress: 'C...',
 *   feePayerAddress: 'G...',
 *   profile: { name: 'Alice', role: 'trader' },
 * })
 *
 * console.log(result.response)
 * if (result.pendingTxXdr) {
 *   // Present to user for passkey approval, then sign + submit
 * }
 * ```
 */
export function createVeilAgent(config: AgentConfig): VeilAgent {
  const resolved = resolveConfig(config)

  const conversations = new Map<string, ChatTurn[]>()

  return {

    async chat(message: string, options: ChatOptions): Promise<AgentResult> {
      const { walletAddress, feePayerAddress, profile } = options
      const history = conversations.get(walletAddress) ?? []

      const result = await runAgent(
        message,
        walletAddress,
        history,
        feePayerAddress,
        profile,
        resolved.llm,
        {
          wraithUrl: resolved.wraithUrl,
          horizonUrl: resolved.horizonUrl,
          lensUrl: resolved.lensUrl,
        },
      )

      // Update conversation history
      history.push({ role: 'user', content: message })
      history.push({ role: 'assistant', content: result.response })
      conversations.set(walletAddress, history.slice(-resolved.maxHistoryTurns))

      return result
    },

    clearHistory(walletAddress: string) {
      conversations.delete(walletAddress)
    },
  }
}
