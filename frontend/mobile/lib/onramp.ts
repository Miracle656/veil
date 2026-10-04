/**
 * Buying XLM or USDC with naira, and paying bills out of the wallet.
 *
 * Every call goes through wraith, never to Linq directly: the Linq API key is
 * the ability to create orders that move real naira, and anything shipped in an
 * APK is extractable. See `wraith/docs/ngn-rails.md`.
 *
 * ## This is mainnet, always, and the header says so
 *
 * Linq has no sandbox — every call moves real money. A Stellar `G…` address is
 * valid on both networks, so an order placed from a testnet session would take
 * real naira out of someone's bank and deliver real crypto to an address their
 * testnet wallet never displays. wraith refuses that, but only if it knows which
 * network we mean: with no `x-network` header it falls back to *its own*
 * default, which may be testnet, and the whole surface would answer 400 for a
 * reason that has nothing to do with the user. So the header is sent explicitly
 * on every call.
 *
 * ## No signing happens here
 *
 * The onramp never asks the wallet to sign anything. The user is given a
 * Nigerian account number, transfers naira from their own bank app, and Linq
 * delivers the crypto to their classic address. Bills are the opposite — the
 * deposit is crypto leaving this wallet — and that payment is made with
 * `spendAsset`, not by anything in this file.
 */

import AsyncStorage from '@react-native-async-storage/async-storage';

import { getWalletAddress } from './walletStore';
import { OfframpTimeout, OfframpUnavailable, withoutProviderName } from './offramp';

const BASE_URL = process.env['EXPO_PUBLIC_WRAITH_URL']?.replace(/\/+$/, '') ?? '';

/** Matches wraith's own per-operation ceiling, retries included. */
const TIMEOUT_MS = 40_000;

/** Thrown when this deployment has no naira rails configured (wraith answers 503). */
export class NairaUnavailable extends OfframpUnavailable {}

/** Thrown when wraith did not answer in time. */
export class NairaTimeout extends OfframpTimeout {}

async function call<T>(
  path: string,
  init: { method?: string; body?: unknown; timeoutMs?: number } = {},
): Promise<T> {
  if (!BASE_URL) throw new NairaUnavailable('No backend configured for naira rails.');

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), init.timeoutMs ?? TIMEOUT_MS);
  try {
    const res = await fetch(`${BASE_URL}${path}`, {
      method: init.method ?? 'GET',
      signal: controller.signal,
      headers: {
        // Never omitted — see this module's header.
        'x-network': 'mainnet',
        ...(init.body ? { 'Content-Type': 'application/json' } : {}),
      },
      ...(init.body ? { body: JSON.stringify(init.body) } : {}),
    });

    const text = await res.text();
    const data = text ? JSON.parse(text) : {};

    if (res.status === 503) {
      throw new NairaUnavailable(withoutProviderName(data?.error ?? 'Naira rails unavailable'));
    }
    if (!res.ok) {
      throw new Error(withoutProviderName(data?.error ?? `Request failed (${res.status})`));
    }
    return data as T;
  } catch (err) {
    if (err instanceof NairaUnavailable) throw err;
    if ((err as Error)?.name === 'AbortError') {
      throw new NairaTimeout('The service did not respond in time.');
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }
}


// ─── Who we are to Linq ──────────────────────────────────────────────────────

const CUSTOMER_REF_KEY = 'veil_ngn_customer_ref';

/** Where the buy screen kept `{ customerRef, verified }` before this accessor. */
const LEGACY_CUSTOMER_KEY = 'veil_ngn_customer';

