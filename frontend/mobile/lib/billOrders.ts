/**
 * Persisting bill orders, retrieving prepaid tokens, and rechecking pending orders.
 *
 * ## The Problem
 * A bill is paid, a screen says it succeeded, and the user navigates away.
 * There is no record in the app. For electricity that is worse than untidy —
 * the prepaid token shown on the success screen is the thing the purchase was for,
 * and leaving the screen loses it.
 *
 * `GET /ngn/bills/:orderId` exists, so the backend can answer about an order the
 * app knows the ID of.
 *
 * ## What We Store
 * - `category`: BillCategory ('airtime', 'data', 'electricity', 'cabletv', 'betting')
 * - `identifier`: meter number, phone number, smartcard number, betting user ID
 * - `amount`: NGN amount
 * - `amountCrypto`: crypto / stablecoin amount spent
 * - `asset`: coin used ('usdc', 'xlm')
 * - `orderId`: Linq order ID
 * - `status`: 'pending', 'completed', 'failed', 'unconfirmed'
 * - `time`: Unix timestamp in ms
 * - `token`: prepaid token where one was returned (especially for electricity)
 * - `units`: units credited (e.g. '34.5 kWh')
 * - `meterType`: 'prepaid' | 'postpaid'
 * - `customerName`: verified customer name
 * - `customerRef`: Linq customer reference (needed to re-query /ngn/bills/:orderId)
 * - `provider`: e.g. 'IKEDC', 'MTN'
 *
 * ## What We MUST NEVER Store
 * No personal identity data. A meter number is a customer identifier; a NIN
 * must never appear here at all. We explicitly sanitize each record to allow only
 * the required order fields and reject any NIN or personal information.
 */

import AsyncStorage from '@react-native-async-storage/async-storage';
import {
  classifyBillStatus,
  getBillStatus,
  type BillCategory,
  type BillStatus,
} from './onramp';

export const BILL_ORDERS_KEY = 'veil_bill_orders';
export const MAX_BILL_ORDERS = 50;

export interface PersistedBillOrder {
  orderId: string;
  customerRef: string;
  category: BillCategory;
  provider: string;
  identifier: string;
  amount: number;
  amountCrypto?: number;
  asset: string;
  status: string;
  time: number;
  token?: string;
  units?: string;
  meterType?: 'prepaid' | 'postpaid';
  customerName?: string;
}

export type BillOrderInput = {
  orderId: string;
  customerRef: string;
  category: BillCategory;
  provider?: string;
  identifier: string;
  amount: number;
  amountCrypto?: number;
  asset?: string;
  status?: string;
  time?: number;
  token?: string;
  prepaidToken?: string;
  units?: string;
  meterType?: 'prepaid' | 'postpaid';
  customerName?: string;
  [key: string]: unknown;
};

/**
 * Strips any identity data or unneeded properties.
 *
 * A meter number or phone number is the customer identifier for the bill.
 * NIN, BVN, password, and sensitive identity data must NEVER be stored.
 */
export function sanitizeBillOrder(raw: BillOrderInput): PersistedBillOrder {
  const clean: PersistedBillOrder = {
    orderId: String(raw.orderId),
    customerRef: String(raw.customerRef),
    category: raw.category,
    provider: String(raw.provider ?? ''),
    identifier: String(raw.identifier),
    amount: Number(raw.amount),
    asset: String(raw.asset ?? 'usdc').toLowerCase(),
    status: String(raw.status ?? 'pending'),
    time: typeof raw.time === 'number' && !Number.isNaN(raw.time) ? raw.time : Date.now(),
  };

  if (raw.amountCrypto !== undefined && typeof raw.amountCrypto === 'number' && !Number.isNaN(raw.amountCrypto)) {
    clean.amountCrypto = raw.amountCrypto;
  }

  // Token: normalize from token or prepaidToken
  const tokenVal = raw.token ?? raw.prepaidToken;
  if (typeof tokenVal === 'string' && tokenVal.trim()) {
    clean.token = tokenVal.trim();
  }

  if (typeof raw.units === 'string' && raw.units.trim()) {
    clean.units = raw.units.trim();
  }

  if (raw.meterType === 'prepaid' || raw.meterType === 'postpaid') {
    clean.meterType = raw.meterType;
  }

  if (typeof raw.customerName === 'string' && raw.customerName.trim()) {
    clean.customerName = raw.customerName.trim();
  }

  return clean;
}

export function isTerminalStatus(status: string): boolean {
  const outcome = classifyBillStatus(status);
  return outcome === 'done' || outcome === 'failed';
}

