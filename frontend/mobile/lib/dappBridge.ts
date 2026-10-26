/**
 * The gate every dApp request passes through.
 *
 * A page in the dApp browser asks for things over and over — an address, then a
 * signature, then another signature — and it is not connected in any way the
 * user negotiated once. So authorisation is decided per call, against the live
 * grant store in `lib/permissions.ts`, and never cached by the bridge: if the
 * user revokes an origin from Settings while a page is open, that page's very
 * next request goes through {@link authorizeDappRequest} and finds nothing
 * granted, and prompts again.
 *
 * This module deliberately contains no signing logic. It checks a scope, and
 * then hands the payload to `signXdrPayload()` in `lib/walletConnect.ts` — the
 * one implementation of the `__check_auth` ceremony (host function, low-S
 * signature, expiration ledger, footprint from re-simulation, sequence, and the
 * 5-element signature vector). A second signing path is how a wallet ends up
 * with one that is subtly wrong, so nothing here builds or signs an XDR.
 */

import { errorMessage } from './errorMessage';
import { isPasskeyCancellation } from './passkeyOutcome';
import type { RequestDetails } from './transactionRequestDetails';
import {
  getPermissionGrantedAt,
  isOriginPermissionGranted,
  grantOriginPermissions,
  type PermissionScope,
} from './permissions';
import { createSep43Wallet, type Sep43Wallet } from 'invisible-wallet-sdk';
import { signXdrPayload, getMobileSep43Wallet } from './walletConnect';

/** Thrown when a request is refused — either the user declined the prompt, or no wallet is available. */
export class DappRequestRejected extends Error {
  constructor(message = 'USER_REJECTED') {
    super(message);
    this.name = 'DappRequestRejected';
  }
}

/** Why a request needs the user before it can proceed. */
export type PermissionRequest = {
  /** Normalised origin making the request. */
  origin: string;
  /** Scope the request needs. */
  scope: PermissionScope;
  /** Name the page gave itself, carried into the prompt. */
  name?: string;
  /**
   * When the scope was already granted, or null when it has never been.
   *
   * A prompt under `alwaysPrompt` is a repeat request for a scope the user has
   * granted, so this is what lets the sheet distinguish "this site may ask, and
   * it is asking again" from "this site is asking for the first time".
   */
  grantedAt: number | null;
  /**
   * What the user is actually being asked to approve, decoded.
   *
   * Supplied by a caller that has a payload to describe — a transaction, an auth
   * entry. It is optional because disclosure asks for no payload, and a prompt
   * that has nothing to show must still be able to ask honestly rather than
   * invent a description.
   */
  details?: RequestDetails;
};

/**
 * Show the approval prompt. Resolves true when the user allows the request.
 *
 * The UI supplies this, which is what lets a caller decide whether an approval
 * is remembered: return true here and the grant is persisted, return false and
 * nothing is stored, so the next call asks again.
 */
export type PermissionPrompt = (request: PermissionRequest) => Promise<boolean>;

export type AuthorizeOptions = {
  origin: string;
  scope: PermissionScope;
  /** Name the page reported, shown in the prompt. */
  name?: string;
  /** Presents the approval prompt. Not called when the scope is already granted. */
  prompt: PermissionPrompt;
  /**
   * Ask the user even when the scope is already granted.
   *
   * For a signature this is the difference between "this site may ask" and "this
   * site may sign", and the second is never true: a grant is a standing permission
   * to *reach the prompt*, not to bypass it. A cached address disclosure can live
   * with being answered once per session; a transaction cannot.
   */
  alwaysPrompt?: boolean;
  /** The decoded payload to show in the prompt, when there is one to show. */
  details?: RequestDetails;
};

export type DappAuthorization =
  | { status: 'granted'; grantedAt: number; prompted: false }
  | { status: 'granted'; grantedAt: number; prompted: true }
  | { status: 'rejected'; prompted: boolean };

/**
 * Decide whether an origin may exercise a scope right now, prompting if needed.
 *
 * The grant check is a synchronous read of the in-memory store — never the
 * persisted copy, never a value captured when the page loaded. That is the
 * whole reason revocation is immediate: there is no second copy to go stale.
 *
 * A granted scope returns without prompting, so a page that has permission does
 * not nag — unless `alwaysPrompt` is set, in which case the grant only says the
 * site may ask, and the user is asked every time. A scope that is missing
 * prompts, and the grant is only persisted after the user says yes.
 */
