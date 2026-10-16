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
import {
  getPermissionGrantedAt,
  isOriginPermissionGranted,
  grantOriginPermissions,
  type PermissionScope,
} from './permissions';
import { signXdrPayload } from './walletConnect';

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
  /** When the scope was granted, or null when it is being asked for fresh. */
  grantedAt: number | null;
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
 * not nag. A scope that is missing prompts, and the grant is only persisted
 * after the user says yes.
 */
export async function authorizeDappRequest(options: AuthorizeOptions): Promise<DappAuthorization> {
  const { origin, scope, name, prompt } = options;

  if (isOriginPermissionGranted(origin, scope)) {
    return { status: 'granted', grantedAt: getPermissionGrantedAt(origin, scope) ?? Date.now(), prompted: false };
  }

  const approved = await prompt({ origin, scope, name, grantedAt: null });
  if (!approved) {
    return { status: 'rejected', prompted: true };
  }

  const record = await grantOriginPermissions(origin, [scope], { name });
  const grantedAt = record.grants.find((grant) => grant.scope === scope)?.grantedAt ?? Date.now();
  return { status: 'granted', grantedAt, prompted: true };
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
  return withOriginPermission(options, () => signXdrPayload(xdrString));
}
