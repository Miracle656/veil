/**
 * The app half of the dApp provider.
 *
 * {@link handleProviderMessage} takes one `postMessage` payload from an injected
 * page and returns the JavaScript that answers it — or nothing at all. It is the
 * only place that decides what a page may ask for, and it is built out of the
 * pieces the issue named: the allow-list decides whether a provider exists,
 * `lib/dappBridge.ts` decides whether this request is allowed, and signing stays
 * in `lib/walletConnect.ts`. Nothing here builds or signs an XDR.
 *
 * Four rules hold the surface down.
 *
 * **An origin outside the allow-list gets no answer.** The provider is injected
 * only into approved pages, and even then a message whose frame origin is not the
 * approved origin is dropped rather than answered. Both checks run per message,
 * so nothing carries over from the page that happened to load first.
 *
 * **Nothing is signed silently.** A signature request goes to the user with the
 * request decoded, every time — see {@link AuthorizeOptions.alwaysPrompt}. A
 * remembered grant means "this site may ask", never "this site may sign".
 *
 * **Only result keys leave the app.** A reply is assembled field by field from
 * {@link ProviderResult}: an address, a signed XDR, a network name. Secrets, key
 * material and the passkey credential id are not merely filtered out — the
 * signing functions do not return them, so there is nothing here to leak.
 *
 * **A request that cannot be shown accurately is refused before it is shown.**
 * Malformed XDR, a transaction built for another network, an operation shape this
 * wallet cannot sign, an auth entry addressed to somebody else's contract: each
 * answered with SEP-43 code -3 and the reason, never queued in front of the user
 * and never signed.
 */

import { Address, FeeBumpTransaction, TransactionBuilder, xdr } from '@stellar/stellar-sdk';

import { ALLOWED_ORIGINS, normalizeOrigin as normalizePageOrigin } from './dappAllowlist';
import {
  discloseAddressToOrigin,
  DappRequestRejected,
  withOriginPermission,
  type AuthorizeOptions,
  type PermissionPrompt,
} from './dappBridge';
import {
  errorResponse,
  parseProviderRequest,
  SEP43_ERROR,
  serializeProviderReply,
  unsupportedResponse,
  type ProviderRequest,
  type ProviderResponse,
  type ProviderResult,
} from './dappProvider';
import { errorMessage } from './errorMessage';
import { isUserRejection } from './walletConnectHelpers';
import {
  describeAuthEntryXdr,
  describeTransactionXdr,
  type RequestDetails,
} from './transactionRequestDetails';
import type { PermissionScope } from './permissions';

/** The network the wallet is on right now, as the provider reports it. */
export type ProviderNetwork = {
  /** `'testnet'` or `'mainnet'` — the value SEP-43's `network` field carries. */
  name: string;
  displayName: string;
  networkPassphrase: string;
};

/**
 * Everything the bridge needs, supplied by the caller.
 *
 * Injection is what lets this be tested without a WebView, a passkey or an RPC
 * endpoint, and it keeps the screen in charge of presentation: the bridge
 * decides, `app/dapp.tsx` shows.
 */
export type ProviderContext = {
  /** The allow-listed origin this WebView is approved for. */
  approvedOrigin: string;
  /**
   * The origin of the frame that posted the message, as the WebView reports it.
   * `null` when the platform gave no URL — a message whose origin cannot be
   * verified is never answered.
   */
  messageOrigin: string | null;
  /** The allow-list's name for the page, shown in the prompt. */
  dappName?: string;
  /** Presents the approval prompt. */
  prompt: PermissionPrompt;
  /** Whether a scope is granted right now, without prompting. */
  isGranted: (origin: string, scope: PermissionScope) => boolean;
  /** The wallet address this device would disclose, or null when there is none. */
  getAddress: () => Promise<string | null>;
  /** Sign a dApp transaction. `signXdrPayload`. */
  signTransactionXdr: (xdrString: string) => Promise<string>;
  /** Sign one standalone Soroban auth entry. `signAuthEntryPayload`. */
  signAuthEntryXdr: (xdrString: string) => Promise<string>;
  /** Whether a passkey signer is registered at all. */
  hasSigner: () => boolean;
  /** The active network. */
  network: () => ProviderNetwork;
};

/** What the bridge did with a message. */
export type HandledProviderMessage =
  | {
      kind: 'ignored';
      /** Why nothing was answered. Logged app-side, never sent to the page. */
      reason: IgnoreReason;
    }
  | {
      kind: 'replied';
      requestId: string;
      method: ProviderRequest['method'];
      /** The `injectJavaScript` body that answers the page. */
      javascript: string;
      /** The SEP-43 payload, for tests and logging. */
      response: ProviderResponse;
    };

