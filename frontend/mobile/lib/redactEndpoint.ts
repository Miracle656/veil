/**
 * An endpoint URL with its path masked.
 *
 * Provider keys live in the URL path (QuickNode puts the token there), so the
 * host is shown — the part a human checks to see which provider is live — and
 * the rest is masked.
 *
 * This is defence in depth, not a fix for the underlying exposure: anything in
 * an EXPO_PUBLIC_ variable ships inside the bundle and can be extracted from
 * the APK. The real protection is a key scoped to read-only RPC and rotated
 * when leaked.
 *
 * Lives here rather than in the network screen because About shows the same
 * endpoints, and a second copy is how one of them ends up printing the key.
 */
export function redactEndpoint(url: string): string {
  if (!url) return '';
  try {
    const parsed = new URL(url);
    const path = parsed.pathname.replace(/^\/|\/$/g, '');
    if (!path) return `${parsed.protocol}//${parsed.host}`;
    return `${parsed.protocol}//${parsed.host}/${'•'.repeat(8)}`;
  } catch {
    // Not a parseable URL — show nothing rather than risk showing a secret.
    return '(set)';
  }
}
