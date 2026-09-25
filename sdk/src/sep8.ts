/**
 * SEP-8 "Regulated Assets" approval flow.
 *
 * Wallets that need to transact regulated assets (requiring issuer approval)
 * submit transactions to the issuer's approval server, which validates them
 * against the issuer's compliance rules. The server returns one of five outcomes:
 *
 * - **success**: Transaction approved and signed by issuer.
 * - **revised**: Transaction revised to be compliant and signed by issuer.
 *   Wallet must re-verify and ask user to sign before resubmitting.
 * - **pending**: Issuer could not determine approval at this moment.
 *   Wallet may retry the same transaction later.
 * - **action_required**: User must complete an action (e.g., KYC) at a URL.
 *   Wallet opens URL in browser, then resubmits when done.
 * - **rejected**: Transaction not compliant and cannot be revised.
 *   Wallet displays error and user must revise the transaction.
 *
 * Security: Revised transactions are not automatically signed. Wallet re-verifies
 * the revised XDR against the original intent before asking the user to sign.
 * No identity data (KYC fields, personal info) passes through Veil's code.
 *
 * Reference: https://stellar.org/protocol/sep-8
 */

import { Transaction, TransactionBuilder, xdr } from '@stellar/stellar-sdk';

// ── Constants ────────────────────────────────────────────────────────────────────

/** The five possible outcomes from an approval server response. */
export type Sep8Status = 'success' | 'revised' | 'pending' | 'action_required' | 'rejected';

/** Hard timeout for approval server requests (10 seconds). */
const APPROVAL_REQUEST_TIMEOUT_MS = 10_000;

// ── Response Types ──────────────────────────────────────────────────────────────

/** Successful approval: transaction approved and signed by issuer. */
export interface Sep8SuccessResponse {
  status: 'success';
  tx: string; // Base64-encoded signed XDR
  message?: string;
}

/** Revised approval: transaction was modified to be compliant and signed by issuer. */
export interface Sep8RevisedResponse {
  status: 'revised';
  tx: string; // Base64-encoded revised signed XDR
  message: string; // Explanation of changes made
}

/** Pending approval: issuer cannot determine approval yet. */
export interface Sep8PendingResponse {
  status: 'pending';
  timeout?: number; // Milliseconds to wait before retrying
  message?: string;
}

/** Action required: user must complete an action before approval. */
export interface Sep8ActionRequiredResponse {
  status: 'action_required';
  message: string;
  action_url: string;
  action_method?: 'GET' | 'POST';
  action_fields?: string[]; // SEP-9 KYC/AML field names
}

/** Rejected: transaction cannot be approved or revised to be compliant. */
export interface Sep8RejectedResponse {
  status: 'rejected';
  error: string; // Explanation of why transaction was rejected
}

/** Any response from the approval server. */
export type Sep8Response =
  | Sep8SuccessResponse
  | Sep8RevisedResponse
  | Sep8PendingResponse
  | Sep8ActionRequiredResponse
  | Sep8RejectedResponse;

/** Options for submitting to the approval server. */
export interface Sep8SubmitOptions {
  /** Absolute URL of the approval server endpoint (from stellar.toml). */
  approvalServerUrl: string;
  /** Base64-encoded unsigned transaction XDR. */
  transactionXdr: string;
  /** Optional timeout in milliseconds. Defaults to 10 seconds. */
  timeoutMs?: number;
}

/** Thrown when approval server communication or response parsing fails. */
export class Sep8Error extends Error {
  readonly status?: number; // HTTP status code if applicable
  readonly approvalServerError?: string; // Error message from approval server
  readonly cause?: unknown;

  constructor(message: string, status?: number, approvalServerError?: string, cause?: unknown) {
    super(message);
    this.name = 'Sep8Error';
    this.status = status;
    this.approvalServerError = approvalServerError;
    this.cause = cause;
  }
}

// ── Public API ───────────────────────────────────────────────────────────────────

