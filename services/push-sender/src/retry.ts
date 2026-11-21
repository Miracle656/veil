/**
 * Exponential backoff and retry helper for Expo Push API requests (#1275).
 */

export class NonRetryableExpoError extends Error {
  public readonly statusCode?: number;
  public readonly details?: unknown;

  constructor(message: string, statusCode?: number, details?: unknown) {
    super(message);
    this.name = 'NonRetryableExpoError';
    this.statusCode = statusCode;
    this.details = details;
  }
}

export class ExpoHttpError extends Error {
  public readonly statusCode: number;
  public readonly retryAfterMs?: number;
  public readonly details?: unknown;

  constructor(message: string, statusCode: number, retryAfterMs?: number, details?: unknown) {
    super(message);
    this.name = 'ExpoHttpError';
    this.statusCode = statusCode;
    this.retryAfterMs = retryAfterMs;
    this.details = details;
  }
}

export interface RetryOptions {
  maxAttempts?: number;
  baseDelayMs?: number;
  maxDelayMs?: number;
  factor?: number;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  onRetry?: (attempt: number, delayMs: number, error: unknown) => void;
}

/** Parse Retry-After header (seconds or HTTP date) to milliseconds. */
export function parseRetryAfterHeader(headerValue: string | null | undefined, nowMs: number = Date.now()): number | undefined {
  if (!headerValue) return undefined;
  const trimmed = headerValue.trim();
  const seconds = Number(trimmed);
  if (!Number.isNaN(seconds) && seconds >= 0) {
    return seconds * 1000;
  }
  const dateMs = Date.parse(trimmed);
  if (!Number.isNaN(dateMs) && dateMs > nowMs) {
    return dateMs - nowMs;
  }
  return undefined;
}

/** Check whether an error is transient and eligible for retry. */
export function isRetryableError(error: unknown): boolean {
  if (error instanceof NonRetryableExpoError) {
    return false;
  }

  if (error instanceof ExpoHttpError) {
    // 429 is rate limited -> retryable
    if (error.statusCode === 429) return true;
    // 5xx are server errors -> retryable
    if (error.statusCode >= 500 && error.statusCode <= 599) return true;
    // other 4xx (400, 401, 403, 404, etc.) are non-retryable
    if (error.statusCode >= 400 && error.statusCode < 500) return false;
  }

  const errMessage = error instanceof Error ? error.message : String(error);

  // Expo-specific rate limiting messages
  if (
    errMessage.includes('TOO_MANY_REQUESTS') ||
    errMessage.includes('MessageRateExceeded') ||
    errMessage.includes('rate limit')
  ) {
    return true;
  }

  // Network or socket transient errors
  if (
    errMessage.includes('ECONNRESET') ||
    errMessage.includes('ETIMEDOUT') ||
    errMessage.includes('EAI_AGAIN') ||
    errMessage.includes('fetch failed') ||
    errMessage.includes('network timeout')
  ) {
    return true;
  }

  // Default true for uncaught transient errors unless explicitly non-retryable
  return true;
}

/**
 * Execute an async operation with exponential backoff.
 * Strictly avoids retrying non-429 4xx errors.
 */
export async function retryWithBackoff<T>(
  operation: (attempt: number) => Promise<T>,
  options: RetryOptions = {},
): Promise<T> {
  const maxAttempts = options.maxAttempts ?? 4;
  const baseDelayMs = options.baseDelayMs ?? 250;
  const maxDelayMs = options.maxDelayMs ?? 5000;
  const factor = options.factor ?? 2;
  const sleep = options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));

  let attempt = 1;

  while (true) {
    try {
      return await operation(attempt);
    } catch (error) {
      if (attempt >= maxAttempts || !isRetryableError(error)) {
        if (
          error instanceof ExpoHttpError &&
          error.statusCode >= 400 &&
          error.statusCode < 500 &&
          error.statusCode !== 429
        ) {
          throw new NonRetryableExpoError(
            `Non-retryable HTTP ${error.statusCode} error: ${error.message}`,
            error.statusCode,
            error.details,
          );
        }
        throw error;
      }

      // Calculate exponential backoff delay
      let delayMs = Math.min(maxDelayMs, baseDelayMs * Math.pow(factor, attempt - 1));

      // Respect Retry-After header if provided
      if (error instanceof ExpoHttpError && typeof error.retryAfterMs === 'number' && error.retryAfterMs > 0) {
        delayMs = Math.min(maxDelayMs, Math.max(delayMs, error.retryAfterMs));
      }

      options.onRetry?.(attempt, delayMs, error);
      await sleep(delayMs);
      attempt++;
    }
  }
}
