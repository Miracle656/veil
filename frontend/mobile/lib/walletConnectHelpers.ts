/**
 * Pure helpers shared by the WalletConnect integration.
 *
 * Kept free of native-module imports so the parsing and validation rules can be
 * unit-tested without booting Expo, WalletConnect or the Stellar SDK.
 */

export type WalletConnectPeer = {
  name?: string;
  description?: string;
  url?: string;
  icons?: string[];
};

export type WalletConnectSession = {
  topic: string;
  chainId: string;
  account: string;
  peer: WalletConnectPeer | null;
};

export type WalletConnectProposal = {
  id: number;
  proposer?: {
    metadata?: WalletConnectPeer;
  };
};

export type WalletConnectRequest = {
  /** JSON-RPC id to respond with. */
  id: number;
  /** Session topic the request arrived on. */
  topic: string;
  method: string;
  params: unknown;
  chainId: string | null;
  /** Raw event, kept so nothing is lost when responding. */
  raw: unknown;
};

/** Methods this wallet advertises to dApps during session negotiation. */
export const WALLET_CONNECT_METHODS = ['stellar_signXDR', 'stellar_signAndSubmitXDR'];

export const WALLET_CONNECT_EVENTS = ['accountsChanged', 'chainChanged'];

export function getChainId(networkName: 'testnet' | 'mainnet'): string {
  return networkName === 'mainnet' ? 'stellar:pubnet' : 'stellar:testnet';
}

/**
 * Trim and validate a URI that was pasted or scanned.
 *
 * Scanners and clipboards routinely add surrounding whitespace, and some dApps
 * encode the pairing URI inside a deep link, so a `wc:` payload is accepted
 * wherever it appears in the scanned string.
 */
export function normalizeWalletConnectUri(input: string): string {
  const trimmed = input.trim();
  if (trimmed.toLowerCase().startsWith('wc:')) return trimmed;

  // Deep links carry the pairing URI in a query parameter, normally
  // percent-encoded, so decode before looking for it.
  let decoded = trimmed;
  try {
    decoded = decodeURIComponent(trimmed);
  } catch {
    // Malformed escape sequence — fall back to searching the raw string.
  }

  const embedded = decoded.match(/wc:[^\s"']+/i);
  if (embedded) return embedded[0];

  throw new Error('Invalid WalletConnect URI. It must start with "wc:".');
}

export function isWalletConnectUri(input: string): boolean {
  try {
    normalizeWalletConnectUri(input);
    return true;
  } catch {
    return false;
  }
}

/** Map a raw WalletConnect session record onto the shape the UI consumes. */
export function parseWalletConnectSession(raw: any, fallbackChainId: string): WalletConnectSession {
  const allAccounts = Object.values(raw?.namespaces ?? {}).flatMap(
    (namespace: any) => namespace?.accounts ?? []
  ) as string[];
  const account = allAccounts[0] ?? '';
  const chainId =
    account && account.includes(':') ? account.split(':').slice(0, 2).join(':') : fallbackChainId;

  return {
    topic: raw?.topic ?? '',
    chainId,
    account,
    peer: raw?.peer?.metadata ?? null,
  };
}

export function getRequestId(event: any): number {
  return Number(event?.id ?? event?.params?.request?.id ?? 0);
}

/**
 * Pull the transaction XDR out of a `stellar_signXDR` request.
 *
 * Stellar dApps are inconsistent about the shape of `params`: some send a bare
 * string, some an array, some an object keyed `xdr`, `transaction` or `tx`.
 * Returns null when no XDR can be found so callers can decide whether that is
 * an error or merely an unrecognised request.
 */
export function extractRequestXdr(params: any): string | null {
  if (typeof params === 'string') return params;

  if (Array.isArray(params)) {
    for (const item of params) {
      if (typeof item === 'string') return item;
      if (item && typeof item.xdr === 'string') return item.xdr;
      if (item && typeof item.transaction === 'string') return item.transaction;
    }
    return null;
  }

  if (params && typeof params.xdr === 'string') return params.xdr;
  if (params && typeof params.transaction === 'string') return params.transaction;
  if (params && typeof params.tx === 'string') return params.tx;

  return null;
}

/** Normalise a raw `session_request` event into the shape the UI consumes. */
export function parseWalletConnectRequest(event: any): WalletConnectRequest {
  return {
    id: getRequestId(event),
    topic: event?.topic ?? '',
    method: event?.params?.request?.method ?? '',
    params: event?.params?.request?.params,
    chainId: event?.params?.chainId ?? null,
    raw: event,
  };
}

export function buildWcResult(id: number, result: unknown) {
  return { id, jsonrpc: '2.0' as const, result };
}

export function buildWcError(id: number, code: number, message: string) {
  return { id, jsonrpc: '2.0' as const, error: { code, message } };
}

/**
 * Whether a thrown error means the user declined rather than something
 * genuinely failing — those two cases get different JSON-RPC error codes.
 */
export function isUserRejection(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return (
    message.includes('USER_REJECTED') ||
    message.includes('NotAllowedError') ||
    message.toLowerCase().includes('cancel')
  );
}
