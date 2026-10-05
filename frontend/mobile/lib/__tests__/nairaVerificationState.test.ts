import AsyncStorage from '@react-native-async-storage/async-storage';

import {
  isNairaKycMismatch,
  isNairaVerified,
  setNairaKycMismatch,
  setNairaVerified,
} from '../onramp';

/**
 * Whether a person may move naira, as one answer.
 *
 * This has now caused two loops, both from the same cause: two screens keeping
 * their own idea of the same fact.
 *
 * The first — `/verify` recorded the result under its own key while `buy-ngn`
 * still looked for `verified` on the old `veil_ngn_customer` blob, so someone
 * who had just verified was sent straight back to the start of verification,
 * forever.
 *
 * The second would have been subtler: recording an order-time KYC failure by
 * clearing the verified flag sends them to `/verify`, where the NIN is refused
 * as already used, which marks them verified, which fails at order time again —
 * and each turn of that costs a real NIN attempt against a provider that allows
 * one verified customer per NIN forever.
 */
describe('naira verification state', () => {
  beforeEach(async () => {
    await AsyncStorage.clear();
  });

  it('is unverified before anyone has verified', async () => {
    expect(await isNairaVerified()).toBe(false);
  });

  it('records a verification', async () => {
    await setNairaVerified(true);
    expect(await isNairaVerified()).toBe(true);
  });

  it('adopts a verification recorded by the old buy screen', async () => {
    // Someone who verified before `/verify` existed must not be asked again:
    // Linq allows one verified customer per NIN, forever, so a second attempt
    // is refused outright.
    await AsyncStorage.setItem(
      'veil_ngn_customer',
      JSON.stringify({ customerRef: 'veil_abc123', verified: true }),
    );
    expect(await isNairaVerified()).toBe(true);
  });

  it('does not adopt an unverified legacy blob', async () => {
    await AsyncStorage.setItem(
      'veil_ngn_customer',
      JSON.stringify({ customerRef: 'veil_abc123', verified: false }),
    );
    expect(await isNairaVerified()).toBe(false);
  });

  it('treats an unreadable legacy blob as unverified', async () => {
    await AsyncStorage.setItem('veil_ngn_customer', 'not json');
    expect(await isNairaVerified()).toBe(false);
  });

  describe('an order-time KYC mismatch', () => {
    it('is false until it happens', async () => {
      expect(await isNairaKycMismatch()).toBe(false);
    });

    it('is recorded without disturbing the verified flag', async () => {
      // The whole point. If recording a mismatch cleared `verified`, the next
      // visit would route to /verify, the NIN would be refused as already used,
      // that refusal marks them verified, and the order fails again.
      await setNairaVerified(true);
      await setNairaKycMismatch(true);

      expect(await isNairaKycMismatch()).toBe(true);
      expect(await isNairaVerified()).toBe(true);
    });

    it('can be cleared once it is resolved', async () => {
      await setNairaKycMismatch(true);
      await setNairaKycMismatch(false);
      expect(await isNairaKycMismatch()).toBe(false);
    });
  });
});
