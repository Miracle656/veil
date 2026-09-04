/**
 * The WebAuthn relying-party id — the domain passkeys are scoped to. Must be a
 * live domain we control that serves the Android assetlinks association file
 * (and, for iOS, apple-app-site-association).
 *
 * NOTE: veil.xyz is NOT owned (parked / for sale), so the canonical
 * `app.veil.xyz` from older configs cannot work. The live wallet deployment
 * is the relying party.
 */
export function getRelyingPartyId(): string {
  // app.useveilapp.xyz is the PERMANENT relying party (owned domain, live since
  // 2026-08-22, serves assetlinks with the app cert fingerprint). Passkeys are
  // bound to this domain forever — do not change casually. Credentials created
  // against the earlier veil-ezry.vercel.app RP are legacy/testnet-only.
  return process.env['EXPO_PUBLIC_PASSKEY_RP_ID']?.trim() || 'app.useveilapp.xyz';
}

/**
 * The exact WebAuthn origin the platform stamps into clientDataJSON — what the
 * wallet contract stores at deploy and compares byte-for-byte in __check_auth.
 *
 * Native Android assertions carry `android:apk-key-hash:<b64url(cert-sha256)>`,
 * NOT an https origin. This default matches the current dev-build keystore
 * (cert 0F:DA:A5:8B…); a release build signs with a different cert and MUST
 * override via EXPO_PUBLIC_PASSKEY_ORIGIN or its wallets will hit
 * OriginMismatch (#9) on every contract spend.
 *
 * KNOWN LIMIT: the contract accepts a single origin, so a wallet deployed from
 * the native app cannot be signed from the web and vice versa. Multi-origin
 * __check_auth is the contract-side roadmap fix.
 */
export function getWebAuthnOrigin(): string {
  return (
    process.env['EXPO_PUBLIC_PASSKEY_ORIGIN']?.trim() ||
    'android:apk-key-hash:D9qli1VVzfL7b5X0pddQcUG1tB6298g7VBbxvJkJV0Q'
  );
}
