import { Asset, Operation, TransactionBuilder, type Transaction } from '@stellar/stellar-sdk';

/**
 * The agent conversation's data model: what the assistant can say, and what a
 * transaction it proposes actually does.
 *
 * The agent service is an LLM. Its prose is untrusted input, and so is the
 * transaction XDR that arrives with it — so nothing here formats agent text as
 * markup that could be interpreted, and the proposal card is built from the
 * decoded transaction rather than from the summary the agent wrote for it.
 *
 * Ported from the message handling in `frontend/wallet/app/agent/page.tsx`.
 */

// ── Message model ─────────────────────────────────────────────────────────────

/** Where a proposed transaction has got to. */
export type ProposalStatus =
  | { state: 'awaiting' }
  | { state: 'confirming' }
  | { state: 'submitted'; hash: string }
  | { state: 'declined' }
  | { state: 'failed'; reason: string };

/** A swap the agent handed to the Swap screen. Codes as the Swap screen lists them. */
export type SwapIntent = { from: string; to: string; amount?: string };
export type InvestIntent = { asset: { code: string; issuer: string }; amount: string };

/** What a transaction the agent proposed will actually do, decoded locally. */
export type ProposalReview = {
  /** Account that pays for and authorises the transaction. */
  source: string;
  /** Total fee in stroops, as the transaction states it. */
  fee: string;
  memo: string | null;
  operations: string[];
  /** True when the transaction contains an operation this app cannot describe. */
  hasUnknownOperation: boolean;
};

export type AgentMessage =
  /** Something the user said. */
  | { id: string; kind: 'user'; text: string }
  /** Prose from the agent. */
  | { id: string; kind: 'agent'; text: string }
  /** Prose from the agent plus a swap for the Swap screen to quote and confirm. */
  | { id: string; kind: 'swap'; text: string; intent: SwapIntent }
  /** An issued-asset purchase the agent handed to Earn. */
  | { id: string; kind: 'invest'; text: string; intent: InvestIntent }
  /** A failure, from the service or from this app. */
  | { id: string; kind: 'error'; text: string }
  /** App-generated context, never attributed to the agent. */
  | { id: string; kind: 'notice'; text: string }
  /** A wallet action the agent is asking for. */
  | {
      id: string;
      kind: 'proposal';
      text: string;
      /** The agent's own description of the transaction — a claim, not evidence. */
      claim: string | null;
      xdr: string;
      review: ProposalReview | null;
      /** Why the transaction could not be decoded, when it could not be. */
      reviewError: string | null;
      status: ProposalStatus;
    };

let messageCounter = 0;

/** Monotonic ids, so React keys stay stable as the list grows. */
export function nextMessageId(prefix = 'm'): string {
  messageCounter += 1;
  return `${prefix}-${messageCounter}`;
}

// ── Inline markup ─────────────────────────────────────────────────────────────

export type InlineSegment = { text: string; style: 'plain' | 'strong' | 'code' };