export async function getBillOrders(category?: BillCategory): Promise<PersistedBillOrder[]> {
  try {
    const raw = await AsyncStorage.getItem(BILL_ORDERS_KEY);
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    const list = parsed
      .map((item) => sanitizeBillOrder(item as BillOrderInput))
      .sort((a, b) => b.time - a.time);

    return category ? list.filter((o) => o.category === category) : list;
  } catch (err) {
    console.warn('[billOrders] failed to read stored bill orders:', err);
    return [];
  }
}

export async function saveBillOrder(order: BillOrderInput): Promise<PersistedBillOrder> {
  const sanitized = sanitizeBillOrder(order);
  const existing = await getBillOrders();
  const index = existing.findIndex((o) => o.orderId === sanitized.orderId);

  let updated: PersistedBillOrder[];
  if (index >= 0) {
    // Preserve existing token if new one not provided
    if (!sanitized.token && existing[index].token) {
      sanitized.token = existing[index].token;
    }
    if (!sanitized.units && existing[index].units) {
      sanitized.units = existing[index].units;
    }
    updated = [...existing];
    updated[index] = { ...existing[index], ...sanitized };
  } else {
    updated = [sanitized, ...existing].slice(0, MAX_BILL_ORDERS);
  }

  await AsyncStorage.setItem(BILL_ORDERS_KEY, JSON.stringify(updated));
  return sanitized;
}

export async function updateBillOrderStatus(
  orderId: string,
  status: string,
  token?: string,
  units?: string,
): Promise<PersistedBillOrder | null> {
  const existing = await getBillOrders();
  const index = existing.findIndex((o) => o.orderId === orderId);
  if (index < 0) return null;

  const current = existing[index];
  const updatedOrder: PersistedBillOrder = {
    ...current,
    status,
    ...(token ? { token } : {}),
    ...(units ? { units } : {}),
  };

  existing[index] = updatedOrder;
  await AsyncStorage.setItem(BILL_ORDERS_KEY, JSON.stringify(existing));
  return updatedOrder;
}

export async function getBillOrder(orderId: string): Promise<PersistedBillOrder | null> {
  const orders = await getBillOrders();
  return orders.find((o) => o.orderId === orderId) ?? null;
}

/**
 * Retrieve a prepaid token for an order.
 * Returns null if the order doesn't exist or has no token.
 */
export async function retrieveBillToken(orderId: string): Promise<string | null> {
  const order = await getBillOrder(orderId);
  return order?.token ?? null;
}

export async function clearBillOrders(): Promise<void> {
  await AsyncStorage.removeItem(BILL_ORDERS_KEY);
}

export interface RecheckOptions {
  getStatusFn?: (customerRef: string, orderId: string) => Promise<BillStatus>;
}

/**
 * Re-check status for anything not in a terminal state, so an order that was
 * pending when the app closed resolves rather than staying pending forever.
 *
 * Non-terminal orders are re-checked on open.
 */
export async function recheckPendingBillOrders(
  options?: RecheckOptions,
): Promise<PersistedBillOrder[]> {
  const fetchStatus = options?.getStatusFn ?? getBillStatus;
  const orders = await getBillOrders();
  const pendingOrders = orders.filter((o) => !isTerminalStatus(o.status));

  if (pendingOrders.length === 0) {
    return orders;
  }

  let hasUpdates = false;
  const updatedOrders = [...orders];

  for (const order of pendingOrders) {
    try {
      const statusRes = await fetchStatus(order.customerRef, order.orderId);
      const newStatus = statusRes.status;
      const newToken = statusRes.token ?? statusRes.prepaidToken ?? order.token;
      const newUnits = statusRes.units ?? order.units;

      if (
        newStatus !== order.status ||
        (newToken && newToken !== order.token) ||
        (newUnits && newUnits !== order.units)
      ) {
        const idx = updatedOrders.findIndex((o) => o.orderId === order.orderId);
        if (idx >= 0) {
          updatedOrders[idx] = {
            ...updatedOrders[idx],
            status: newStatus,
            ...(newToken ? { token: newToken } : {}),
            ...(newUnits ? { units: newUnits } : {}),
          };
          hasUpdates = true;
        }
      }
    } catch (err) {
      console.warn(`[billOrders] re-check failed for order ${order.orderId}:`, err);
    }
  }

  if (hasUpdates) {
    await AsyncStorage.setItem(BILL_ORDERS_KEY, JSON.stringify(updatedOrders));
  }

  return updatedOrders;
}
