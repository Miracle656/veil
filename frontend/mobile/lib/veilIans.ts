/**
 * Buying a Veil-ian from the phone.
 *
 * `buy(buyer, token_id)` moves 5 USDC from the buyer to the Veil treasury and
 * mints that figure, in one transaction. The buyer is the smart wallet, so the
 * authorisation runs through `__check_auth` and the passkey — the same ceremony
 * a transfer uses, which is why it is in `./contractInvoke` rather than here.
 *
 * ## Two things must be true before the money moves
 *
 * The figure must be unsold, and the buyer must already hold a Veil name. Both
 * are read from the chain before a purchase is offered, rather than inferred
 * from the failure afterwards — a `buy` runs code in three contracts that all
 * number their errors from 1, so the failure cannot be trusted to mean what it
 * appears to say. See {@link veilIanErrorMessage}.
 */

import { nativeToScVal, xdr } from '@stellar/stellar-sdk';

import { invokeAsWallet, simulateRead } from './contractInvoke';
import { getNetwork } from './network';
import { COLLECTION_SIZE, FIGURE_PRICE_STROOPS } from './veilIansFigures';

/** The Veil-ians collection, per network. "" when there is none. */
export function collectionContractId(): string {
  const net = getNetwork();
  if (net.name !== 'mainnet') {
    return process.env['EXPO_PUBLIC_VEILIANS_CONTRACT_ID_TESTNET']?.trim() ?? '';
  }
  return (
    process.env['EXPO_PUBLIC_VEILIANS_CONTRACT_ID_MAINNET']?.trim() ||
    // Deployed 2026-11-10; wasm e7980246… matches the reproducible build.
    'CA5TXFITGGMG6HG6FJIHWOTXSZ43EIR4F5UCTAAY5FJWB5FWBG5Z3WPN'
  );
}

/** The Veil Names registry, which answers the gate. "" when there is none. */
export function namesContractId(): string {
  const net = getNetwork();
  if (net.name !== 'mainnet') {
    return process.env['EXPO_PUBLIC_NAMES_CONTRACT_ID_TESTNET']?.trim() ?? '';
  }
  return (
    process.env['EXPO_PUBLIC_NAMES_CONTRACT_ID_MAINNET']?.trim() ||
    'CA7BWBV2L67YVIZWJKLYT3RRCTFCZPN6L5SXYQ4YELWP56E34JFNOEP4'
  );
}

/** The USDC Stellar Asset Contract, per network. */
export function usdcContractId(): string {
  const net = getNetwork();
  return net.name === 'mainnet'
    ? process.env['EXPO_PUBLIC_USDC_SAC_MAINNET']?.trim() ||
        // Issuer GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN.
        'CCW67TSZV3SSS2HXMBQ5JFGCKJNXKZM7UQUWUZPUTHXSTZLEO7SJMI75'
    : process.env['EXPO_PUBLIC_USDC_SAC_TESTNET']?.trim() ||
        'CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA';
}

const addr = (a: string): xdr.ScVal => nativeToScVal(a, { type: 'address' });

/**
 * Which figures have already been sold.
 *
 * One call for all twenty. Twenty separate `is_sold` reads would be twenty
 * answers from twenty different moments, and the gap is long enough to offer
 * something that has just gone.
 *
 * **Null is "could not read", not "nothing is sold."** A shop that collapses
 * those takes an order it cannot fill.
 */
export async function soldFigures(): Promise<number[] | null> {
  const id = collectionContractId();
  if (!id) return null;
  const value = await simulateRead(id, 'sold', []);
  if (!Array.isArray(value)) return null;
  return value
    .map(Number)
    .filter((n) => Number.isInteger(n) && n >= 1 && n <= COLLECTION_SIZE);
}

/**
 * Does this address hold a Veil name?
 *
 * Null means the registry could not be reached — never render that as "you
 * need a name", which would send a name-holder off to buy a second one.
 */
export async function holdsAName(address: string): Promise<boolean | null> {
  const id = namesContractId();
  if (!id) return null;
  const value = await simulateRead(id, 'balance', [addr(address)]);
  if (typeof value === 'bigint') return value > 0n;
  if (typeof value === 'number') return value > 0;
  return null;
}