/**
 * Why a message was dropped with no reply at all.
 *
 * Not reported to the page on purpose: a payload that is not a well-formed
 * request may not have come from the provider script in the first place, and
 * answering it would teach an unknown sender which envelope we understand.
 */
export type IgnoreReason = 'not-a-provider-request' | 'origin-not-allowed' | 'origin-not-verified';

/** The user-facing answer for a request the caller has no business making. */
const NOT_SIGNED_FOR_YOU = 'This request names a wallet other than the one on this device.';

/** Whether an error is a decline rather than a failure, in either of its forms. */
function isDecline(error: unknown): boolean {
  return error instanceof DappRequestRejected || isUserRejection(error);
}

/**
 * Map a thrown failure onto a SEP-43 error code.
 *
 * The message text is already user-facing — `signXdrPayload` runs failures
 * through `simulationErrorMessage()`, which explains what went wrong in prose —
 * so only the code is decided here. External service covers everything the wallet
 * does not control: RPC, Horizon, simulation, the nonce read.
 */
function toProviderError(error: unknown): ProviderResponse {
  if (isDecline(error)) {
    return errorResponse(SEP43_ERROR.userRejected, 'The user rejected this request.');
  }
  const message = errorMessage(error);
  if (/rpc|horizon|simulat|nonce|ledger|footprint|network|connection|timeout|enforce/i.test(message)) {
    return errorResponse(SEP43_ERROR.externalService, message);
  }
  return errorResponse(SEP43_ERROR.internal, message);
}

/** The XDRs a `signAuthEntry` call asked for, single or list, already validated as strings. */
function authEntryRequests(request: ProviderRequest): string[] {
  if (request.xdrList) return request.xdrList;
  return request.xdr ? [request.xdr] : [];
}

/** Did the caller name a network this wallet is not on? */
function networkMismatch(request: ProviderRequest, network: ProviderNetwork): string | null {
  if (request.opts.networkPassphrase && request.opts.networkPassphrase !== network.networkPassphrase) {
    return `This request was built for "${request.opts.networkPassphrase}", but Veil is on ${network.displayName}.`;
  }
  return null;
}

/**
 * A transaction this wallet may sign: one Soroban host function, which is the
 * shape `signXdrPayload()`'s `__check_auth` ceremony is written for.
 *
 * Checked before the user is asked, because the alternative is worse. The signing
 * path assembles the on-chain transaction from its first operation, so a
 * multi-operation envelope approved anyway would go on chain missing operations
 * the user never saw. Refusing here is also what keeps the provider from needing
 * a second signing path — see `lib/dappBridge.ts` on why that matters.
 */
function validateTransactionRequest(
  request: ProviderRequest,
  context: ProviderContext,
  walletAddress: string
): string | null {
  if (!request.xdr) return 'signTransaction needs the transaction XDR as a base64 string.';

  // Signing and submitting are separate acts here on purpose: the user approves
  // one signature, and the dApp remains the party that moves the transaction.
  if (request.opts.submit) {
    return 'Veil signs the transaction and returns it; it does not submit it for you. Submit the returned signedTxXdr yourself.';
  }

  const network = context.network();
  const wrongNetwork = networkMismatch(request, network);
  if (wrongNetwork) return wrongNetwork;
  if (request.opts.address && request.opts.address !== walletAddress) return NOT_SIGNED_FOR_YOU;

  let transaction: ReturnType<typeof TransactionBuilder.fromXDR>;
  try {
    transaction = TransactionBuilder.fromXDR(request.xdr, network.networkPassphrase);
  } catch {
    return 'The transaction XDR could not be read.';
  }

  // A fee bump wraps someone else's transaction: it has no operation list of its
  // own, and its source is the account paying the fee, not the wallet being
  // authorised. Reading it as a transaction would describe it wrongly.
  if (transaction instanceof FeeBumpTransaction) {
    return 'Veil signs a transaction envelope, not a fee-bump envelope.';
  }

  const operations = transaction.operations ?? [];
  if (operations.length !== 1) {
    return `Veil can sign a one-operation transaction; this one has ${operations.length}.`;
  }
  if (operations[0]?.type !== 'invokeHostFunction') {
    return `Veil signs a Soroban host function call; this operation is "${String(operations[0]?.type)}".`;
  }

  // The contract this device's passkey authorises is the one loaded here. A
  // request addressed to a different contract is refused, not merely labelled.
  const source = transaction.source;
  if (typeof source === 'string' && source.startsWith('C') && source !== walletAddress) {
    return NOT_SIGNED_FOR_YOU;
  }

  return null;
}

