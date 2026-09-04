/**
 * Context for a failed Soroban simulation.
 *
 * "Simulation failed: Could not unmarshal transaction" says only that the RPC
 * could not decode what it was sent. It does not say which of the app's flows
 * sent it, which chain it went to, or whether the transaction was empty before
 * it ever left the device — and those are the three things that separate a bug
 * in our XDR from a request pointed at the wrong place.
 *
 * The RPC returns that same message for an empty string, for something that is
 * not base64, and for base64 that is not a transaction envelope, so the message
 * alone cannot distinguish them either.
 */

/** A well-formed base64 envelope is never this short; empty is the failure we can name locally. */
const MIN_PLAUSIBLE_XDR = 80;

/**
 * Throw before simulating when the transaction did not encode.
 *
 * XDR is built through `Buffer.toString('base64')`, which is a polyfill on
 * Hermes rather than a built-in. When that misbehaves the result is an empty or
 * truncated string that looks like a server-side decode failure, and blaming
 * the RPC for it costs an afternoon.
 */
export function assertEncodable(xdr: string, flow: string): void {
  if (!xdr || xdr.length < MIN_PLAUSIBLE_XDR) {
    throw new Error(
      `${flow}: the transaction did not encode on this device ` +
        `(${xdr ? `${xdr.length} characters` : 'empty'}). This is a problem before the network, not on it.`,
    );
  }
}

/**
 * A simulation error, told with the context needed to place it.
 *
 * @param error The `error` string the RPC returned.
 * @param flow  Which of the app's operations was being simulated.
 * @param rpcUrl The endpoint it went to — only the host is included, since the
 *               path can carry an API token.
 * @param network Which chain the transaction was built for.
 * @param xdrLength Size of the encoded envelope that was sent.
 */
export function simulationErrorMessage(params: {
  error: string;
  flow: string;
  rpcUrl: string;
  network: string;
  xdrLength: number;
}): string {
  let host = 'unknown host';
  try {
    host = new URL(params.rpcUrl).host;
  } catch {
    host = params.rpcUrl ? 'unparseable URL' : 'no RPC URL configured';
  }

  return (
    `${params.flow} failed to simulate: ${params.error} ` +
    `(${params.network} via ${host}, ${params.xdrLength}-character envelope)`
  );
}
