import {
  BillsError,
  type AirtimeOrder,
  type BillsProvider,
  type OrderResult,
  type OrderState,
} from './types.js';

export type MockConfig = {
  /** Opening float, in naira. */
  balanceNaira?: number;
  /**
   * How many times an order reports `pending` before settling. The default of
   * 1 means the first requery is still pending, which is the case real callers
   * most often get wrong — a mock that settles immediately hides the bug.
   */
  pendingPolls?: number;
  /** What every order eventually settles to. */
  settleAs?: Exclude<OrderState, 'pending'>;
  /** Reseller discount, as a fraction. Airtime runs at about 3%. */
  discount?: number;
};

/**
 * In-memory BillsProvider for building against before the real account is
 * usable, and for tests.
 *
 * It deliberately reproduces the three behaviours that break naive callers:
 * orders settle asynchronously rather than on dispatch, a reused reference is
 * rejected rather than silently vending twice, and a refund restores the float
 * so balance arithmetic stays honest.
 */
export class MockBillsProvider implements BillsProvider {
  private float: number;
  private readonly pendingPolls: number;
  private readonly settleAs: Exclude<OrderState, 'pending'>;
  private readonly discount: number;
  private readonly orders = new Map<
    string,
    { order: AirtimeOrder; polls: number; charged: number; id: string }
  >();
  private nextId = 1000;

  constructor(config: MockConfig = {}) {
    this.float = config.balanceNaira ?? 10_000;
    this.pendingPolls = config.pendingPolls ?? 1;
    this.settleAs = config.settleAs ?? 'delivered';
    this.discount = config.discount ?? 0.03;
  }

  async balance(): Promise<number> {
    return this.float;
  }

  async buyAirtime(order: AirtimeOrder): Promise<OrderResult> {
    if (order.reference.length > 50) {
      throw new BillsError('reference exceeds the 50-character limit', 'invalid_request');
    }
    if (this.orders.has(order.reference)) {
      // Exactly what eBills does. The caller must requery, never re-dispatch.
      throw new BillsError('reference already used', 'duplicate');
    }
    if (order.amountNaira <= 0) {
      throw new BillsError('amount must be positive', 'invalid_request');
    }

    const charged = Math.round(order.amountNaira * (1 - this.discount) * 100) / 100;
    if (charged > this.float) {
      throw new BillsError('float cannot cover this order', 'insufficient_float');
    }

    this.float = Math.round((this.float - charged) * 100) / 100;
    const id = String(this.nextId++);
    this.orders.set(order.reference, { order, polls: 0, charged, id });

    return {
      reference: order.reference,
      state: 'pending',
      providerOrderId: id,
      amountNaira: order.amountNaira,
      chargedNaira: charged,
      balanceAfterNaira: this.float,
    };
  }

  async status(reference: string): Promise<OrderResult> {
    const entry = this.orders.get(reference);
    if (!entry) throw new BillsError('no order for that reference', 'invalid_request');

    entry.polls += 1;
    const settled = entry.polls > this.pendingPolls;
    const state: OrderState = settled ? this.settleAs : 'pending';

    // A refund puts the float back, once.
    if (settled && this.settleAs !== 'delivered' && entry.charged > 0) {
      this.float = Math.round((this.float + entry.charged) * 100) / 100;
      entry.charged = 0;
    }

    return {
      reference,
      state,
      providerOrderId: entry.id,
      amountNaira: entry.order.amountNaira,
      chargedNaira: entry.charged,
      balanceAfterNaira: this.float,
    };
  }
}
