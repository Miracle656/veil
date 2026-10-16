/**
 * The wire contract between a dApp page and Veil.
 *
 * `app/dapp.tsx` injects {@link dappProviderScript} into an allow-listed page. The
 * page sees a SEP-43 wallet provider; nothing in the page can reach a key, a
 * secret, or a credential id, because none is ever put in the message. The page
 * asks for one of a fixed list of methods over
 * `window.ReactNativeWebView.postMessage`, Veil answers by calling a single reply
 * hook with a JSON string.
 *
 * The shape of what the page is handed is SEP-0043 ("Standard Web Wallet API
 * Interface", v1.2.1): `getAddress`, `signTransaction`, `signAuthEntry`,
 * `signMessage` and `getNetwork`, each resolving to the documented result keys
 * with an optional `error` of `{ message, code, ext? }`, and the four documented
 * error codes:
 *
 *   -1 internal wallet error, -2 external service error,
 *   -3 invalid request, -4 user rejected the request.
 *
 * It is published on `window.freighterApi` as well as `window.veil`, because
 * `window.freighterApi` is what Stellar dApps probe today — the issue this
 * module exists for is that they find nothing there. Anything beyond the
 * standard is compatibility, not a new API: `isApproved`, `request`,
 * `getAddresses`, `getNetworkUrl` and an array-shaped `signAuthEntry` follow
 * Freighter's published surface, so a dApp written against either wallet lands on
 * documented behaviour. Deviations are deliberate, listed in
 * {@link UNSUPPORTED_MESSAGES}, and each returns a standard error rather than
 * inventing a result shape.
 *
 * Nothing in this module touches React Native, Expo or the signing pipeline. It
 * validates and serialises, which is what makes it testable without a WebView,
 * and it is the only place the message grammar is written down — the app side
 * (`lib/dappProviderBridge.ts`) and the injected side are generated from these
 * same constants.
 */

/** Envelope tag the page posts, and the tag the app matches before parsing. */
export const DAPP_PROVIDER_REQUEST_TYPE = 'veil:dapp-request';

/**
 * The single global the app calls to answer a request. One hook, one argument:
 * a JSON string, so nothing the page produced is ever evaluated as code.
 */
export const DAPP_PROVIDER_REPLY_HOOK = '__veilDappProviderReply';

/** Name the provider is installed under, for the standard Freighter discovery path. */
export const FREIGHTER_PROVIDER_GLOBAL = 'freighterApi';

/** Name the provider is installed under, for the wallet's own name. */
export const VEIL_PROVIDER_GLOBAL = 'veil';

/**
 * How long the page waits for Veil before giving up on a request. Signing needs
 * an approval tap and a passkey ceremony, so this is generous: a hung promise is
 * worse for the dApp than a slow answer, and a request the user never sees is
 * answered by the browser's own lifecycle, not by this timer.
 */
export const DAPP_PROVIDER_TIMEOUT_MS = 600_000;

/** The provider version dApps read. It describes this interface, not the app. */
export const DAPP_PROVIDER_VERSION = '1.0.0';

/** The SEP-43 error codes, named so no call site writes a bare negative number. */
export const SEP43_ERROR = {
  /** Something failed inside Veil. */
  internal: -1,
  /** Horizon or Soroban RPC returned an error. */
  externalService: -2,
  /** The dApp's request was not valid, and retrying it will not help. */
  invalidRequest: -3,
  /** The user said no. The dApp must not retry. */
  userRejected: -4,
} as const;

export type Sep43ErrorCode = (typeof SEP43_ERROR)[keyof typeof SEP43_ERROR];

/** The `error` half of every SEP-43 response. */
export type ProviderError = { message: string; code: Sep43ErrorCode; ext?: string[] };

/** The result keys any method may carry. A reply is built from this shape only. */
export type ProviderResult = {
  address?: string;
  addresses?: string[];
  network?: string;
  networkPassphrase?: string;
  signedTxXdr?: string;
  signedAuthEntry?: string;
  signedAuthEntries?: string[];
  signerAddress?: string;
  approved?: boolean;
};

