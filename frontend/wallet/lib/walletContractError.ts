/**
 * What the wallet contract's own errors mean, in a sentence.
 *
 * A failed `__check_auth` surfaces as a two-thousand-character `HostError` dump
 * with a diagnostic event log, and the only part that identifies the cause is
 * `Error(Contract, #N)` buried in the middle. Showing that to someone trying to
 * move 0.0097 XLM tells them nothing and reads like the wallet is broken.
 *
 * The discriminants are `WalletError` in `contracts/invisible_wallet/src/lib.rs`.
 * They are a stable on-chain ABI — the contract is not upgradeable, and the
 * deployed wallets will answer with these numbers forever — so matching on them
 * is safe in a way that matching on message text is not.
 *
 * Only errors a user can act on get a sentence. Everything else keeps the raw
 * text, which is what a developer needs and what a vague reassurance destroys.
 */

/** `Error(Contract, #N)` as the host prints it inside an auth failure. */
function contractErrorCode(detail: string): number | null {
  const m = detail.match(/Error\(Contract,\s*#(\d+)\)/)
  return m ? Number(m[1]) : null
}

/**
 * The origin baked into this wallet at deploy, versus the one signing now.
 *
 * `__check_auth` compares the `origin` in `clientDataJSON` byte for byte against
 * the value stored when the wallet was created. A wallet created in the mobile
 * app stores `android:apk-key-hash:…`; one created here stores
 * `https://app.useveilapp.xyz`. The contract holds exactly one, so a wallet made
 * in one place cannot be signed in the other — multi-origin `__check_auth` is a
 * contract change, not something a client can work around.
 *
 * Retrying never helps, which is why this must not fall through to the generic
 * "signature wasn't accepted, try again".
 */
function originMismatchMessage(detail: string): string {
  const origin = signedOrigin(detail)
  const here = typeof window === 'undefined' ? '' : window.location.origin

  const madeElsewhere =
    origin && here && origin === here
      ? 'This wallet was created somewhere else — most likely the Veil mobile app.'
      : 'This wallet was created with a different passkey origin.'

  return (
    `${madeElsewhere} For security the wallet only accepts signatures from where it was ` +
    `created, so it cannot be signed here. Open it in the app you created it with to move these funds.`
  )
}

/** The `origin` field of the assertion, pulled out of the diagnostic dump. */
export function signedOrigin(detail: string): string | null {
  // clientDataJSON travels through the log as hex inside Bytes(...).
  for (const [, hex] of detail.matchAll(/Bytes\(([0-9a-f]{40,})\)/g)) {
    if (!hex.startsWith('7b')) continue // not a '{' — not JSON
    try {
      // Decoded without TextDecoder on purpose: it is absent in jsdom, and a
      // helper that throws in the one environment the tests run in is a helper
      // nobody can check. clientDataJSON is ASCII JSON, so char codes are exact.
      const text = (hex.match(/../g) ?? [])
        .map((b) => String.fromCharCode(parseInt(b, 16)))
        .join('')
      const json = JSON.parse(text)
      if (typeof json.origin === 'string') return json.origin
    } catch {
      // Not the clientDataJSON blob; keep looking.
    }
  }
  return null
}

const MESSAGES: Record<number, string> = {
  3: 'That passkey is not a signer on this wallet.',
  4: "The passkey's public key was not accepted by the wallet.",
  5: 'The signature was malformed and the wallet rejected it.',
  6: 'The signature did not verify against any signer on this wallet.',
  7: 'The approval was for a different transaction. Start again.',
  8:
    'This wallet was created for a different domain, so it cannot be signed here. ' +
    'Open it in the app you created it with.',
  10: 'This is the wallet’s last signer and removing it would lock you out.',
  11: 'That signer is not on this wallet.',
  16: 'Something else moved funds from this wallet since this screen loaded. Reload and try again.',
}

/**
 * A sentence for a wallet-contract failure, or null when we cannot name it.
 *
 * Null means the caller should show the raw error. That is deliberate: an
 * unrecognised failure with its detail intact is diagnosable, and the same
 * failure behind "something went wrong" is not.
 */
export function walletContractErrorMessage(detail: string): string | null {
  if (!/Error\(Auth,|__check_auth/.test(detail)) return null

  const code = contractErrorCode(detail)
  if (code === 9) return originMismatchMessage(detail)
  if (code !== null && MESSAGES[code]) return MESSAGES[code]

  // An auth failure we cannot place. Say that much rather than guessing at a
  // cause — "try again" is wrong for most of them.
  return null
}
