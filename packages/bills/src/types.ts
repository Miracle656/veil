/**
 * The bills provider contract.
 *
 * Shaped around **requery by our own reference**, which is the single property
 * that decides whether a timed-out vend is recoverable. We mint the reference,
 * persist it *before* dispatching, and ask the provider about it afterwards.
 * eBills, Monnify and Plustive all support that; Pairgate does not, which is
 * why Pairgate can never be the primary implementation — its weaker model would
 * otherwise have to leak into this interface.
 *
 * Nothing here is eBills-specific. A second provider slots in behind the same
 * three methods.
 */

/** Networks we can sell airtime on. */
export type Network = 'mtn' | 'airtel' | 'glo' | '9mobile';

/**
 * Where an order stands, normalised away from any provider's vocabulary.
 *
 * The distinction that matters operationally is `pending` versus everything
 * else: `pending` is the only state where the money may still move, so it is
 * the only one we keep asking about, and the only one that must never be
 * treated as a failure.
 */
export type OrderState =
  /** Dispatched, outcome not yet known. Keep requerying. Never re-dispatch. */
  | 'pending'
  /** Value delivered. Terminal. */
  | 'delivered'
  /** Provider returned our float. Terminal — the user must be refunded too. */
  | 'refunded'
  /** Rejected outright, nothing charged. Terminal. */
  | 'failed';

export type AirtimeOrder = {
  /**
   * Our reference, not theirs. Generated and persisted before dispatch so that
   * a request which times out — or never arrives — can still be resolved.
   * eBills caps this at 50 characters and rejects reuse with 409.
   */
  reference: string;
  network: Network;
  /** Nigerian MSISDN. Providers accept 08012345678 and +2348012345678. */
  phone: string;
  /** Face value in whole naira. What the customer receives. */
  amountNaira: number;
};

export type OrderResult = {
  reference: string;
  state: OrderState;
  /** The provider's own id, for support conversations. */
  providerOrderId?: string;
  /** Face value delivered, in naira. */
  amountNaira?: number;
  /**
   * What the float was actually debited, in naira. Below face value by the
   * reseller discount — this difference is the entire margin, and on airtime
   * it is about 3%.
   */
  chargedNaira?: number;
  /** Provider float remaining after the order, when reported. */
  balanceAfterNaira?: number;
  /** Provider's own words, for logs and support. Never shown to a user. */
  message?: string;
};

/** Thrown for conditions a caller can reasonably branch on. */
export class BillsError extends Error {
  constructor(
    message: string,
    readonly code: BillsErrorCode,
    /** True when retrying the identical request later could still succeed. */
    readonly retryable: boolean = false,
  ) {
    super(message);
    this.name = 'BillsError';
  }
}

export type BillsErrorCode =
  /** Credentials rejected. */
  | 'auth_failed'
  /** Authenticated, but the account lacks the role — or the IP is not allowed. */
  | 'forbidden'
  /** Our float cannot cover the order. Top up; do not retry blind. */
  | 'insufficient_float'
  /** Provider is busy or rate-limiting. Retryable with backoff. */
  | 'busy'
  /** The request was rejected as malformed or out of range. Not retryable. */
  | 'invalid_request'
  /**
   * This reference has been used. NOT an error in itself — it means a previous
   * dispatch reached them, so the caller must requery rather than re-send.
   */
  | 'duplicate'
  /** Network or provider fault of unknown consequence. Requery before retrying. */
  | 'unknown';

export interface BillsProvider {
  /** Float remaining, in naira. */
  balance(): Promise<number>;

  /**
   * Dispatch an airtime order.
   *
   * A rejected promise does **not** mean the order did not happen — a timeout
   * is indistinguishable from a slow success from here. The caller's only safe
   * response to any failure is {@link status} on the same reference.
   */
  buyAirtime(order: AirtimeOrder): Promise<OrderResult>;

  /** Resolve an order by the reference we minted for it. */
  status(reference: string): Promise<OrderResult>;
}