/**
 * This wallet's Linq `customerRef`, stable for the life of the install.
 *
 * **Linq enforces one verified customer per NIN** (confirmed with them
 * 2026-10-03). That makes this value far more load-bearing than it looks: a
 * `customerRef` that changes is not a new reference to the same person, it is a
 * second person Linq has never heard of — and the NIN that would verify them is
 * already spent, with no self-service way to get it back.
 *
 * So it is **persisted, not derived on each read**. It is seeded from the
 * wallet address the first time only, which keeps a passkey-recovered wallet on
 * the same reference it had before. After that the stored value wins even if
 * the wallet address changes.
 *
 * The gap this does not close: a user who creates a genuinely new wallet, or
 * reinstalls without a backup, gets a new reference and hits "NIN already
 * used". Closing that needs Linq to expose a way to resolve the existing
 * customer for a NIN — see `docs/NGN_RAILS.md`. Until then, do not add any code
 * path that regenerates this value.
 */
export async function getCustomerRef(): Promise<string | null> {
  const stored = await AsyncStorage.getItem(CUSTOMER_REF_KEY).catch(() => null);
  if (stored) return stored;

  // Adopt the reference the buy screen stored before this accessor existed.
  //
  // Skipping this is how a verified user gets told "this NIN has already been
  // used": their verified reference is sitting under the old key, this function
  // ignores it, derives a fresh one from the current wallet, and Linq sees a
  // customer it has never met holding a NIN that is already spent. Switching
  // network makes it certain, because the wallet address — and so the derived
  // reference — differs per network while the NIN does not.
  const legacy = await AsyncStorage.getItem(LEGACY_CUSTOMER_KEY).catch(() => null);
  if (legacy) {
    try {
      const parsed = JSON.parse(legacy) as { customerRef?: unknown };
      if (typeof parsed.customerRef === 'string' && parsed.customerRef) {
        await AsyncStorage.setItem(CUSTOMER_REF_KEY, parsed.customerRef).catch(() => undefined);
        return parsed.customerRef;
      }
    } catch {
      // Unparseable legacy blob: fall through and derive.
    }
  }

  const wallet = await getWalletAddress().catch(() => null);
  if (!wallet) return null;

  const ref = `veil_${wallet.slice(-12).toLowerCase()}`;
  await AsyncStorage.setItem(CUSTOMER_REF_KEY, ref).catch(() => undefined);
  return ref;
}

/**
 * The contact details from the first verification screen, kept so a second
 * attempt does not start from an empty form.
 *
 * A rejected NIN is the common case — Linq matches it against the name, so a
 * middle name or a different spelling fails a number that is perfectly correct.
 * Making someone retype their name, email and phone to try again is how a
 * fixable mistake turns into an abandoned signup.
 *
 * The NIN itself is NEVER here. It is personal data under the NDPA, it is sent
 * once and kept by nobody, and a stored copy would outlive the reason it was
 * collected. These four fields are already held by Linq against this customer.
 */
const VERIFY_DETAILS_KEY = 'veil_ngn_details';

export interface VerifyDetails {
  firstName: string;
  lastName: string;
  email: string;
  phone: string;
}

export async function saveVerifyDetails(details: VerifyDetails): Promise<void> {
  // The four fields by name, never the object it was handed.
  //
  // `JSON.stringify(details)` writes whatever the caller passed, so the only
  // thing keeping a NIN out of storage would be the type — and a type is a
  // compile-time promise about a runtime value that arrives from a form. For
  // this one field that is not enough: it is personal data under the NDPA, and
  // a stored copy would outlive the reason it was collected.
  const safe: VerifyDetails = {
    firstName: details.firstName,
    lastName: details.lastName,
    email: details.email,
    phone: details.phone,
  };
  await AsyncStorage.setItem(VERIFY_DETAILS_KEY, JSON.stringify(safe)).catch(() => undefined);
}

export async function loadVerifyDetails(): Promise<VerifyDetails | null> {
  const raw = await AsyncStorage.getItem(VERIFY_DETAILS_KEY).catch(() => null);
  if (!raw) return null;
  try {
    const d = JSON.parse(raw) as Partial<VerifyDetails>;
    return {
      firstName: typeof d.firstName === 'string' ? d.firstName : '',
      lastName: typeof d.lastName === 'string' ? d.lastName : '',
      email: typeof d.email === 'string' ? d.email : '',
      phone: typeof d.phone === 'string' ? d.phone : '',
    };
  } catch {
    return null;
  }
}