/**
 * One standalone auth entry, checked before it can reach the prompt.
 *
 * The address rule is the important one. A `SorobanAddressCredentials` entry
 * names the account whose key must sign it, and the signed preimage does not
 * include that name — so an entry pointed at a different wallet must never be
 * answered, or this device's key would be signing authorisation for someone
 * else's account.
 */
function validateAuthEntryRequest(
  entryXdr: string,
  request: ProviderRequest,
  context: ProviderContext,
  walletAddress: string
): string | null {
  const wrongNetwork = networkMismatch(request, context.network());
  if (wrongNetwork) return wrongNetwork;
  if (request.opts.address && request.opts.address !== walletAddress) return NOT_SIGNED_FOR_YOU;

  let entry: xdr.SorobanAuthorizationEntry;
  try {
    entry = xdr.SorobanAuthorizationEntry.fromXDR(entryXdr, 'base64');
  } catch {
    return 'The authorization entry XDR could not be read.';
  }

  const credentials = entry.credentials();
  if (credentials.switch().name !== 'sorobanCredentialsAddress') {
    return 'Veil signs an address-authorized Soroban entry; this one is not address-authorized.';
  }

  let addressed: string;
  try {
    addressed = Address.fromScAddress(credentials.address().address()).toString();
  } catch {
    return 'The authorization entry names an address that cannot be read.';
  }
  if (addressed !== walletAddress) return NOT_SIGNED_FOR_YOU;

  return null;
}

/** What to show the user for the thing they are about to approve. */
function detailsForRequest(request: ProviderRequest, networkPassphrase: string): RequestDetails | undefined {
  if (request.method === 'signTransaction' && request.xdr) {
    return describeTransactionXdr(request.xdr, networkPassphrase);
  }
  if (request.method === 'signAuthEntry') {
    const entries = authEntryRequests(request);
    if (!entries.length) return undefined;
    const first = describeAuthEntryXdr(entries[0]);
    return entries.length > 1 ? { ...first, operationCount: entries.length } : first;
  }
  return undefined;
}

async function respondToRequest(
  request: ProviderRequest,
  context: ProviderContext
): Promise<ProviderResponse> {
  // A method the interface names and Veil does not serve gets the standard error,
  // before anything is parsed, prompted for, or signed.
  const unsupported = unsupportedResponse(request.method);
  if (unsupported) return unsupported;

  switch (request.method) {
    // Network name only: it lets a dApp confirm it is building for the right
    // chain, which is exactly what SEP-43 says getNetwork is for. It discloses no
    // account, so it asks for no permission either.
    case 'getNetwork': {
      const network = context.network();
      const result: ProviderResult = { network: network.name, networkPassphrase: network.networkPassphrase };
      return result;
    }

    // Connection state, without a prompt: a dApp probing whether it is already
    // allowed must not be able to summon an approval sheet.
    case 'isApproved': {
      const result: ProviderResult = {
        approved: context.isGranted(context.approvedOrigin, 'address_disclosure'),
      };
      return result;
    }

    // Disclosure, and the connect gesture that asks for the same permission
    // without taking the address back. One gate, one prompt.
    case 'request':
    case 'getAddress':
    case 'getAddresses': {
      return await respondToDisclosureRequest(request, context);
    }

    case 'signTransaction':
    case 'signAuthEntry': {
      return await respondToSigningRequest(request, context);
    }

    default:
      return errorResponse(SEP43_ERROR.invalidRequest, `${request.method} is not available in Veil.`);
  }
}

/**
 * Answer a disclosure request through the address scope.
 *
 * The wallet is read before the user is asked, so a device that has no wallet
 * answers "this wallet does not exist yet" rather than showing a prompt that
 * cannot be honoured and then reporting a rejection the user never made.
 */
async function respondToDisclosureRequest(
  request: ProviderRequest,
  context: ProviderContext
): Promise<ProviderResponse> {
  if (!(await context.getAddress())) {
    return errorResponse(
      SEP43_ERROR.internal,
      'No wallet on this device yet. Create or recover one before connecting a dApp.'
    );
  }

  try {
    const address = await discloseAddressToOrigin(
      {
        origin: context.approvedOrigin,
        scope: 'address_disclosure',
        name: context.dappName,
        prompt: context.prompt,
      },
      context.getAddress
    );

    if (request.method === 'request') {
      const result: ProviderResult = { approved: true };
      return result;
    }
    const result: ProviderResult =
      request.method === 'getAddress' ? { address } : { addresses: [address] };
    return result;
  } catch (error) {
    return toProviderError(error);
  }
}