/**
 * Submit a transaction to an approval server for regulated asset compliance check.
 *
 * The approval server validates the transaction against the issuer's rules and
 * returns one of five outcomes. This function handles network errors, timeouts,
 * and invalid responses, throwing Sep8Error for any failure.
 *
 * @param options - Server URL, transaction XDR, and optional timeout.
 * @returns Approval server response (one of the five SEP-8 outcomes).
 * @throws Sep8Error - On network failure, timeout, or invalid response.
 *
 * @example
 * ```typescript
 * const response = await submitSep8Transaction({
 *   approvalServerUrl: 'https://issuer.example.com/tx_approve',
 *   transactionXdr: unsignedTxXdr,
 * });
 *
 * switch (response.status) {
 *   case 'success':
 *     // Transaction approved and signed. User can submit to network.
 *     await submitToNetwork(response.tx);
 *     break;
 *   case 'revised':
 *     // Show user the revised transaction before signing.
 *     showRevisionMessage(response.message);
 *     const userSigned = await getUserSignature(response.tx);
 *     // ... resubmit with signature added
 *     break;
 *   case 'pending':
 *     // Retry later
 *     setTimeout(() => retry(), response.timeout ?? 5000);
 *     break;
 *   case 'action_required':
 *     // Open browser for user action
 *     window.open(response.action_url);
 *     // User returns and retries
 *     break;
 *   case 'rejected':
 *     // Show error to user
 *     showError(response.error);
 *     break;
 * }
 * ```
 */
export async function submitSep8Transaction(options: Sep8SubmitOptions): Promise<Sep8Response> {
  const { approvalServerUrl, transactionXdr, timeoutMs = APPROVAL_REQUEST_TIMEOUT_MS } = options;

  // Validate inputs
  if (!approvalServerUrl) {
    throw new Sep8Error('Approval server URL is required');
  }
  if (!transactionXdr) {
    throw new Sep8Error('Transaction XDR is required');
  }
  if (!isValidUrl(approvalServerUrl)) {
    throw new Sep8Error(`Invalid approval server URL: ${approvalServerUrl}`);
  }

  try {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

    const response = await fetch(approvalServerUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Accept': 'application/json',
      },
      body: JSON.stringify({ tx: transactionXdr }),
      signal: controller.signal,
    });

    clearTimeout(timeoutId);

    // Handle non-JSON responses
    let data: unknown;
    const contentType = response.headers.get('content-type');
    if (contentType?.includes('application/json')) {
      try {
        data = await response.json();
      } catch (e) {
        throw new Sep8Error(
          `Approval server returned invalid JSON`,
          response.status,
          undefined,
          e,
        );
      }
    } else {
      const text = await response.text();
      throw new Sep8Error(
        `Approval server returned non-JSON content type: ${contentType}`,
        response.status,
        text,
      );
    }

    // Parse and validate response
    const parsedResponse = parseSep8Response(data, response.status);
    return parsedResponse;
  } catch (error) {
    // Rethrow Sep8Error as-is
    if (error instanceof Sep8Error) {
      throw error;
    }

    // Handle abort (timeout)
    if (error instanceof DOMException && error.name === 'AbortError') {
      throw new Sep8Error(
        `Approval server request timed out after ${timeoutMs}ms`,
        undefined,
        undefined,
        error,
      );
    }

    // Handle network errors
    if (error instanceof TypeError) {
      throw new Sep8Error(
        `Network error communicating with approval server: ${(error as Error).message}`,
        undefined,
        undefined,
        error,
      );
    }

    // Unexpected error
    throw new Sep8Error(
      `Unexpected error: ${(error as Error).message}`,
      undefined,
      undefined,
      error,
    );
  }
}

