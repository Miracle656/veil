/**
 * URL redaction for logs and the public `/status` payload.
 *
 * Soroban RPC providers put the API key in the URL *path*, not in a header or a
 * query string — `https://<host>/<key>` is the normal shape for QuickNode and
 * others. So an RPC URL is a credential, and two things here would have
 * published one:
 *
 *   • the boot log printed `RPC_URL` verbatim, which lands in Fly.io / Render
 *     logs, and
 *   • the indexer stored raw error text in `lastError`, which `/status` serves
 *     to anyone — and the Stellar SDK routinely embeds the request URL in the
 *     messages it throws.
 *
 * Both now go through here. We keep the origin, because knowing *which* host is
 * failing is the entire diagnostic value, and drop the path, which is the part
 * that is secret.
 */

/** `https://host/KEY/more` → `https://host/…`. Non-URLs are returned as-is. */
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

/**
 * Redact every absolute http(s) URL embedded anywhere in a free-text message.
 * Used on error strings, whose shape we do not control.
 */
export function redactUrlsInText(message: string): string {
  return message.replace(/https?:\/\/[^\s"'`)<>\]]+/gi, (match) => redactUrl(match));
}