export async function authorizeDappRequest(options: AuthorizeOptions): Promise<DappAuthorization> {
  const { origin, scope, name, prompt, alwaysPrompt, details } = options;

  if (!alwaysPrompt && isOriginPermissionGranted(origin, scope)) {
    return { status: 'granted', grantedAt: getPermissionGrantedAt(origin, scope) ?? Date.now(), prompted: false };
  }

  // `grantedAt` tells the prompt whether this is a first ask or a repeat. Under
  // alwaysPrompt a signature request is a repeat by design, and the sheet should
  // say "you have allowed this site to ask" rather than describing it as new.
  const grantedAt = getPermissionGrantedAt(origin, scope);
  const approved = await prompt({
    origin,
    scope,
    name,
    grantedAt,
    ...(details ? { details } : {}),
  });
  if (!approved) {
    return { status: 'rejected', prompted: true };
  }

  const record = await grantOriginPermissions(origin, [scope], { name });
  const nowGrantedAt = record.grants.find((grant) => grant.scope === scope)?.grantedAt ?? Date.now();
  return { status: 'granted', grantedAt: nowGrantedAt, prompted: true };
}

/**
 * Run `action` for an origin, but only if the scope is granted — prompting the
 * first time and re-prompting after any revoke.
 *
 * @throws {DappRequestRejected} when the user declines.
 */
export async function withOriginPermission<T>(
  options: AuthorizeOptions,
  action: () => Promise<T>
): Promise<T> {
  const authorization = await authorizeDappRequest(options);
  if (authorization.status === 'rejected') {
    throw new DappRequestRejected();
  }
  return action();
}

/**
 * Reveal the wallet address to an origin, if it has permission.
 *
 * Disclosure is its own scope, so a site allowed to show the address still has
 * to ask before it can ask for a signature.
 *
 * @throws {DappRequestRejected} when the user declines or there is no wallet.
 */
export async function discloseAddressToOrigin(
  options: AuthorizeOptions,
  getAddress: () => Promise<string | null>
): Promise<string> {
  return withOriginPermission(options, async () => {
    const address = await getAddress();
    if (!address) {
      throw new DappRequestRejected(errorMessage('No wallet on this device yet.'));
    }
    return address;
  });
}

/**
 * Sign a dApp-supplied transaction for an origin, if it has signing permission.
 *
 * The permission check is the only thing this adds. Every step that makes the
 * signature valid on chain — the host function, the low-S signature, the
 * expiration ledger, the footprint recovered by re-simulation, the sequence and
 * the 5-element signature vector — stays in `signXdrPayload()`.
 *
 * @throws {DappRequestRejected} when the user declines.
 */
export async function signXdrForOrigin(
  options: AuthorizeOptions,
  xdrString: string
): Promise<string> {
  return withOriginPermission(options, async () => {
    try {
      return await signXdrPayload(xdrString);
    } catch (error: unknown) {
      // Dismissing the passkey sheet is declining, so it has to reach the page
      // as a rejection rather than as a failure — which is what the @throws
      // above promises. The ceremony reports a cancellation; translating it
      // here keeps that distinction inside the wallet and gives the page the
      // one error shape it understands.
      if (isPasskeyCancellation(error)) throw new DappRequestRejected();
      throw error;
    }
  });
}

/**
 * Creates a SEP-43 standard wallet interface bound to an origin, gating calls
 * through the origin's permissions in permissions.ts.
 */
export function createOriginSep43Wallet(options: {
  origin: string;
  name?: string;
  prompt: PermissionPrompt;
}) {
  const baseWallet = getMobileSep43Wallet();
  return createSep43Wallet({
    getAddress: async () => {
      return withOriginPermission(
        { origin: options.origin, scope: 'address_disclosure', name: options.name, prompt: options.prompt },
        async () => {
          const res = await baseWallet.getAddress();
          if (res.error) throw new Error(res.error.message);
          return res.address ?? null;
        }
      );
    },
    getNetwork: async () => {
      const res = await baseWallet.getNetwork();
      if (res.error) throw new Error(res.error.message);
      return {
        network: res.network ?? 'TESTNET',
        networkPassphrase: res.networkPassphrase ?? 'Test SDF Network ; September 2015',
      };
    },
    signTransaction: async (xdrString, opts) => {
      return withOriginPermission(
        { origin: options.origin, scope: 'transaction_signing', name: options.name, prompt: options.prompt },
        async () => {
          const res = await baseWallet.signTransaction(xdrString, opts);
          if (res.error) throw new Error(res.error.message);
          return res.signedTxXdr ?? '';
        }
      );
    },
    signAuthEntry: async (authEntry, opts) => {
      return withOriginPermission(
        { origin: options.origin, scope: 'transaction_signing', name: options.name, prompt: options.prompt },
        async () => {
          const res = await baseWallet.signAuthEntry(authEntry, opts);
          if (res.error) throw new Error(res.error.message);
          return res.signedAuthEntry ?? '';
        }
      );
    },
    signMessage: async (message, opts) => {
      return withOriginPermission(
        { origin: options.origin, scope: 'transaction_signing', name: options.name, prompt: options.prompt },
        async () => {
          const res = await baseWallet.signMessage(message, opts);
          if (res.error) throw new Error(res.error.message);
          return res.signedMessage ?? '';
        }
      );
    },
  });
}