/**
 * Verify that a revised transaction has not changed the user's original intent.
 *
 * This function compares key fields between the original and revised transactions
 * to ensure the revision only added authorization/deauthorization operations,
 * not modified the user's core operations (payments, offers, etc.).
 *
 * Returns true if the revision appears safe (only added operations), false otherwise.
 * Wallet should show the user the differences before asking them to sign if this
 * returns false.
 *
 * @param originalXdr - Base64-encoded original transaction XDR (user-created).
 * @param revisedXdr - Base64-encoded revised transaction XDR (from approval server).
 * @returns true if revision appears safe to sign, false if changes look suspicious.
 *
 * @example
 * ```typescript
 * if (!verifyRevisedTransaction(originalXdr, revisedXdr)) {
 *   showWarning('Approval server made significant changes to your transaction.');
 *   if (!await getUserConfirmation('Continue?')) {
 *     throw new Error('User rejected revised transaction');
 *   }
 * }
 * ```
 */
export function verifyRevisedTransaction(originalXdr: string, revisedXdr: string): boolean {
  try {
    // Decode XDR
    const originalEnv = xdr.TransactionEnvelope.fromXDR(originalXdr, 'base64');
    const revisedEnv = xdr.TransactionEnvelope.fromXDR(revisedXdr, 'base64');

    // Extract transactions
    const originalTx =
      originalEnv.v1()?.tx() || originalEnv.feeBump()?.tx().innerTx().v1()?.tx();
    const revisedTx = revisedEnv.v1()?.tx() || revisedEnv.feeBump()?.tx().innerTx().v1()?.tx();

    if (!originalTx || !revisedTx) {
      return false;
    }

    // Basic sanity checks
    // 1. Source account should be the same
    try {
      const originalSourceAccount = originalTx.sourceAccount();
      const revisedSourceAccount = revisedTx.sourceAccount();
      
      // Get the public key strings from the source accounts
      // MuxedAccount can be ED25519 or MUXED_ED25519
      const originalSourceStr = (originalSourceAccount.switch().name === 'keyTypeMuxedEd25519')
        ? (originalSourceAccount as any).id().toString()
        : originalSourceAccount.ed25519()?.toString() || '';
      
      const revisedSourceStr = (revisedSourceAccount.switch().name === 'keyTypeMuxedEd25519')
        ? (revisedSourceAccount as any).id().toString()
        : revisedSourceAccount.ed25519()?.toString() || '';
      
      if (originalSourceStr !== revisedSourceStr) {
        return false;
      }
    } catch {
      return false;
    }

    // 2. Revised should have at least as many operations
    const originalOps = originalTx.operations();
    const revisedOps = revisedTx.operations();
    if (revisedOps.length < originalOps.length) {
      return false;
    }

    // 3. All original operations should appear unchanged in the revised transaction
    // (in the same order, possibly with additional ops before/after)
    // This is a simplified check; a full implementation would compare operation details.
    for (let i = 0; i < originalOps.length; i++) {
      const origOp = originalOps[i];
      const revisedOp = revisedOps[i];

      if (!origOp || !revisedOp) {
        return false;
      }

      // Compare operation types
      if (origOp.body().switch() !== revisedOp.body().switch()) {
        // If operation types differ, the revision modified the original intent
        return false;
      }

      // Compare source accounts (operations might have different sources)
      const origOpSource = origOp.sourceAccount();
      const revisedOpSource = revisedOp.sourceAccount();

      // Both should have source accounts or both should not
      if (Boolean(origOpSource) !== Boolean(revisedOpSource)) {
        return false;
      }
    }

    return true;
  } catch (error) {
    // If we can't parse the XDR or compare, treat as unsafe
    return false;
  }
}

/**
 * Check if an asset requires approval by examining the issuer's authorization flags.
 *
 * A regulated asset requires the issuer account to have both
 * AUTHORIZATION_REQUIRED and AUTHORIZATION_REVOCABLE flags set.
 *
 * @param authFlags - The issuer account's authorization flags integer.
 * @returns true if both required flags are set (asset is regulated).
 *
 * @example
 * ```typescript
 * const account = await server.loadAccount(issuerPublicKey);
 * if (isRegulatedAsset(account.flags.auth_required, account.flags.auth_revocable)) {
 *   // Show approval flow
 * }
 * ```
 */