/** USDC held by an address, in stroops. Null when it cannot be read. */
export async function usdcBalance(address: string): Promise<bigint | null> {
  const value = await simulateRead(usdcContractId(), 'balance', [addr(address)]);
  return typeof value === 'bigint' ? value : null;
}

/** What the contract itself says a figure costs, in stroops. */
export async function priceFromChain(): Promise<bigint | null> {
  const id = collectionContractId();
  if (!id) return null;
  const value = await simulateRead(id, 'price', []);
  return typeof value === 'bigint' ? value : null;
}

/** How many figures this address holds. Null when it cannot be read. */
export async function figuresHeld(address: string): Promise<number | null> {
  const id = collectionContractId();
  if (!id) return null;
  const value = await simulateRead(id, 'balance', [addr(address)]);
  if (typeof value === 'bigint') return Number(value);
  if (typeof value === 'number') return value;
  return null;
}

/** Everything the shop needs about one wallet, read together. */
export type BuyerState = {
  /** Null when the registry could not be reached. */
  hasName: boolean | null;
  /** USDC in the smart wallet, in stroops. Null when unreadable. */
  balanceStroops: bigint | null;
  held: number | null;
  priceStroops: bigint;
  /** True only when the balance was READ and is short. */
  short: boolean;
};

export async function readBuyerState(walletAddress: string): Promise<BuyerState> {
  const [hasName, balance, held, price] = await Promise.all([
    holdsAName(walletAddress),
    usdcBalance(walletAddress),
    figuresHeld(walletAddress),
    priceFromChain(),
  ]);
  const priceStroops = price ?? FIGURE_PRICE_STROOPS;
  return {
    hasName,
    balanceStroops: balance,
    held,
    priceStroops,
    // Unreadable is not short. Saying "not enough USDC" to a funded wallet
    // because an RPC call failed sends someone to top up an account that is
    // already full; the web wallet shipped that bug once.
    short: balance !== null && balance < priceStroops,
  };
}

/** Buy a figure. Prompts the passkey. Resolves with the transaction hash. */
export async function buyFigure(walletAddress: string, tokenId: number): Promise<string> {
  const id = collectionContractId();
  if (!id) throw new Error('The Veil-ians collection is not available on this network.');
  return invokeAsWallet(id, 'buy', [addr(walletAddress), nativeToScVal(tokenId, { type: 'u32' })]);
}

/** Stroops as a human USDC string, e.g. 50000000n -> "5". */
export function formatUsdc(stroops: bigint): string {
  const whole = stroops / 10_000_000n;
  const frac = stroops % 10_000_000n;
  if (frac === 0n) return String(whole);
  return `${whole}.${frac.toString().padStart(7, '0').replace(/0+$/, '')}`;
}

/** The collection's own error codes. Never applied without checking the source. */
const VEILIAN_ERRORS: Record<number, string> = {
  1: 'The collection is already set up.',
  2: 'The collection has not been set up yet.',
  3: 'There is no such figure — the collection is numbered 1 to 20.',
  4: 'Somebody already bought that figure.',
  5: 'You need a Veil name before you can buy a figure.',
};

/**
 * Turn a thrown Soroban error into something a buyer can act on.
 *
 * Returns null when the code cannot be attributed to the collection, which
 * leaves the caller showing the real failure instead of a confident wrong
 * explanation. The USDC SAC's `BalanceError` is 10 and the wallet's
 * `OriginMismatch` is 9; mapping those blindly is how the names flow once told
 * buyers a free name was taken.
 */
export function veilIanErrorMessage(err: unknown, collectionId?: string): string | null {
  const text = err instanceof Error ? err.message : String(err ?? '');
  const match = /Error\(Contract, #(\d+)\)/.exec(text);
  if (!match) return null;

  const id = collectionId ?? collectionContractId();
  const contracts = text.match(/C[A-Z2-7]{55}/g);
  if (contracts && id && !contracts.includes(id)) return null;

  return VEILIAN_ERRORS[Number(match[1])] ?? null;
}
