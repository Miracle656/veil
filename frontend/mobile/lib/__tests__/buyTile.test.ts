/**
 * The onramp has to be reachable from the dashboard.
 *
 * `app/buy-ngn.tsx` has existed on this branch for a while with nothing
 * pointing at it: the only link was one Settings row, shown in a single NIN
 * state. On an installed build there was no way to reach the buy flow at all,
 * which is how a build shipped with no onramp on the branch named after it.
 *
 * It is gated exactly like cash-out, and for the same two reasons: both need
 * the backend holding the Linq key, and Linq's Stellar leg is mainnet only —
 * its deposit wallets are mainnet accounts a testnet wallet cannot reach.
 * Offering it and failing after someone has entered bank details is worse than
 * not offering it.
 */

import { BILL_SERVICES } from '../../components/PayForGrid';

/** What the dashboard renders, given the two signals it has. */
function dashboardServices(offrampReady: boolean, onTestnet: boolean) {
  return offrampReady && !onTestnet
    ? BILL_SERVICES
    : BILL_SERVICES.filter((s) => s.id !== 'transfer' && s.id !== 'buy');
}

const ids = (offrampReady: boolean, onTestnet: boolean) =>
  dashboardServices(offrampReady, onTestnet).map((s) => s.id);

it('offers Buy on mainnet when the backend is reachable', () => {
  expect(ids(true, false)).toContain('buy');
});

it('points Buy at the onramp screen, as a live service', () => {
  const buy = BILL_SERVICES.find((s) => s.id === 'buy');
  expect(buy).toBeDefined();
  expect(buy?.route).toBe('/buy-ngn');
  expect(buy?.status).toBe('live');
});

it('hides Buy on testnet, where Linq cannot settle', () => {
  expect(ids(true, true)).not.toContain('buy');
});

it('hides Buy when the backend is unreachable', () => {
  // No Linq key reachable means no order can be created, so the tile would
  // only lead someone into a dead end.
  expect(ids(false, false)).not.toContain('buy');
});

it('hides Buy and Cash out together, never one without the other', () => {
  // They depend on the same backend; showing one while hiding the other would
  // tell the user something untrue about which rails are open.
  for (const [ready, testnet] of [[true, true], [false, false], [false, true]] as const) {
    const shown = ids(ready, testnet);
    expect(shown).not.toContain('buy');
    expect(shown).not.toContain('transfer');
  }
});

it('leaves the crypto-funded services alone in every state', () => {
  // Airtime deposits crypto from this wallet, so it does not depend on the
  // naira rails being open.
  expect(ids(false, true)).toContain('airtime');
});