/**
 * What a call resolves to: the result keys for the method, plus `error` when it
 * failed. SEP-43 describes a response as the result object with an optional
 * `error` member, so both halves live on one shape and a caller can read either.
 */
export type ProviderResponse = ProviderResult & { error?: ProviderError };

// ── Methods ───────────────────────────────────────────────────────────────────

/**
 * Every method the page may ask for. A request naming anything else is dropped
 * by {@link parseProviderRequest} before it reaches any wallet logic, so this
 * list is the whole attack surface the page has on the app side.
 *
 * `getNetwork` is the standard's way for a dApp to confirm it is building for the
 * right chain. Freighter's extras are here because dApps call them
 * (`isApproved`, `request`, `getAddresses`); `getNetworkUrl` is deliberately
 * absent, since a page that needs an RPC endpoint can get it from the network
 * name, and Veil is not in the business of handing out infrastructure URLs.
 */
export const PROVIDER_METHODS = [
  'getAddress',
  'getAddresses',
  'getNetwork',
  'isApproved',
  'request',
  'signTransaction',
  'signAuthEntry',
  'signMessage',
] as const;

export type ProviderMethod = (typeof PROVIDER_METHODS)[number];

const PROVIDER_METHOD_SET: ReadonlySet<string> = new Set<string>(PROVIDER_METHODS);

/** The methods that ask for a signature, and therefore for an explicit approval. */
export const SIGNING_METHODS: readonly ProviderMethod[] = ['signTransaction', 'signAuthEntry'];

/**
 * Requests the interface defines but Veil does not serve, with the message the
 * dApp gets back. Each one is a scope decision, not a bug: naming them here
 * keeps them from being discovered as silent behaviour later.
 */
export const UNSUPPORTED_MESSAGES: Partial<Record<ProviderMethod, string>> = {
  // Veil's off-chain message signature (SDK `signMessage`) embeds the passkey
  // credential id in its payload, and the credential id must never reach a page.
  signMessage:
    'signMessage is not available in Veil. Use signAuthEntry for Soroban authorization.',
};

// ── Requests ──────────────────────────────────────────────────────────────────

/** Options an SEP-43 caller may pass alongside a payload. Only these are read. */
export type ProviderCallOptions = {
  networkPassphrase?: string;
  address?: string;
  submit?: boolean;
  submitUrl?: string;
};

/** A validated request from the page. */
export type ProviderRequest = {
  /** Page-assigned id, echoed back so the page can settle the right promise. */
  id: string;
  method: ProviderMethod;
  /** The XDR the method was handed, when it takes one. */
  xdr: string | null;
  /** The extra XDRs of a Freighter-style array `signAuthEntry` call. */
  xdrList: string[] | null;
  /** Which reply shape the page expects for an array call. */
  wantsList: boolean;
  /** The whitelisted subset of the caller's options. */
  opts: ProviderCallOptions;
};

/** Largest envelope the app will parse. A real Soroban transaction is far below it. */
export const MAX_PROVIDER_MESSAGE_CHARS = 2_000_000;

/** Largest single XDR payload accepted, in characters of base64. */
export const MAX_PROVIDER_XDR_CHARS = 1_000_000;

/**
 * How many auth entries one `signAuthEntry` call may ask for.
 *
 * Each entry is a separate signature and a separate passkey assertion, so a large
 * batch is a wall of prompts rather than one request — and a request the user
 * cannot read through is one they should not be asked to approve.
 */
export const MAX_AUTH_ENTRIES_PER_REQUEST = 10;

/** Request ids are page-generated; anything longer or odd-shaped is not one. */
const REQUEST_ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;

/** Base64 only — malformed payloads are refused here rather than at the RPC. */
const XDR_BASE64_PATTERN = /^[A-Za-z0-9+/=]+$/;

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** One XDR string from the page, or null when it is not a usable payload. */
function readXdr(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (!trimmed || trimmed.length > MAX_PROVIDER_XDR_CHARS) return null;
  if (!XDR_BASE64_PATTERN.test(trimmed)) return null;
  return trimmed;
}