const INLINE_PATTERN = /\*\*([\s\S]+?)\*\*|`([^`]+?)`/g;

/**
 * Split agent prose into styled segments for `**bold**` and `` `code` ``.
 *
 * The web wallet renders the same two forms by substituting HTML into
 * `dangerouslySetInnerHTML`. Segments are used here instead: the agent's output
 * is model-generated text, and turning it into markup that a renderer will
 * interpret is a habit worth not carrying over to a new surface.
 */
export function parseInlineMarkup(text: string): InlineSegment[] {
  const segments: InlineSegment[] = [];
  let cursor = 0;

  for (const match of text.matchAll(INLINE_PATTERN)) {
    const start = match.index ?? 0;
    if (start > cursor) {
      segments.push({ text: text.slice(cursor, start), style: 'plain' });
    }
    if (match[1] !== undefined) segments.push({ text: match[1], style: 'strong' });
    else if (match[2] !== undefined) segments.push({ text: match[2], style: 'code' });
    cursor = start + match[0].length;
  }

  if (cursor < text.length) segments.push({ text: text.slice(cursor), style: 'plain' });
  return segments;
}

// ── Transaction review ────────────────────────────────────────────────────────

/** `GABC…WXYZ` — enough of an address to check by eye. */
export function shortenAddress(address: string): string {
  return address.length <= 14 ? address : `${address.slice(0, 6)}…${address.slice(-6)}`;
}

function describeAsset(asset: Asset): string {
  return asset.isNative() ? 'XLM' : asset.getCode();
}

/** One line per operation, in the terms the user cares about. */
function describeOperation(operation: Operation): { text: string; known: boolean } {
  switch (operation.type) {
    case 'payment':
      return {
        text: `Send ${operation.amount} ${describeAsset(operation.asset)} to ${shortenAddress(operation.destination)}`,
        known: true,
      };
    case 'pathPaymentStrictSend':
      return {
        text: `Swap ${operation.sendAmount} ${describeAsset(operation.sendAsset)} for at least ${operation.destMin} ${describeAsset(operation.destAsset)} to ${shortenAddress(operation.destination)}`,
        known: true,
      };
    case 'pathPaymentStrictReceive':
      return {
        text: `Swap up to ${operation.sendMax} ${describeAsset(operation.sendAsset)} for ${operation.destAmount} ${describeAsset(operation.destAsset)} to ${shortenAddress(operation.destination)}`,
        known: true,
      };
    case 'changeTrust':
      return { text: `Add a trustline for ${operation.line.toString()}`, known: true };
    case 'createAccount':
      return {
        text: `Create account ${shortenAddress(operation.destination)} with ${operation.startingBalance} XLM`,
        known: true,
      };
    case 'invokeHostFunction':
      return { text: 'Call a smart contract', known: false };
    default:
      return { text: `Unrecognised operation: ${operation.type}`, known: false };
  }
}

/**
 * Decode what a proposed transaction does.
 *
 * This is the record the user approves against. The agent's summary is shown
 * beside it as a claim, but it is this decoding — and the source account check
 * the caller makes against it — that decides whether the numbers on screen are
 * the numbers being signed.
 *
 * @throws when the XDR cannot be parsed for the active network.
 */
export function reviewProposedTransaction(
  xdr: string,
  networkPassphrase: string
): ProposalReview {
  const parsed = TransactionBuilder.fromXDR(xdr, networkPassphrase);

  // A fee bump wraps the transaction that does the work; review the inner one,
  // whose operations and source are what actually execute.
  const tx: Transaction =
    'innerTransaction' in parsed ? (parsed.innerTransaction as Transaction) : parsed;

  const described = tx.operations.map(describeOperation);

  return {
    source: tx.source,
    fee: tx.fee,
    memo: tx.memo?.value ? String(tx.memo.value) : null,
    operations: described.map((operation) => operation.text),
    hasUnknownOperation: described.some((operation) => !operation.known),
  };
}

/**
 * Whether the transaction is one this device can legitimately sign: the source
 * account must be the wallet's own fee payer. Anything else is a transaction the
 * agent built for someone else's account, and signing it is never what the user
 * meant.
 */
export function isProposalForFeePayer(
  review: ProposalReview,
  feePayerAddress: string | null
): boolean {
  return !!feePayerAddress && review.source === feePayerAddress;
}

/**
 * Why a proposed transaction must not be signed, or null when it may be offered
 * for approval. Shared by the mobile Agent tab and the web agent page, so the two
 * cannot drift apart on what gets signed.
 *
 * Two rules, both fail-closed:
 * - the source must be this wallet's own fee payer (see isProposalForFeePayer);
 * - every operation must be one this app can describe. An operation it cannot
 *   name — `setOptions`, `accountMerge`, anything new — is exactly the kind a
 *   manipulated agent would slip in, and a user cannot meaningfully approve what
 *   the screen cannot show them.
 */
export function proposalRefusal(
  review: ProposalReview | null,
  feePayerAddress: string | null
): string | null {
  if (!review) return 'This transaction could not be decoded, so it cannot be approved here.';
  if (!isProposalForFeePayer(review, feePayerAddress)) {
    return `This transaction is sourced from ${shortenAddress(review.source)}, which is not this wallet's fee payer. Nothing was signed.`;
  }
  if (review.hasUnknownOperation) {
    return 'This transaction contains an operation this app cannot show you, so it will not be signed. Nothing was signed.';
  }
  return null;
}

/** Horizon buries the useful part of a failure in `extras.result_codes`. */
export function describeSubmissionError(error: unknown): string {
  const codes = (error as { response?: { data?: { extras?: { result_codes?: unknown } } } })
    ?.response?.data?.extras?.result_codes as
    | { transaction?: string; operations?: string[] }
    | undefined;

  if (codes?.transaction) {
    const operations = codes.operations?.join(', ');
    return operations ? `${codes.transaction} — ${operations}` : codes.transaction;
  }

  if (error instanceof Error) return error.message;
  return String(error);
}
