import {
  anthropicProvider,
  deepseekProvider,
  openRouterProvider,
  type ChatTurn,
  type LlmProvider,
  type ToolSpec,
} from './llm.js'
import { HORIZON_URL, NETWORK, SOROBAN_RPC_URL } from './network.js'
import { getPrice } from './price.js'
import { buildPayment, getBalances } from './txBuilder.js'
import { StrKey } from '@stellar/stellar-sdk'

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
    horizonUrl: config.horizonUrl ?? HORIZON_URL,
    sorobanRpcUrl: config.sorobanRpcUrl ?? SOROBAN_RPC_URL,
    network: config.network ?? NETWORK,
    maxHistoryTurns: config.maxHistoryTurns ?? 20,
  }
}

/** Model rounds per user message before the agent gives up. */
const MAX_TOOL_ROUNDS = 8

// ── Tools ────────────────────────────────────────────────────────────────────

const tools: ToolSpec[] = [
  {
    name: 'get_price',
    description:
      'Get the current price of one asset in terms of another on the Stellar DEX: ' +
      'how many units of asset_b one unit of asset_a sells for right now, and how many hops the best route takes.',
    input_schema: {
      type: 'object' as const,
      properties: {
        asset_a: { type: 'string', description: 'Asset to price: "XLM", "USDC" or "CODE:ISSUER"' },
        asset_b: { type: 'string', description: 'Asset to price it in: "XLM", "USDC" or "CODE:ISSUER"' },
      },
      required: ['asset_a', 'asset_b'],
    },
  },
  {
    name: 'get_transfer_history',
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
    description: 'Get current XLM and token balances for a wallet address. Free.',
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
    name: 'open_invest',
    description:
      'Hand an issued-asset purchase to the wallet Earn screen, filled in with the asset and amount. ' +
      'The screen handles review and passkey confirmation; never build the purchase transaction yourself.',
    input_schema: {
      type: 'object' as const,
      properties: {
        asset_code: { type: 'string', description: 'Issued asset code, for example USDY' },
        asset_issuer: { type: 'string', description: 'The asset issuer public key (G...)' },
        amount: { type: 'string', description: 'Amount to buy, for example "50"' },
      },
      required: ['asset_code', 'asset_issuer', 'amount'],
    },
  },
  {
    name: 'build_payment',
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

  return `\
You are a helpful AI agent embedded in the Veil passkey smart wallet on Stellar.

The user's wallet contract address is: ${walletAddress}
The user's fee-payer address (use this as wallet_address in ALL build_payment calls): ${feePayerAddress}
${nameClause}
${langClause}
${personaClause}
${roleClause}

You help users:
- Check their balance and recent transfers
- Get live prices
- Set up swaps (opened in the Swap screen) and payments — the user always approves with their passkey
- Set up issued-asset investments (opened in the Earn screen) — the user always approves with their passkey

RULES:
1. For any swap, call open_swap. Never build a swap transaction yourself; the Swap screen quotes it and the user confirms there.
2. For an issued-asset purchase, call open_invest with the exact asset code, issuer, and amount. Never build the purchase yourself; the Earn screen validates and reviews it.
3. Before a payment executes, ALWAYS call request_user_approval — never skip this.
4. Use get_price when the user asks about a price or wants to weigh a swap first.
5. Prices come from Soroswap's aggregator when available, otherwise the Stellar DEX; say which when it matters.
6. Format amounts clearly: "500 XLM", "47.3 USDC".
7. If you need a recipient address and the user hasn't provided one, ask before building.
8. Keep responses concise. Use bullet points for multi-step flows.
9. Always use the fee-payer address (not the contract address) as wallet_address when calling build_payment.`
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
  investIntent?: InvestIntent
}

export interface SwapIntent {
  from: string
  to: string
  amount?: string
}

export interface InvestIntent {
  asset: { code: string; issuer: string }
  amount: string
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
  urls?: { wraithUrl?: string; horizonUrl?: string },
): Promise<AgentResult> {
  let pendingTxXdr: string | undefined
  let pendingTxSummary: string | undefined
  let swapIntent: SwapIntent | undefined
  let investIntent: InvestIntent | undefined

  const wraithUrl = urls?.wraithUrl ?? process.env.WRAITH_URL ?? ''
  const horizonUrl = urls?.horizonUrl ?? HORIZON_URL

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

      return { response: responseText.trim() };
    } catch (error) {
      console.error("History fetch failed:", error);
      return { response: "I couldn't fetch your transaction history at the moment. The Wraith indexer might be temporarily unavailable." };
    }
  }
  // ───────────────────────────────────────────────────────────────────────────

  async function executeTool(name: string, input: Record<string, unknown>): Promise<string> {
    switch (name) {
      case 'get_price': {
        return JSON.stringify(await getPrice(String(input.asset_a), String(input.asset_b)))
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
        return JSON.stringify(balances)
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

      case 'open_invest': {
        const code = String(input.asset_code ?? '').trim().toUpperCase()
        const issuer = String(input.asset_issuer ?? '').trim()
        const amount = String(input.amount ?? '').trim()
        if (!/^[A-Z0-9]{1,12}$/.test(code) || !StrKey.isValidEd25519PublicKey(issuer)) {
          return JSON.stringify({ error: 'asset_code and a valid asset_issuer are required.' })
        }
        if (!/^\d+(\.\d{1,7})?$/.test(amount) || Number(amount) <= 0) {
          return JSON.stringify({ error: 'amount must be a plain positive number with at most seven decimals.' })
        }
        investIntent = { asset: { code, issuer }, amount }
        return JSON.stringify({ status: 'invest_screen_ready' })
      }

      case 'build_payment': {
        const payInput = {
          ...(input as unknown as Parameters<typeof buildPayment>[0]),
          wallet_address: feePayerAddress ?? (input as any).wallet_address,
        }
        const xdr = await buildPayment(payInput)
        return JSON.stringify({ transaction_xdr: xdr, status: 'built' })
      }

      case 'request_user_approval': {
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
    tools,
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
          "I couldn't finish that in one go. Try asking for one thing at a time.",
        pendingTxXdr,
        pendingTxSummary,
        swapIntent,
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
      results.push({ id: call.id, content })
    }
    session.addToolResults(results)
    try {
      turn = await session.next()
    } catch (err) {
      // The work is done — a swap to open or a payment to approve — and only the
      // model's closing sentence failed. Hand the user the result rather than an
      // error that throws it away.
      if (swapIntent || investIntent || pendingTxXdr) {
        return {
          response: swapIntent
            ? 'Your swap is ready in the Swap screen.'
            : investIntent
              ? 'Your investment is ready in the Earn screen.'
              : 'Your transaction is ready to review.',
          pendingTxXdr,
          pendingTxSummary,
          swapIntent,
          investIntent,
        }
      }
      throw err
    }
  }

  return { response: turn.text, pendingTxXdr, pendingTxSummary, swapIntent, investIntent }
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