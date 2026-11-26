/**
 * Veil names, from the phone.
 *
 * `register(buyer, name, years)` moves `price × years` of USDC from the buyer
 * to the Veil treasury and mints the name, in one transaction. No pending
 * state, no refund path. The buyer is the smart wallet, so the authorisation
 * runs through `__check_auth` and the passkey.
 *
 * ## The shape rules are duplicated, and checked against the contract
 *
 * `validateName` mirrors what `contracts/veil-names` enforces. It is here so a
 * typo is caught before a passkey prompt rather than after a reverted
 * transaction — but it is a convenience, never the authority. The contract
 * rejects what the contract rejects, which is why a purchase that fails is
 * reported with the contract's own reason and not this file's opinion.
 *
 * Pricing is asked of the chain for the same reason: `pricePerYear` is here to
 * price a name as it is typed, and `quoteFromChain` is what is shown at the
 * moment of payment, because the contract is what takes the money.
 */

import { nativeToScVal, xdr } from '@stellar/stellar-sdk';

import { invokeAsWallet, simulateRead } from './contractInvoke';
import { namesContractId, usdcContractId } from './veilIans';

export const SUFFIX = '*useveilapp.xyz';
export const MIN_NAME_LENGTH = 3;
export const MAX_NAME_LENGTH = 20;
export const MIN_TERM_YEARS = 1;
export const MAX_TERM_YEARS = 5;

/**
 * Price per year by length band, in whole USDC.
 *
 * Non-monotonic on purpose: mid-length names cost the most, because they are
 * the ones people actually want. Mirrors `price_per_year` in the contract.
 */
export function pricePerYear(length: number): number {
  if (length <= 5) return 3;
  if (length <= 10) return 5;
  return 2;
}

export function totalUsdc(length: number, years: number): number {
  return pricePerYear(length) * years;
}

export function clampTerm(years: number): number {
  if (!Number.isFinite(years)) return MIN_TERM_YEARS;
  return Math.min(MAX_TERM_YEARS, Math.max(MIN_TERM_YEARS, Math.round(years)));
}

/** Fold a typed name to its canonical form. Case is not part of a name. */
export function normalizeName(input: string): string {
  return input.trim().toLowerCase();
}

export const VALIDATION_MESSAGES = {
  short: `Names need at least ${MIN_NAME_LENGTH} characters.`,
  long: `Names can be up to ${MAX_NAME_LENGTH} characters.`,
  invalid: 'Use lowercase letters, numbers and underscores only.',
  separator: 'Underscores cannot start or end a name, or sit next to each other.',
} as const;

export type ValidationProblem = keyof typeof VALIDATION_MESSAGES;

/**
 * The problem with a typed name, or null if the shape is fine.
 *
 * Shape only — it says nothing about whether the name is taken, which needs
 * the registry. An empty field is not a problem, it is an empty field.
 */
export function validateName(input: string): ValidationProblem | null {
  const name = normalizeName(input);
  if (name.length === 0) return null;
  if (name.length < MIN_NAME_LENGTH) return 'short';
  if (name.length > MAX_NAME_LENGTH) return 'long';
  if (!/^[a-z0-9_]+$/.test(name)) return 'invalid';
  if (name.startsWith('_') || name.endsWith('_') || name.includes('__')) return 'separator';
  return null;
}

/**
 * What the registry says about a name.
 *
 * `unknown` is the one that matters: when the lookup cannot be made this is
 * what comes back, never `available`. Telling somebody a name is free when
 * nothing can grant it to them is how a person pays for nothing.
 */
export type NameState = 'available' | 'taken' | 'yours' | 'in_recovery' | 'unknown';

const str = (v: string): xdr.ScVal => nativeToScVal(v, { type: 'string' });
const u32 = (v: number): xdr.ScVal => nativeToScVal(v, { type: 'u32' });
const addr = (a: string): xdr.ScVal => nativeToScVal(a, { type: 'address' });

