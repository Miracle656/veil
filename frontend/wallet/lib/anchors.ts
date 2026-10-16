/**
 * Default SEP-24 anchor for the web wallet.
 *
 * The anchor domain is the one value that legitimately comes from the build
 * environment — every network value (passphrase, Horizon, RPC) is read live
 * from `getNetwork()` instead. There is deliberately NO hard-coded anchor:
 * defaulting to `testanchor.stellar.org` pointed mainnet users at a testnet
 * anchor, the same defect #703 removed from the mobile screens. With no env
 * configured the default is `''` and the withdraw screen asks the user to
 * enter one.
 */

/** The first anchor from `NEXT_PUBLIC_SEP24_ANCHORS`, or `''` when unset. */
export function getDefaultAnchor(): string {
  return process.env.NEXT_PUBLIC_SEP24_ANCHORS?.split(',')[0]?.trim() || ''
}