/**
 * The caller's options, reduced to the four SEP-43 defines.
 *
 * Everything else on the object is dropped rather than passed on: a page can put
 * anything here, and the signing path must never read a field the interface does
 * not publish. Both shapes are accepted, because wallets in the wild hand the
 * options as a second argument and dApps hand them merged into the payload.
 */
function readOptions(...values: unknown[]): ProviderCallOptions {
  const opts: ProviderCallOptions = {};
  for (const value of values) {
    if (!isPlainObject(value)) continue;
    if (!opts.networkPassphrase && typeof value.networkPassphrase === 'string' && value.networkPassphrase.length <= 128) {
      opts.networkPassphrase = value.networkPassphrase;
    }
    if (!opts.address && typeof value.address === 'string' && value.address.length <= 64) {
      opts.address = value.address;
    }
    if (opts.submit === undefined && typeof value.submit === 'boolean') opts.submit = value.submit;
    if (!opts.submitUrl && typeof value.submitUrl === 'string' && value.submitUrl.length <= 512) {
      opts.submitUrl = value.submitUrl;
    }
  }
  return opts;
}

/**
 * Parse one message from the page into a request, or `null` when it is not one.
 *
 * Returning `null` means "ignore this message" — no response is sent, because
 * there is no trustworthy id to answer. It is deliberately strict about the
 * envelope and deliberately uninterested in the payload's *contents*: whether the
 * XDR is a valid transaction, whether it is for this network, whether it asks
 * for something sane is the bridge's job, after it has checked the origin.
 */
export function parseProviderRequest(data: unknown): ProviderRequest | null {
  if (typeof data !== 'string') return null;
  if (!data || data.length > MAX_PROVIDER_MESSAGE_CHARS) return null;

  let parsed: unknown;
  try {
    parsed = JSON.parse(data);
  } catch {
    return null;
  }
  if (!isPlainObject(parsed)) return null;
  if (parsed.type !== DAPP_PROVIDER_REQUEST_TYPE) return null;

  const { id, method } = parsed;
  if (typeof id !== 'string' || !REQUEST_ID_PATTERN.test(id)) return null;
  if (typeof method !== 'string' || !PROVIDER_METHOD_SET.has(method)) return null;

  // `params` is optional — getAddress and getNetwork take nothing — and anything
  // that is not an object is read as absent rather than rejected: the method
  // still gets answered, and it fails on its own missing payload.
  const args: Record<string, unknown> = isPlainObject(parsed.params) ? parsed.params : {};

  const wantsList = Array.isArray(args.authEntries) || Array.isArray(args.xdrList);
  let xdr: string | null = null;
  let xdrList: string[] | null = null;

  if (wantsList) {
    const raw = (Array.isArray(args.authEntries) ? args.authEntries : args.xdrList) as unknown[];
    // One bad entry, or a batch too large to read entry by entry, fails the whole
    // request. A signature the user cannot describe is not one to put in front
    // of them, and a truncated list would sign some entries and not others.
    if (!raw.length || raw.length > MAX_AUTH_ENTRIES_PER_REQUEST) return null;
    const entries = raw.map(readXdr);
    if (entries.some((entry) => entry === null)) return null;
    xdrList = entries as string[];
    xdr = xdrList[0] ?? null;
  } else if (args.xdr !== undefined || args.authEntry !== undefined) {
    xdr = readXdr(args.xdr ?? args.authEntry);
    if (xdr === null) return null;
  }

  return {
    id,
    method: method as ProviderMethod,
    xdr,
    xdrList,
    wantsList,
    opts: readOptions(args.opts, args.options, args),
  };
}

// ── Responses ─────────────────────────────────────────────────────────────────

