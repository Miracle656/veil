/**
 * Offramp client — USDC on Stellar to a Nigerian bank account, via Linq.
 *
 * Every call goes through wraith, never to Linq directly. Linq's API key
 * creates orders that pay real naira to real bank accounts, so it cannot be in
 * this bundle: anything shipped in an app is extractable, and that key is not
 * read access, it is the ability to spend.
 *
 * A 503 from any of these means the backend has no offramp configured — which
 * is also what a sleeping instance looks like from here. Callers treat it as
 * "not available right now" and disable the entry point rather than failing
 * mid-flow.
 */

import AsyncStorage from '@react-native-async-storage/async-storage';

const BASE_URL = process.env['EXPO_PUBLIC_WRAITH_URL']?.replace(/\/+$/, '') ?? '';
/** Remembers whether the offramp answered last time, to avoid a layout jump. */
const AVAILABILITY_KEY = 'veil_offramp_available';
const TIMEOUT_MS = 20_000;

export class OfframpUnavailable extends Error {}

export interface OfframpRate {
  rate: number;
  currency: string;
  coin: string;
  /** Always true: the binding rate is the one locked into an order. */
  indicative: boolean;
}

export interface VerifiedBank {
  accountName: string;
  bankName: string;
  accountNumber: string;
  bankCode: string;
}

export interface OfframpOrder {
  id: string;
  /** Where the user must send USDC. Created with a trustline already in place. */
  walletAddress: string;
  coinType: string;
  chain: string;
  coin: string;
  amountStableCoin: number;
  amountNGN: number;
  rate: number;
  status: string;
  replayed?: boolean;
}

export interface OfframpStatus {
  id: string;
  status: string;
  amountStableCoin: number;
  amountNGN: number;
  depositAddress?: string;
  /** 'cache' means the backend could not reach Linq and served its own row. */
  source?: 'linq' | 'cache';
}