async function respondToSigningRequest(
  request: ProviderRequest,
  context: ProviderContext
): Promise<ProviderResponse> {
  // No signer means no assertion — say so before the user is asked to approve
  // something that cannot possibly be produced.
  if (!context.hasSigner()) {
    return errorResponse(
      SEP43_ERROR.internal,
      'Veil cannot sign right now. Unlock the wallet and try again.'
    );
  }

  const walletAddress = await context.getAddress();
  if (!walletAddress) {
    return errorResponse(
      SEP43_ERROR.internal,
      'No wallet on this device yet. Create or recover one before connecting a dApp.'
    );
  }

  const entries = request.method === 'signAuthEntry' ? authEntryRequests(request) : [];

  if (request.method === 'signTransaction') {
    const problem = validateTransactionRequest(request, context, walletAddress);
    if (problem) return errorResponse(SEP43_ERROR.invalidRequest, problem);
  } else {
    if (!entries.length) {
      return errorResponse(SEP43_ERROR.invalidRequest, 'signAuthEntry needs the authorization entry XDR.');
    }
    for (const entry of entries) {
      const problem = validateAuthEntryRequest(entry, request, context, walletAddress);
      if (problem) return errorResponse(SEP43_ERROR.invalidRequest, problem);
    }
  }

  const options: AuthorizeOptions = {
    origin: context.approvedOrigin,
    scope: 'transaction_signing',
    name: context.dappName,
    prompt: context.prompt,
    alwaysPrompt: true,
    details: detailsForRequest(request, context.network().networkPassphrase),
  };

  // One approval for the call, then one assertion per payload. A batch of auth
  // entries is a batch of passkey prompts by design: each is a separate signature
  // the device agrees to, and nothing here is allowed to sign them as a group.
  try {
    const signed = await withOriginPermission(options, async () => {
      if (request.method === 'signTransaction') {
        return [await context.signTransactionXdr(request.xdr as string)];
      }
      const all: string[] = [];
      for (const entry of entries) all.push(await context.signAuthEntryXdr(entry));
      return all;
    });

    if (request.method === 'signTransaction') {
      const result: ProviderResult = { signedTxXdr: signed[0], signerAddress: walletAddress };
      return result;
    }
    const result: ProviderResult = {
      signedAuthEntry: signed[0],
      signerAddress: walletAddress,
      // Only a call that asked for a list gets the list back. SEP-43 documents
      // the single shape; the extra key is Freighter's array form, and it is
      // never added to a single-entry reply.
      ...(request.wantsList ? { signedAuthEntries: signed } : {}),
    };
    return result;
  } catch (error) {
    return toProviderError(error);
  }
}

/**
 * Answer one message from an injected dApp page.
 *
 * Every branch either replies or says why it ignored the message; nothing leaves
 * a page waiting on purpose, and no path here signs anything itself.
 */
export async function handleProviderMessage(
  data: unknown,
  context: ProviderContext
): Promise<HandledProviderMessage> {
  const request = parseProviderMessage(data);
  if (!request) return { kind: 'ignored', reason: 'not-a-provider-request' };

  // Two origin checks, both per message. The approved origin has to be a page Veil
  // lists at all — injection should already guarantee that, and this is the belt.
  if (!ALLOWED_ORIGINS.has(context.approvedOrigin)) {
    return { kind: 'ignored', reason: 'origin-not-allowed' };
  }
  // And the frame that asked has to be that page: not an iframe inside it, not a
  // document the WebView has since navigated to, not a message with no origin.
  const frameOrigin = context.messageOrigin ? normalizePageOrigin(context.messageOrigin) : null;
  if (!frameOrigin || frameOrigin !== context.approvedOrigin) {
    return { kind: 'ignored', reason: 'origin-not-verified' };
  }

  const response = await respondToRequest(request, context);
  return {
    kind: 'replied',
    requestId: request.id,
    method: request.method,
    javascript: serializeProviderReply(request.id, response),
    response,
  };
}

/** Parse, or return null for anything that is not a well-formed request. */
function parseProviderMessage(data: unknown): ProviderRequest | null {
  try {
    return parseProviderRequest(data);
  } catch {
    // A payload that breaks the parser is not a request; nothing else to do.
    return null;
  }
}
