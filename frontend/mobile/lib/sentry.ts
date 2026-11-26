/**
 * Crash reporting — the mobile counterpart of `frontend/wallet/lib/sentry.ts`
 * (#442).
 *
 * Three gates, in order, and nothing leaves the phone until all three pass:
 *
 *   1. The build was given a Sentry DSN (`EXPO_PUBLIC_SENTRY_DSN`). Without
 *      one — every local build and every store build until an operator
 *      configures one — this module is inert.
 *   2. The user opted in (Settings → Privacy → Crash reports), the same
 *      per-user opt-in the web wallet uses under `veil_sentry_opt_in`.
 *   3. Events are scrubbed before they are sent: full Stellar addresses,
 *      secret keys and amounts are the wallet's own data and do not belong in
 *      a crash report, which is why `beforeSend` rewrites them out of every
 *      message and exception value (see `scrubString`).
 *
 * Reporting is transport, not policy: turning it off (or the flag being
 * absent) means `captureMobileError` is a no-op, and nothing in the app may
 * depend on it having run.
 */

import * as Sentry from '@sentry/react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';

/** Storage key shared with the web wallet, so the choice means the same thing. */
const OPT_IN_STORAGE_KEY = 'veil_sentry_opt_in';

// Stellar public key: G + 55 base32 chars; secret key: S + 55 base32 chars.
// Written in full here on purpose — an elided pattern would miss the tail of a
// key strung through a log line.
const STELLAR_ADDRESS_RE = /\bG[A-Z2-7]{55}\b/g;
const STELLAR_SECRET_RE = /\bS[A-Z2-7]{55}\b/g;
// Amounts followed by a known asset code.
const AMOUNT_RE = /\b\d+(\.\d+)?\s+(XLM|USDC|BTC|ETH|xlm|usdc|btc|eth)\b/g;
// An eleven-digit run: a Nigerian NIN, and also a Nigerian phone number. Both
// are personal data under the NDPA, and the KYC and cash-out screens handle
// both — a crash while verifying is exactly when one would be in a message.
// Deliberately broad: over-scrubbing a crash report costs a little context,
// under-scrubbing one sends an identity document to a third party.
const ELEVEN_DIGIT_RE = /\b\d{11}\b/g;

/** Rewrite wallet and personal data out of any string headed for Sentry. */
export function scrubString(value: string): string {
  return value
    .replace(STELLAR_SECRET_RE, '[secret]')
    .replace(STELLAR_ADDRESS_RE, '[address]')
    .replace(AMOUNT_RE, '[amount]')
    .replace(ELEVEN_DIGIT_RE, '[redacted]');
}

type SentryEvent = Parameters<NonNullable<Parameters<typeof Sentry.init>[0]['beforeSend']>>[0];

export function scrubEvent(event: SentryEvent): SentryEvent | null {
  if (event.message) {
    event.message = scrubString(event.message);
  }
  if (event.exception?.values) {
    for (const exception of event.exception.values) {
      if (exception.value) exception.value = scrubString(exception.value);
    }
  }
  return event;
}

/** The DSN this build was configured with, or null when it was not. */
export function getSentryDsn(): string | null {
  return process.env['EXPO_PUBLIC_SENTRY_DSN'] ?? null;
}

let initialized = false;

/** The stored choice — false when never asked, or when storage fails. */
export async function getSentryOptIn(): Promise<boolean> {
  try {
    return (await AsyncStorage.getItem(OPT_IN_STORAGE_KEY)) === 'true';
  } catch {
    return false;
  }
}

/**
 * Initialise if — and only if — a DSN exists and the user has opted in.
 * Called on launch and whenever the opt-in flips on. Resolves whether
 * reporting is now live.
 */
export async function initSentry(): Promise<boolean> {
  if (initialized) return true;
  const dsn = getSentryDsn();
  if (!dsn) return false;
  if (!(await getSentryOptIn())) return false;

  Sentry.init({
    dsn,
    environment: process.env.NODE_ENV ?? 'development',
    // Crash events only — this app is not a place to start sampling traces.
    tracesSampleRate: 0,
    beforeSend: scrubEvent,
  });
  initialized = true;
  return true;
}

/** Turn reporting off now, rather than at the next launch. */
export async function shutdownSentry(): Promise<void> {
  if (!initialized) return;
  initialized = false;
  try {
    await Sentry.close();
  } catch {
    // A reporter that refuses to close must not take the app down with it.
  }
}

/** Store the choice and apply it immediately. */
export async function setSentryOptIn(value: boolean): Promise<void> {
  try {
    await AsyncStorage.setItem(OPT_IN_STORAGE_KEY, String(value));
  } catch {
    // If the choice cannot be stored it cannot be honoured next launch
    // either; applying it now is still worth doing.
  }
  if (value) await initSentry();
  else await shutdownSentry();
}

/**
 * Report an error, if reporting is live. Silent by design: no screen may
 * depend on this, and a reporter that throws must never become a second
 * failure on top of the first.
 */
export function captureMobileError(error: unknown): void {
  if (!initialized) return;
  try {
    Sentry.captureException(error);
  } catch {
    // Deliberately empty — see above.
  }
}

/** Test seam: forget whether Sentry was initialised. */
export function resetSentryInitForTesting(): void {
  initialized = false;
}