async function call<T>(path: string, init: { method?: string; body?: unknown } = {}): Promise<T> {
  if (!BASE_URL) throw new OfframpUnavailable('No backend configured for offramp.');
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(`${BASE_URL}${path}`, {
      method: init.method ?? 'GET',
      signal: controller.signal,
      headers: init.body ? { 'Content-Type': 'application/json' } : undefined,
      ...(init.body ? { body: JSON.stringify(init.body) } : {}),
    });
    const text = await res.text();
    const data = text ? JSON.parse(text) : {};
    if (res.status === 503) throw new OfframpUnavailable(data?.error ?? 'Offramp unavailable');
    if (!res.ok) throw new Error(data?.error ?? `Request failed (${res.status})`);
    return data as T;
  } catch (err) {
    if (err instanceof OfframpUnavailable) throw err;
    if ((err as Error)?.name === 'AbortError') {
      throw new OfframpUnavailable('The offramp service did not respond.');
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Whether the offramp can be offered at all.
 *
 * Used to gate the entry point: the backend holds the key, so if it is asleep
 * or unconfigured there is no order to create and the CTA should say so before
 * the user types an amount.
 */
export async function isOfframpAvailable(): Promise<boolean> {
  try {
    await call<OfframpRate>('/offramp/rate');
    void AsyncStorage.setItem(AVAILABILITY_KEY, '1');
    return true;
  } catch {
    void AsyncStorage.setItem(AVAILABILITY_KEY, '0');
    return false;
  }
}

/**
 * The last answer, for rendering before the probe returns.
 *
 * Starting from `false` every launch meant the Cash out tile was absent on
 * first paint and appeared a moment later — and since it is the only live
 * service, the whole "Pay for" card popped in and pushed the layout down.
 * Remembering the previous answer makes the common case (it worked last time)
 * render correctly straight away, and the live probe still corrects it.
 *
 * Optimism is bounded: this only ever repeats an answer we actually got, so a
 * first run still shows nothing rather than offering a flow that may not work.
 */
export async function lastKnownAvailability(): Promise<boolean> {
  try {
    return (await AsyncStorage.getItem(AVAILABILITY_KEY)) === '1';
  } catch {
    return false;
  }
}

export function getOfframpRate(): Promise<OfframpRate> {
  return call<OfframpRate>('/offramp/rate');
}

export function verifyBankAccount(bankCode: string, accountNumber: string): Promise<VerifiedBank> {
  return call<VerifiedBank>('/offramp/verify-bank', {
    method: 'POST',
    body: { bankCode, accountNumber },
  });
}

export function checkRefundAddress(address: string): Promise<{ valid: boolean; trustsUSDC: boolean }> {
  return call(`/offramp/trustline?address=${encodeURIComponent(address)}`);
}

export interface CreateOrderParams {
  amountNGN: number;
  bankAccount: string;
  bankCode: string;
  bankName: string;
  accountName: string;
  /** Classic G-address. A contract address is rejected — it cannot be refunded to. */
  refundAddress: string;
  walletAddress: string;
  idempotencyKey: string;
}

export function createOrder(params: CreateOrderParams): Promise<OfframpOrder> {
  return call<OfframpOrder>('/offramp/orders', { method: 'POST', body: params });
}

export function getOrderStatus(orderId: string): Promise<OfframpStatus> {
  return call<OfframpStatus>(`/offramp/orders/${encodeURIComponent(orderId)}`);
}

/**
 * The order currently in flight, so leaving the screen does not lose it.
 *
 * Sending the deposit means leaving this screen — the send flow is elsewhere —
 * and the order lived only in component state, so coming back produced a blank
 * form while real money was already on its way to Linq. The order id is enough
 * to recover everything: the backend holds the rest.
 */
const ACTIVE_ORDER_KEY = 'veil_offramp_active_order';

export async function rememberActiveOrder(orderId: string): Promise<void> {
  try {
    await AsyncStorage.setItem(ACTIVE_ORDER_KEY, orderId);
  } catch {
    // Losing the pointer is survivable — the order still settles server-side —
    // so this must never take the creation flow down with it.
  }
}

export async function activeOrderId(): Promise<string | null> {
  try {
    return await AsyncStorage.getItem(ACTIVE_ORDER_KEY);
  } catch {
    return null;
  }
}

export async function forgetActiveOrder(): Promise<void> {
  try {
    await AsyncStorage.removeItem(ACTIVE_ORDER_KEY);
  } catch {
    // ignore
  }
}

/**
 * Deposit addresses we have sent to, so the activity feed can name them.
 *
 * An offramp leaves the chain looking like any other USDC transfer to a
 * stranger's G-address — the naira leg happens entirely off-chain, so nothing
 * on Stellar records that this particular send became a bank payout. Without
 * this the one transfer type with a real-world counterpart is the least
 * legible thing in the feed.
 *
 * Addresses only, no amounts or bank details: enough to label a row, and
 * nothing that would turn the device into a record of who was paid.
 */
const DEPOSIT_ADDRESSES_KEY = 'veil_offramp_deposit_addresses';

export async function rememberDepositAddress(address: string): Promise<void> {
  try {
    const known = await knownDepositAddresses();
    if (known.includes(address)) return;
    // Bounded: a wallet that offramps often should not grow this forever, and
    // the oldest entries are the least likely to still be on screen.
    const next = [address, ...known].slice(0, 50);
    await AsyncStorage.setItem(DEPOSIT_ADDRESSES_KEY, JSON.stringify(next));
  } catch {
    // Labelling is a nicety; never let it fail an order.
  }
}

export async function knownDepositAddresses(): Promise<string[]> {
  try {
    const raw = await AsyncStorage.getItem(DEPOSIT_ADDRESSES_KEY);
    const parsed: unknown = raw ? JSON.parse(raw) : [];
    return Array.isArray(parsed) ? parsed.filter((a): a is string => typeof a === 'string') : [];
  } catch {
    return [];
  }
}

/** Terminal states, from Linq's own vocabulary. Anything else is still moving. */
export function isTerminal(status: string): boolean {
  const s = status.toLowerCase();
  return (
    s.includes('settled') ||
    s.includes('disbursed') ||
    s.includes('failed') ||
    s.includes('timeout')
  );
}

export function isFailure(status: string): boolean {
  const s = status.toLowerCase();
  return s.includes('failed') || s.includes('timeout');
}
