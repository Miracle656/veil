/**
 * /api/sep24/callback — SEP-24 interactive callback handler.
 *
 * SEP-24 anchors notify the wallet that an interactive deposit/withdrawal has
 * progressed in one of two ways, both handled here:
 *
 *  1. Browser redirect (GET): when the user closes the interactive flow the
 *     anchor redirects the popup to our `callback` URL, appending the anchor
 *     transaction id (`transaction_id` / `id`) and sometimes a `status`. We
 *     fetch the canonical status from the anchor, then redirect the user back
 *     to the dashboard with a human-readable result.
 *
 *  2. Server-to-server callback (POST): if the wallet registered a callback URL,
 *     the anchor POSTs the transaction JSON whenever the status changes. We ack
 *     with 200 so the anchor stops retrying. A real app would persist the update
 *     and/or push it to the user (websocket, etc.).
 *
 * Spec: https://github.com/stellar/stellar-protocol/blob/master/ecosystem/sep-0024.md
 */
export default defineEventHandler(async (event) => {
  const { anchorDomain } = useRuntimeConfig(event)

  // ── Case 2: anchor server-to-server status callback ──────────────────────
  if (isMethod(event, 'POST')) {
    const payload = await readBody<{ transaction?: { id?: string; status?: string } }>(event)
    const txn = payload?.transaction
    // In a real app: look up the user by txn.id and persist txn.status here.
    console.info('[sep24] status callback', txn?.id, '→', txn?.status)
    return { received: true }
  }

  // ── Case 1: interactive redirect back to the wallet ──────────────────────
  const query = getQuery(event)
  const txnId = (query.transaction_id ?? query.id) as string | undefined

  if (!txnId) {
    // Nothing to reconcile — bounce to the dashboard untouched.
    return sendRedirect(event, '/dashboard', 302)
  }

  // Prefer the anchor's canonical status; fall back to whatever it appended.
  let status = (query.status as string | undefined) ?? 'unknown'
  try {
    const { transferServerUrl } = await discoverAnchorInfo(anchorDomain)
    const txn = await getTransactionStatus(transferServerUrl, txnId)
    status = txn.status
  } catch {
    // Keep the query-provided status if the anchor lookup fails.
  }

  const params = new URLSearchParams({ deposit: status, id: txnId })
  return sendRedirect(event, `/dashboard?${params.toString()}`, 302)
})