/**
 * Ask the registry what it thinks of a name.
 *
 * `NameState` is a `#[contracttype]` enum with explicit discriminants, so it
 * arrives as the NUMBER 0, 1 or 2 — not the variant's name. Decoding it as a
 * string makes every name read `unknown`, which is a silent failure: the field
 * never says a name is taken and never says one is free, so nothing can be
 * bought and nothing explains why.
 *
 * `walletAddress` distinguishes a name this wallet already holds from one
 * somebody else does, which the registry does not answer in one call.
 */
export async function nameState(name: string, walletAddress?: string): Promise<NameState> {
  const id = namesContractId();
  if (!id) return 'unknown';

  const value = await simulateRead(id, 'state', [str(name)]);
  const code = typeof value === 'bigint' ? Number(value) : value;
  if (typeof code !== 'number') return 'unknown';

  // 0 Active, 1 Recovery, 2 Open.
  if (code === 2) return 'available';
  if (code === 1) return 'in_recovery';
  if (code !== 0) return 'unknown';

  if (!walletAddress) return 'taken';
  const holder = await simulateRead(id, 'resolve', [str(name)]);
  return holder === walletAddress ? 'yours' : 'taken';
}

/**
 * What the registry itself says a registration costs, in USDC stroops.
 *
 * Null means it could not be asked — which is NOT free, and NOT the local
 * estimate. The caller shows the local price as an estimate and this one as
 * the charge.
 */
export async function quoteFromChain(name: string, years: number): Promise<bigint | null> {
  const id = namesContractId();
  if (!id) return null;
  const value = await simulateRead(id, 'quote', [str(name), u32(years)]);
  return typeof value === 'bigint' ? value : null;
}

/** USDC held by an address, in stroops. Null when it cannot be read. */
export async function usdcBalance(address: string): Promise<bigint | null> {
  const value = await simulateRead(usdcContractId(), 'balance', [addr(address)]);
  return typeof value === 'bigint' ? value : null;
}

/** Buy a name. Prompts the passkey. Resolves with the transaction hash. */
export async function registerName(
  walletAddress: string,
  name: string,
  years: number,
): Promise<string> {
  const id = namesContractId();
  if (!id) throw new Error('Veil names are not available on this network.');
  return invokeAsWallet(id, 'register', [addr(walletAddress), str(name), u32(years)]);
}

/**
 * The registry's own error codes.
 *
 * Only consulted when the failure can be attributed to the registry. A
 * `register` runs code in three contracts that all number their errors from 1:
 * the USDC SAC's `BalanceError` is 10 and `TrustlineMissingError` is 13, which
 * collide exactly with `InRecovery` and `TermTooLong`. Mapping blindly is how
 * buyers were once told a free name was taken.
 */
const NAME_ERRORS: Record<number, string> = {
  3: 'That name is too short — names are at least 3 characters.',
  4: 'That name is too long — names are at most 20 characters.',
  5: 'Names can only use lowercase letters, digits and underscore.',
  6: 'An underscore cannot start or end a name, and cannot be doubled.',
  7: 'That name is reserved and cannot be registered.',
  8: 'A term must be between 1 and 5 years.',
  9: 'Somebody already holds that name.',
  10: 'That name has lapsed but is still in its 90-day recovery window, so only its previous holder can take it.',
  13: 'That renewal would push the term past the 5-year maximum.',
};

export function nameErrorMessage(err: unknown, registryId?: string): string | null {
  const text = err instanceof Error ? err.message : String(err ?? '');
  const match = /Error\(Contract, #(\d+)\)/.exec(text);
  if (!match) return null;

  const id = registryId ?? namesContractId();
  const contracts = text.match(/C[A-Z2-7]{55}/g);
  if (contracts && id && !contracts.includes(id)) return null;

  return NAME_ERRORS[Number(match[1])] ?? null;
}

/** Stroops as a human USDC string. */
export function formatUsdc(stroops: bigint): string {
  const whole = stroops / 10_000_000n;
  const frac = stroops % 10_000_000n;
  if (frac === 0n) return String(whole);
  return `${whole}.${frac.toString().padStart(7, '0').replace(/0+$/, '')}`;
}
