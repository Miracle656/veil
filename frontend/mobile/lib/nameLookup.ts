/**
 * Looking a `name*domain` recipient up BEFORE the user commits to sending.
 *
 * The send screen used to resolve a name only inside submit. It worked, but
 * nothing on screen ever said where `jack*useveilapp.xyz` pointed: the field
 * showed the name, the passkey prompt appeared, the money left. A name is a
 * lookup someone else answers, so the account it currently points at is the
 * thing the sender is actually approving and has to be visible.
 */

import { isFederatedAddress } from './address';
import { resolveFederation } from './federation';

export type NameLookup =
  | { status: 'idle' }
  | { status: 'resolving'; name: string }
  | { status: 'resolved'; name: string; accountId: string }
  /** The name server answered: nobody holds this name. */
  | { status: 'not-found'; name: string }
  /** No answer. Says nothing about whether the name exists. */
  | { status: 'unreachable'; name: string };

export const IDLE: NameLookup = { status: 'idle' };

/** True when `value` is something to look up rather than an address. */
export function isLookupCandidate(value: string): boolean {
  return isFederatedAddress(value.trim());
}

/** Never throws: every outcome is a state the screen renders. */
export async function lookupName(
  value: string,
  resolve: typeof resolveFederation = resolveFederation,
): Promise<NameLookup> {
  const name = value.trim();
  if (!isFederatedAddress(name)) return IDLE;
  try {
    const record = await resolve(name);
    return { status: 'resolved', name, accountId: record.account_id };
  } catch (err) {
    const notFound = err instanceof Error && err.message === 'address not found';
    return { status: notFound ? 'not-found' : 'unreachable', name };
  }
}