/** Whether this device has completed the one-time NIN check. */
const VERIFIED_KEY = 'veil_ngn_verified';

/**
 * Has this person verified yet?
 *
 * One answer for every naira flow. Buying and paying a bill are the same
 * person under the same Nigerian rule, so they cannot each keep their own idea
 * of whether that rule has been met — airtime did not check at all, and a
 * person who had never verified could reach Linq's "has not completed KYC"
 * error by paying a bill, which is a worse way to find out.
 *
 * Reads the legacy `{ customerRef, verified }` blob too, so someone who
 * verified through the buy screen before this key existed is not asked again.
 * Being asked twice is not merely annoying here: Linq allows one verified
 * customer per NIN forever, so a second attempt is refused outright.
 */
export async function isNairaVerified(): Promise<boolean> {
  const flag = await AsyncStorage.getItem(VERIFIED_KEY).catch(() => null);
  if (flag === 'true') return true;

  const legacy = await AsyncStorage.getItem(LEGACY_CUSTOMER_KEY).catch(() => null);
  if (legacy) {
    try {
      const parsed = JSON.parse(legacy) as { verified?: unknown };
      if (parsed.verified === true) {
        await AsyncStorage.setItem(VERIFIED_KEY, 'true').catch(() => undefined);
        return true;
      }
    } catch {
      // Unparseable: treat as unverified rather than guessing.
    }
  }
  return false;
}

/**
 * Record the result of the one-time check.
 *
 * Only ever called with the answer Linq gave. Never set optimistically: a
 * device that believes it is verified when Linq disagrees cannot recover, since
 * the one NIN that would verify it has already been spent.
 */
export async function setNairaVerified(verified: boolean): Promise<void> {
  await AsyncStorage.setItem(VERIFIED_KEY, verified ? 'true' : 'false').catch(() => undefined);
}

// ─── Customer ────────────────────────────────────────────────────────────────

export interface NairaCustomer {
  customerRef: string;
  verified: boolean;
  /** False when the customer already existed — provisioning is idempotent. */
  created: boolean;
}

/**
 * One-time per person, not per order. Safe to call again after a dropped
 * response: Linq returns the existing customer with `created: false`, so a
 * retry cannot create two customers for one person.
 */
export function provisionCustomer(params: {
  customerRef: string;
  firstName: string;
  lastName: string;
  email: string;
  phone: string;
}): Promise<NairaCustomer> {
  return call<NairaCustomer>('/ngn/customers', { method: 'POST', body: params });
}

export interface KycResult {
  customerRef: string;
  verified: boolean;
  status: string;
}

/**
 * Verify by NIN. **One time, ever** — not per order.
 *
 * The NIN is sent and never kept: not by this app, and not by wraith, which has
 * no field for it on any stored shape. Do not log it, do not put it in state
 * that outlives the screen, and do not write it to storage. It is personal data
 * under the NDPA.
 */
export function submitKyc(customerRef: string, nin: string): Promise<KycResult> {
  return call<KycResult>('/ngn/customers/kyc', {
    method: 'POST',
    body: { customerRef, nin },
  });
}

// ─── Onramp ──────────────────────────────────────────────────────────────────

export type NairaCoin = 'xlm' | 'usdc';

/**
 * NGN per unit of the asset.
 *
 * Deliberately uncached, unlike the offramp's indicative rate: this is the
 * number that gets locked into the order, and XLM floats. Fetch it immediately
 * before creating an order, never from a value held across screens for minutes.
 */
export async function getOnrampRate(): Promise<number> {
  const { rate } = await call<{ rate: number }>('/ngn/onramp/rate');
  if (!(rate > 0)) throw new Error('The service returned an unusable rate.');
  return rate;
}