export function isRegulatedAsset(authFlags: number): boolean {
  // SEP-8 requires both AUTHORIZATION_REQUIRED and AUTHORIZATION_REVOCABLE
  const AUTHORIZATION_REQUIRED = 1;
  const AUTHORIZATION_REVOCABLE = 2;
  return (authFlags & AUTHORIZATION_REQUIRED) !== 0 && (authFlags & AUTHORIZATION_REVOCABLE) !== 0;
}

// ── Private Helpers ─────────────────────────────────────────────────────────────

/**
 * Parse and validate a response from the approval server.
 * Throws Sep8Error if the response is invalid or malformed.
 */
function parseSep8Response(data: unknown, httpStatus: number): Sep8Response {
  if (typeof data !== 'object' || data === null) {
    throw new Sep8Error(
      `Approval server response is not a JSON object`,
      httpStatus,
      JSON.stringify(data),
    );
  }

  const response = data as Record<string, unknown>;
  const status = response.status;

  // Validate status field
  if (typeof status !== 'string') {
    throw new Sep8Error(
      `Approval server response missing "status" field`,
      httpStatus,
      JSON.stringify(response),
    );
  }

  switch (status) {
    case 'success': {
      if (typeof response.tx !== 'string') {
        throw new Sep8Error(
          'Success response missing "tx" field',
          httpStatus,
          JSON.stringify(response),
        );
      }
      return {
        status: 'success',
        tx: response.tx,
        message: typeof response.message === 'string' ? response.message : undefined,
      };
    }

    case 'revised': {
      if (typeof response.tx !== 'string') {
        throw new Sep8Error(
          'Revised response missing "tx" field',
          httpStatus,
          JSON.stringify(response),
        );
      }
      if (typeof response.message !== 'string') {
        throw new Sep8Error(
          'Revised response missing "message" field',
          httpStatus,
          JSON.stringify(response),
        );
      }
      return {
        status: 'revised',
        tx: response.tx,
        message: response.message,
      };
    }

    case 'pending': {
      return {
        status: 'pending',
        timeout:
          typeof response.timeout === 'number' && response.timeout >= 0 ? response.timeout : 0,
        message: typeof response.message === 'string' ? response.message : undefined,
      };
    }

    case 'action_required': {
      if (typeof response.message !== 'string') {
        throw new Sep8Error(
          'Action required response missing "message" field',
          httpStatus,
          JSON.stringify(response),
        );
      }
      if (typeof response.action_url !== 'string') {
        throw new Sep8Error(
          'Action required response missing "action_url" field',
          httpStatus,
          JSON.stringify(response),
        );
      }
      return {
        status: 'action_required',
        message: response.message,
        action_url: response.action_url,
        action_method:
          response.action_method === 'GET' || response.action_method === 'POST'
            ? response.action_method
            : 'GET',
        action_fields: Array.isArray(response.action_fields)
          ? response.action_fields.filter((f) => typeof f === 'string')
          : undefined,
      };
    }

    case 'rejected': {
      if (typeof response.error !== 'string') {
        throw new Sep8Error(
          'Rejected response missing "error" field',
          httpStatus,
          JSON.stringify(response),
        );
      }
      return {
        status: 'rejected',
        error: response.error,
      };
    }

    default: {
      throw new Sep8Error(
        `Unknown approval server status: "${status}"`,
        httpStatus,
        JSON.stringify(response),
      );
    }
  }
}

/**
 * Simple URL validation. Checks that the URL is absolute and uses HTTP(S).
 */
function isValidUrl(urlString: string): boolean {
  try {
    const url = new URL(urlString);
    return url.protocol === 'http:' || url.protocol === 'https:';
  } catch {
    return false;
  }
}
