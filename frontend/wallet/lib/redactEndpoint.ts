/**
 * An endpoint URL with its path masked.
 *
 * Provider keys live in the URL path (QuickNode puts the token there), so the
 * host is shown — the part a human checks to see which provider is live — and
 * the rest is masked.
 *
 * Ported from frontend/mobile/lib/redactEndpoint.ts so the web About screen
 * carries the same guarantee: an RPC URL is never rendered with its path intact.
 */
export function redactEndpoint(url: string): string {
  if (!url) return ''
  try {
    const parsed = new URL(url)
    const path = parsed.pathname.replace(/^\/|\/$/g, '')
    if (!path) return `${parsed.protocol}//${parsed.host}`
    return `${parsed.protocol}//${parsed.host}/${'•'.repeat(8)}`
  } catch {
    // Not a parseable URL — show nothing rather than risk showing a secret.
    return '(set)'
  }
}
