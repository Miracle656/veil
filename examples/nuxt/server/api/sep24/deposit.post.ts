/**
 * POST /api/sep24/deposit
 *
 * Starts a SEP-24 interactive deposit server-side and returns the anchor's
 * interactive `url` (open it in a popup) and transaction `id`. The anchor is
 * told to redirect back to /api/sep24/callback when the flow finishes.
 *
 * Body: { account: string; assetCode?: string }
 */
export default defineEventHandler(async (event) => {
  const { account, assetCode } = await readBody<{ account?: string; assetCode?: string }>(event)

  if (!account || !(account.startsWith('G') || account.startsWith('C'))) {
    throw createError({ statusCode: 400, statusMessage: 'A valid Stellar `account` is required' })
  }

  const { anchorDomain } = useRuntimeConfig(event)

  // Build the absolute callback URL from the incoming request's origin.
  const origin = getRequestProtocol(event) + '://' + getRequestHost(event)
  const callbackUrl = `${origin}/api/sep24/callback`

  const { transferServerUrl } = await discoverAnchorInfo(anchorDomain)

  // NOTE: production anchors require a SEP-10 JWT (`Authorization: Bearer`).
  // Obtain it by signing the anchor's challenge with the wallet passkey on the
  // client, then forward it here. The Stellar reference test anchor accepts
  // unauthenticated interactive requests, which keeps this demo self-contained.
  const result = await initiateDeposit(transferServerUrl, {
    assetCode: assetCode || 'SRT',
    account,
    callbackUrl,
  })

  return result
})