export interface OnrampOrder {
  orderId: string;
  customerRef: string;
  /** The Nigerian account the user transfers naira into. */
  accountNumber: string;
  bankName: string;
  /** Shown before the bank app does, so "Linq Onramp Payment" is not a surprise. */
  accountName: string;
  amountNgn: number;
  amountStableCoin: number;
  fee: number;
  /** ISO-8601. After this the order is dead and the money must not be sent. */
  expiresAt: string;
  status: string;
}

/**
 * Create an order and get the account to pay.
 *
 * `walletAddress` must be the **classic `G…` account**, never the `C…` smart
 * wallet: Linq pays by classic operation, which cannot name a contract as a
 * destination. wraith refuses a `C…` before it reaches Linq, and the receive
 * screen made exactly this mistake once.
 */
export function createOnrampOrder(params: {
  customerRef: string;
  amountStableCoin: number;
  walletAddress: string;
  rate: number;
  coin: NairaCoin;
}): Promise<OnrampOrder> {
  return call<OnrampOrder>('/ngn/onramp/orders', { method: 'POST', body: params });
}

export interface OnrampStatus {
  orderId: string;
  customerRef: string;
  status: string;
  amount: number;
  amountNgn: number;
  bankName: string;
  accountNumber: string;
  accountName: string;
  /** Present only when wraith answered from its own record because Linq was down. */
  stale?: boolean;
}

/** Both identifiers are required — an orderId alone is not enough, by design. */
export function getOnrampStatus(customerRef: string, orderId: string): Promise<OnrampStatus> {
  return call<OnrampStatus>(
    `/ngn/onramp/orders/${encodeURIComponent(orderId)}?customerRef=${encodeURIComponent(customerRef)}`,
  );
}

// ─── Bills ───────────────────────────────────────────────────────────────────

export type BillCategory = 'airtime' | 'data' | 'electricity' | 'cabletv' | 'betting';

export interface BillOrder {
  id: string;
  customerRef: string;
  /** Where the wallet sends the crypto. Nothing is vended until it arrives. */
  wallet: string;
  status: string;
}

/**
 * Reserve a bill and lock the rate.
 *
 * `refundAddress` is where the deposit goes if the biller rejects the top-up
 * **after** the user has paid — a biller failing does not un-spend their XLM.
 * It must be the classic `G…` account of a wallet the user controls.
 */
export function payBill(params: {
  customerRef: string;
  billCategory: BillCategory;
  provider: string;
  /** The phone number for airtime, the meter number for electricity. */
  customerId: string;
  amountNgn: number;
  amountStableCoin: number;
  rate: number;
  coin: NairaCoin;
  refundAddress: string;
}): Promise<BillOrder> {
  return call<BillOrder>('/ngn/bills', { method: 'POST', body: params });
}

export interface BillStatus {
  orderId: string;
  customerRef: string;
  status: string;
  billCategory: string;
  amountNgn: number;
  amountStableCoin: number;
  wallet: string;
  description: string;
  stale?: boolean;
}

export function getBillStatus(customerRef: string, orderId: string): Promise<BillStatus> {
  return call<BillStatus>(
    `/ngn/bills/${encodeURIComponent(orderId)}?customerRef=${encodeURIComponent(customerRef)}`,
  );
}

// ─── Availability ────────────────────────────────────────────────────────────

/**
 * Whether the naira rails can be offered at all.
 *
 * Gates the entry point. wraith answers 503 when it holds no Linq key, and 400
 * on any network but mainnet — both mean "do not show the user an amount field
 * they cannot act on".
 */
export async function isNairaAvailable(): Promise<boolean> {
  try {
    await getOnrampRate();
    return true;
  } catch {
    return false;
  }
}

/**
 * Whether the rate still holds, as whole seconds.
 *
 * Returns 0 once it does not. The countdown is not decoration: after it the
 * account stops accepting the payment, and a user who left for their bank app
 * with the screen still showing the number is exactly who this protects.
 */
export function secondsUntil(expiresAt: string): number {
  const ms = new Date(expiresAt).getTime() - Date.now();
  return Number.isFinite(ms) ? Math.max(0, Math.floor(ms / 1000)) : 0;
}