/** The `{ error }` half of a response. SEP-43 wants a readable message, so `ext` stays short. */
export function errorResponse(code: Sep43ErrorCode, message: string, ext?: string[]): ProviderResponse {
  const clean = (message ?? '').trim() || 'The request could not be completed.';
  const error: ProviderError = { message: clean.slice(0, 500), code };
  if (ext && ext.length) error.ext = ext.slice(0, 5).map((entry) => String(entry).slice(0, 200));
  return { error };
}

/**
 * The answer for a method the interface names and Veil does not serve, or `null`
 * when the method is served. `null` rather than a sentinel string so a call site
 * cannot mistake "supported" for "answered with an empty message".
 */
export function unsupportedResponse(method: ProviderMethod): ProviderResponse | null {
  const message = UNSUPPORTED_MESSAGES[method];
  if (!message) return null;
  return errorResponse(SEP43_ERROR.invalidRequest, message);
}

/**
 * Serialize one reply for {@link DAPP_PROVIDER_REPLY_HOOK}.
 *
 * The payload goes out as a JSON string inside a JS string literal, which is the
 * only way a value can be handed to the page without the page's own runtime
 * parsing it as code. `U+2028`/`U+2029` are escaped because they are legal in
 * JSON and were only made legal in JS string literals in ES2019 — an older
 * Android WebView would otherwise break on a signed message that contains one.
 */
export function serializeProviderReply(id: string, response: ProviderResponse): string {
  const payload = JSON.stringify({ id, response });
  // Replaced with the escape SEQUENCE rather than the character itself. The
  // payload is JSON, and inside a JSON string \u2028 means exactly what a raw
  // line separator means — but only the sequence survives being embedded in a JS
  // string literal on every WebView: a raw separator is legal JSON and was
  // illegal in a string literal until ES2019, which older Android shells obey.
  const escaped = payload
    .split('\u2028')
    .join('\\u2028')
    .split('\u2029')
    .join('\\u2029')
    .split('<')
    .join('\\u003c');
  return `window.${DAPP_PROVIDER_REPLY_HOOK} && window.${DAPP_PROVIDER_REPLY_HOOK}(${JSON.stringify(escaped)});`;
}

// ── The injected script ───────────────────────────────────────────────────────

/**
 * The page half of the bridge.
 *
 * It installs the provider once, in the top frame only, and only when the
 * document it runs in is the origin Veil approved. That check is not the
 * security gate — the app re-checks the origin of every message — it is there so
 * a provider never appears on the WebView's blank start-up document, where no
 * dApp is loaded and a `null` origin page has no business holding a wallet.
 *
 * Every method does the same three things: build a request id, post it, and
 * resolve when Veil calls the reply hook. There is no path from the page to a
 * key, a secret or a credential id, because this script holds none: it has
 * nothing to leak even if the page reads it back.
 */
