/**
 * Plain English for failures that come back from the network in machine form.
 *
 * Three shapes reached users verbatim:
 *   - `Transaction rejected: AAAAAAAAlWb////9AAAAAA==` — a base64 TransactionResult
 *     from sendTransaction, which says precisely what went wrong to anyone who
 *     decodes it and nothing to anyone who does not;
 *   - `Simulation failed: HostError: Error(Contract, #13) … trustline entry is
 *     missing for account …` — a contract's own error code with a diagnostic log;
 *   - `Payment rejected: {"transaction":"tx_failed","operations":["op_underfunded"]}`
 *     — Horizon result codes serialised as JSON.
 *
 * `errorMessage` runs every message through `translateNetworkError`, so a screen
 * that shows `errorMessage(err)` gets the sentence without knowing where the
 * error was thrown. The raw detail still goes to the console for debugging.
 */

import { xdr } from '@stellar/stellar-sdk';

import { horizonErrorMessage, TRANSACTION_CODES } from './horizonError';

const FALLBACK = 'The network rejected this transaction. Nothing was sent.';

/** `txInsufficientBalance` → `tx_insufficient_balance`, the vocabulary Horizon uses. */
function snake(name: string): string {
  return name.replace(/([A-Z])/g, '_$1').toLowerCase();
}

/**
 * Operation results worth naming, by the suffix of their XDR arm. Payments,
 * path payments and trustline changes share these endings.
 */
const OPERATION_SUFFIXES: [RegExp, string][] = [
  [/Underfunded$/, "There isn't enough of that asset in the account to send."],
  [/LowReserve$/, "This would leave the account below Stellar's minimum XLM balance."],
  [/NoTrust$/, "The receiving account can't hold this asset yet."],
  [/NoDestination$/, "The receiving account doesn't exist on the network."],
  [/LineFull$/, 'The receiving account cannot hold any more of this asset.'],
  [/UnderDestMin$|OverSourceMax$/, 'The price moved past the slippage limit. Try again.'],
  [/TooFewOffers$/, 'There is not enough liquidity for this trade right now.'],
];

const HOST_FUNCTION_RESULTS: Record<string, string> = {
  invokeHostFunctionTrapped:
    'The contract refused this transaction. Nothing was sent. Check the amount and the receiving address.',
  invokeHostFunctionResourceLimitExceeded:
    'This transaction needed more network resources than allowed. Try again.',
  invokeHostFunctionInsufficientRefundableFee:
    'The network fee estimate was too low. Try again.',
  invokeHostFunctionEntryArchived:
    "Part of this wallet's on-chain data has expired and needs restoring. Try again in a moment.",
};

/** A sentence for a sendTransaction `errorResult`, or the generic fallback. */
export function rejectionFromResult(result: xdr.TransactionResult | undefined | null): string {
  if (!result) return FALLBACK;
  try {
    const outcome = result.result();
    const code = snake(outcome.switch().name);

    if (code === 'tx_failed') {
      for (const op of outcome.results()) {
        if (op.switch().name !== 'opInner') continue;
        const tr = op.tr();
        const armName = tr.switch().name; // e.g. 'invokeHostFunction', 'payment'
        const inner = (tr as unknown as Record<string, () => { switch(): { name: string } }>)[`${armName}Result`]?.();
        const innerName = inner?.switch().name;
        if (!innerName || /Success$/.test(innerName)) continue;
        if (HOST_FUNCTION_RESULTS[innerName]) return HOST_FUNCTION_RESULTS[innerName];
        for (const [pattern, sentence] of OPERATION_SUFFIXES) {
          if (pattern.test(innerName)) return sentence;
        }
      }
      return FALLBACK;
    }

    return TRANSACTION_CODES[code] ?? `The network rejected this transaction (${code}).`;
  } catch {
    return FALLBACK;
  }
}

/** Decode a base64 TransactionResult; null when the string is not one. */
export function rejectionFromBase64(base64: string): string | null {
  try {
    return rejectionFromResult(xdr.TransactionResult.fromXDR(base64, 'base64'));
  } catch {
    return null;
  }
}

/**
 * Stellar Asset Contract error codes (soroban-env-host `ContractError`), which
 * is what a token transfer reports as `Error(Contract, #n)`.
 */
const SAC_ERRORS: Record<string, string> = {
  '6': "The receiving account doesn't exist on the network.",
  '10': "There isn't enough of that asset in the wallet to send.",
  '11': 'This account is not allowed to hold or move this asset.',
  '13': "The receiving account can't hold this asset yet (it has no trustline for it).",
};

/**
 * A sentence for a simulation or host error, or null when it is not one we can
 * name with confidence. Unknown errors keep their original text, which is more
 * useful to a developer than a vague sentence is to anyone.
 */
export function friendlyHostError(detail: string): string | null {
  if (/trustline entry is missing/i.test(detail)) return SAC_ERRORS['13'];
  if (/resulting balance is not within the allowed range|balance is not sufficient/i.test(detail)) {
    return SAC_ERRORS['10'];
  }
  const contract = detail.match(/Error\(Contract, #(\d+)\)/);
  if (contract && /\btransfer\b/.test(detail) && SAC_ERRORS[contract[1]]) return SAC_ERRORS[contract[1]];
  if (/Error\(Auth,/.test(detail)) {
    return "The wallet's passkey signature wasn't accepted for this transaction. Try again.";
  }
  if (/Error\(Budget, ExceededLimit\)/.test(detail)) {
    return 'This transaction needed more network resources than allowed. Try again.';
  }
  return null;
}

/**
 * Translate a raw network message if it matches a known shape; otherwise return
 * it unchanged.
 */
export function translateNetworkError(message: string): string {
  const rejected = message.match(/Transaction rejected: ([A-Za-z0-9+/=]{8,})/);
  if (rejected) {
    const sentence = rejectionFromBase64(rejected[1]);
    if (sentence) {
      console.warn('[network] transaction rejected:', rejected[1]);
      return sentence;
    }
  }

  const payment = message.match(/Payment rejected: (\{.*\})/s);
  if (payment) {
    try {
      const sentence = horizonErrorMessage({ extras: { result_codes: JSON.parse(payment[1]) } });
      if (sentence) return sentence;
    } catch {
      // Not JSON after all; fall through.
    }
  }

  if (/Simulation failed|failed to simulate|HostError/i.test(message)) {
    const sentence = friendlyHostError(message);
    if (sentence) {
      console.warn('[network] simulation failed:', message);
      return sentence;
    }
  }

  return message;
}
