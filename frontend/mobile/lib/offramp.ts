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

const BASE_URL = process.env['EXPO_PUBLIC_WRAITH_URL']?.replace(/\/+$/, '') ?? '';
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
    return true;
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
