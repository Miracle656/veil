/**
 * A live onramp order has to survive the app being gone.
 *
 * Paying one means leaving for a banking app, and Android is free to kill this
 * process while that happens. The order was held in component state alone, so
 * coming back landed on the amount field with the account number gone — having
 * been told to transfer money to an account the user can no longer see, and
 * with no way to find out whether it arrived. The obvious recovery is to create
 * another order, which leaves two live accounts against one payment.
 */

import { forgetOnrampOrder, loadOnrampOrder, rememberOnrampOrder } from '../onramp';
import type { OnrampOrder } from '../onramp';

jest.mock('../walletStore', () => ({ getWalletAddress: jest.fn(async () => null) }));

const ORDER: OnrampOrder = {
  orderId: 'ofr_123',
  customerRef: 'veil_abc',
  accountNumber: '0123456789',
  bankName: 'Test Bank',
  accountName: 'Veil Onramp',
  amountNgn: 1000,
  amountStableCoin: 0.69,
  fee: 0,
  expiresAt: new Date(Date.now() + 9 * 60_000).toISOString(),
  status: 'pending',
};

beforeEach(async () => {
  await forgetOnrampOrder();
});

describe('loadOnrampOrder', () => {
  it('restores the account number and the clock', async () => {
    await rememberOnrampOrder(ORDER);

    // The whole order, not just the id: `expiresAt` is absent from the status
    // response, and a restored screen with no countdown cannot say the one
    // thing that matters — whether this account still accepts the payment.
    await expect(loadOnrampOrder()).resolves.toMatchObject({
      orderId: 'ofr_123',
      accountNumber: '0123456789',
      expiresAt: ORDER.expiresAt,
    });
  });

  // Restoring a dead order is worse than losing it: it tells someone to pay an
  // account that has stopped accepting payment.
  it('refuses an expired order and clears it', async () => {
    await rememberOnrampOrder({ ...ORDER, expiresAt: new Date(Date.now() - 1000).toISOString() });

    await expect(loadOnrampOrder()).resolves.toBeNull();
    // Cleared on the way out, so the next launch does not re-read it.
    await expect(loadOnrampOrder()).resolves.toBeNull();
  });

  it('has no order after one is forgotten', async () => {
    await rememberOnrampOrder(ORDER);
    await forgetOnrampOrder();

    await expect(loadOnrampOrder()).resolves.toBeNull();
  });

  it('has no order when nothing was stored', async () => {
    await expect(loadOnrampOrder()).resolves.toBeNull();
  });
});
