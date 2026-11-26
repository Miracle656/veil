import { StrKey } from '@stellar/stellar-sdk';

// Hostname with a TLD — mirrors the SDK's origin-domain check (sdk/src/sep7.ts).
const DOMAIN_RE = /^(?=.{1,253}$)(?:[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?\.)+[A-Za-z]{2,}$/;

/**
 * True for a valid on-chain Stellar destination — a G… account, an M… muxed
 * account, or a C… contract. Same rule as the SDK's `isValidDestination`
 * (`sdk/src/sep7.ts`), using StrKey checksum validation.
 */
export function isValidStellarAddress(value: string): boolean {
  return (
    StrKey.isValidEd25519PublicKey(value) ||
    StrKey.isValidMed25519PublicKey(value) ||
    StrKey.isValidContract(value)
  );
}

/**
 * True for a well-formed SEP-2 federated address `name*domain` — exactly one
 * `*`, a non-empty name, and a hostname-shaped domain (`frontend/wallet/lib/
 * federation.ts` splits on `*` and requires both halves). This is a format
 * check only; resolving it to an account needs the domain's federation server.
 */
export function isFederatedAddress(value: string): boolean {
  const parts = value.split('*');
  if (parts.length !== 2) return false;
  const [name, domain] = parts;
  if (!name || !domain) return false;
  return DOMAIN_RE.test(domain);
}

/** True for any recipient we accept: an on-chain address or a federated address. */
export function isValidDestination(value: string): boolean {
  const v = value.trim();
  if (!v) return false;
  return isValidStellarAddress(v) || isFederatedAddress(v);
}
