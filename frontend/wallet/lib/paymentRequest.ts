/**
 * SEP-7 payment-request (invoice) links with QR — wallet wiring.
 *
 * Two directions:
 *   Outbound — `createPaymentRequest` turns invoice details (amount, asset, memo,
 *              callback) into a shareable SEP-7 `web+stellar:pay` URI plus the QR
 *              payload to render (e.g. `<QRCodeCanvas value={qrValue} />`).
 *   Inbound  — `parsePaymentLink` / `parseScannedValue` take an untrusted link or
 *              scanned QR value, validate it via the SDK, and return normalised
 *              fields ready to pre-fill the send flow.
 *
 * All validation/normalisation lives in the SDK (`@veil/sep7`), so hostile or
 * malformed input is rejected before it reaches the UI.
 */

import {
  buildSep7PayUri,
  parseSep7PayUri,
  parseSep7QrValue,
  Sep7Error,
  type Sep7PayParams,
  type Sep7PayRequest,
  type Sep7MemoType,
} from '@veil/sep7'

/** Fields the send flow can be pre-filled with from a payment request. */
export type PrefilledSend = {
  destination: string
  amount?: string
  assetCode?: string
  assetIssuer?: string
  memo?: string
  memoType?: Sep7MemoType
  callback?: string
  msg?: string
}

/** A generated payment request: the SEP-7 URI and the value to encode as a QR. */
export type PaymentRequest = {
  /** The `web+stellar:pay?…` URI. */
  uri: string
  /** The string to encode in the QR code (identical to {@link PaymentRequest.uri}). */
  qrValue: string
}

/**
 * Build a shareable SEP-7 payment request and its QR payload.
 *
 * @throws {Sep7Error} if any field is invalid (e.g. bad address/amount/asset).
 */
export function createPaymentRequest(params: Sep7PayParams): PaymentRequest {
  const uri = buildSep7PayUri(params)
  return { uri, qrValue: uri }
}

/** Map a validated SEP-7 request onto the send-flow pre-fill shape. */
export function toPrefilledSend(request: Sep7PayRequest): PrefilledSend {
  const prefilled: PrefilledSend = { destination: request.destination }
  if (request.amount !== undefined) prefilled.amount = request.amount
  if (request.assetCode !== undefined) prefilled.assetCode = request.assetCode
  if (request.assetIssuer !== undefined) prefilled.assetIssuer = request.assetIssuer
  if (request.memo !== undefined) prefilled.memo = request.memo
  if (request.memoType !== undefined) prefilled.memoType = request.memoType
  if (request.callback !== undefined) prefilled.callback = request.callback
  if (request.msg !== undefined) prefilled.msg = request.msg
  return prefilled
}

/**
 * Parse an inbound SEP-7 payment link (untrusted) into send-flow pre-fill fields.
 *
 * @throws {Sep7Error} if the link is not a valid `web+stellar:pay` URI.
 */
export function parsePaymentLink(input: string): PrefilledSend {
  return toPrefilledSend(parseSep7PayUri(input))
}

/**
 * Parse a scanned QR value, which may be either a bare Stellar address or a full
 * SEP-7 URI, into send-flow pre-fill fields.
 *
 * @throws {Sep7Error} if the value is neither a valid address nor a valid URI.
 */
export function parseScannedValue(value: string): PrefilledSend {
  return toPrefilledSend(parseSep7QrValue(value))
}

/** Cheap check that a string looks like a SEP-7 URI (no validation performed). */
export function isPaymentRequestUri(input: string): boolean {
  return typeof input === 'string' && input.trim().toLowerCase().startsWith('web+stellar:')
}

/**
 * Safe variant of {@link parsePaymentLink} that returns null instead of throwing,
 * for call sites that prefer to branch on success (e.g. paste handlers).
 */
export function tryParsePaymentLink(input: string): PrefilledSend | null {
  try {
    return parsePaymentLink(input)
  } catch (err) {
    if (err instanceof Sep7Error) return null
    throw err
  }
}

export { Sep7Error }
export type { Sep7PayParams, Sep7PayRequest, Sep7MemoType }
