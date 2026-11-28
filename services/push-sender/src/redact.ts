/**
 * Sensitive data redaction for logs, error messages, and public diagnostics (#1275).
 * Mirrors patterns from services/spp-bootnode/src/redact.ts.
 */

/** Redact URL path/query credentials: `https://host/KEY` -> `https://host/…`. Non-URLs returned as-is. */
export function redactUrl(value: string): string {
  try {
    const url = new URL(value);
    return url.pathname === '/' || url.pathname === ''
      ? url.origin
      : `${url.origin}/…`;
  } catch {
    return value;
  }
}

/** Redact every absolute http(s) URL embedded anywhere in a free-text message. */
export function redactUrlsInText(message: string): string {
  return message.replace(/https?:\/\/[^\s"'`)<>\]]+/gi, (match) => redactUrl(match));
}

/** Redact Expo push tokens in format ExponentPushToken[...] or ExpoPushToken[...]. */
export function redactPushTokens(text: string): string {
  return text.replace(
    /(?:ExponentPushToken|ExpoPushToken)\[[A-Za-z0-9_\-]+\]/g,
    'ExponentPushToken[REDACTED]',
  );
}

/** Redact Authorization: Bearer tokens and x-admin-token headers. */
export function redactAuthHeaders(text: string): string {
  return text
    .replace(/Bearer\s+[A-Za-z0-9_\-\.]+/gi, 'Bearer [REDACTED]')
    .replace(/(x-admin-token|x-agent-token)\s*[:=]\s*[A-Za-z0-9_\-\.]+/gi, '$1: [REDACTED]');
}

/**
 * Universal text redaction: hides push tokens, bearer headers, specific secrets
 * (such as EXPO_ACCESS_TOKEN or PUSH_ADMIN_TOKEN), and sensitive URL paths.
 */
export function redactText(text: string, secrets: Array<string | undefined> = []): string {
  if (!text) return '';
  let out = redactPushTokens(text);
  out = redactAuthHeaders(out);
  out = redactUrlsInText(out);

  for (const secret of secrets) {
    if (secret && secret.trim().length > 0) {
      const s = secret.trim();
      out = out.split(s).join('[REDACTED]');
    }
  }

  return out;
}