export function dappProviderScript(approvedOrigin: string): string {
  const origin = JSON.stringify(approvedOrigin);
  const requestType = JSON.stringify(DAPP_PROVIDER_REQUEST_TYPE);
  const replyHook = DAPP_PROVIDER_REPLY_HOOK;
  const timeoutMs = DAPP_PROVIDER_TIMEOUT_MS;

  return `
(function () {
  try {
    if (window.top !== window) return;
    if (window.__veilDappProviderInstalled) return;
    if (window.location.origin !== ${origin}) return;
    window.__veilDappProviderInstalled = true;

    var pending = {};
    var seq = 0;

    function nextId() {
      seq += 1;
      return 'r' + seq + '-' + String(Date.now());
    }

    function send(method, params) {
      return new Promise(function (resolve, reject) {
        var id = nextId();
        var settled = false;
        function finish(payload) {
          if (settled) return;
          settled = true;
          delete pending[id];
          // An error rejects rather than resolves. Every dApp that finds this
          // object wraps the call in try/catch and reads a resolved value as a
          // success, so handing back an error object as if it were a signature
          // would let a refused request look like an approved one.
          if (payload && payload.error) reject(payload);
          else resolve(payload);
        }
        pending[id] = finish;
        window.setTimeout(function () {
          finish({
            error: {
              code: -1,
              message: 'Veil did not answer this request. It may have been left open too long.'
            }
          });
        }, ${timeoutMs});
        try {
          if (!window.ReactNativeWebView || !window.ReactNativeWebView.postMessage) {
            finish({ error: { code: -1, message: 'Veil is not available in this window.' } });
            return;
          }
          window.ReactNativeWebView.postMessage(
            JSON.stringify({ type: ${requestType}, id: id, method: method, params: params })
          );
        } catch (e) {
          finish({ error: { code: -1, message: 'Veil could not read this request.' } });
        }
      });
    }

    window.${replyHook} = function (raw) {
      try {
        var envelope = JSON.parse(raw);
        var finish = pending[envelope.id];
        if (!finish) return;
        finish(envelope.response || { error: { code: -1, message: 'Empty response.' } });
      } catch (e) {}
    };

    function firstArgument(a, b) {
      return a === undefined || a === null ? b : a;
    }

    function payloadOf(value) {
      if (typeof value === 'string') return { xdr: value };
      if (Array.isArray(value)) return { authEntries: value.slice() };
      if (value && typeof value === 'object') return value;
      return {};
    }

    function optionsOf(value) {
      if (value && typeof value === 'object' && !Array.isArray(value)) return { opts: value };
      return {};
    }

    // request is Freighter's dispatcher, and a dApp that uses it asks for one
    // of these by name. Anything else it passes is treated as the connect
    // gesture, which is what an unknown method means in that interface.
    var FORWARDED_REQUESTS = ['isApproved', 'getAddress', 'getAddresses', 'getNetwork'];

    function requestedMethod(options) {
      return options && typeof options.method === 'string' ? options.method : '';
    }

    var provider = {
      version: '${DAPP_PROVIDER_VERSION}',

      isApproved: function () {
        return send('isApproved', {});
      },

      request: function (options) {
        var method = requestedMethod(options);
        for (var i = 0; i < FORWARDED_REQUESTS.length; i++) {
          if (FORWARDED_REQUESTS[i] === method) return send(method, optionsOf(options));
        }
        return send('request', {});
      },

      // Freighter's connect(): truthy once the user has allowed this site to
      // read the address. The address itself comes from getAddress, which asks
      // the same permission and finds it already given.
      connect: function () {
        return send('request', {});
      },

      getAddress: function (options) {
        return send('getAddress', optionsOf(options));
      },

      getAddresses: function (options) {
        return send('getAddresses', optionsOf(options));
      },

      getNetwork: function () {
        return send('getNetwork', {});
      },

      signTransaction: function (xdr, options) {
        return send('signTransaction', Object.assign(payloadOf(firstArgument(xdr, '')), optionsOf(options)));
      },

      signAuthEntry: function (authEntry, options) {
        return send('signAuthEntry', Object.assign(payloadOf(firstArgument(authEntry, '')), optionsOf(options)));
      },

      signMessage: function (message, options) {
        // Sent as the message field, not as xdr: Veil answers this method with a
        // standard "not available" error, and an arbitrary string must not be
        // dropped by XDR validation before it can hear that.
        var params = typeof message === 'string' ? { message: message } : payloadOf(message);
        return send('signMessage', Object.assign(params, optionsOf(options)));
      }
    };

    // Both names on purpose: SEP-43 is the interface, window.${FREIGHTER_PROVIDER_GLOBAL} is
    // where the dApps already look for it.
    try {
      Object.defineProperty(window, '${FREIGHTER_PROVIDER_GLOBAL}', {
        value: provider,
        configurable: false,
        writable: false,
      });
    } catch (e) {
      window.${FREIGHTER_PROVIDER_GLOBAL} = provider;
    }
    try {
      Object.defineProperty(window, '${VEIL_PROVIDER_GLOBAL}', {
        value: provider,
        configurable: false,
        writable: false,
      });
    } catch (e) {
      window.${VEIL_PROVIDER_GLOBAL} = provider;
    }
  } catch (e) {}
})();
true;
`;
}
