import { assetsView } from '../AssetsList';
import type { Holding } from '../../lib/holdings';

const XLM: Holding = {
  code: 'XLM',
  name: 'Lumens',
  issuer: null,
  balance: '100',
  usd: 25,
  native: true,
};

/**
 * The asset card has four states and exactly one bug worth a test: it used to
 * treat "we do not know yet" and "there is nothing" as the same thing, and so
 * told people with funded wallets that they had no assets every time the app
 * unlocked.
 */
describe('assetsView', () => {
  it('treats null as not-known-yet, never as empty', () => {
    // The whole point. If this ever returns 'empty', the unlock bug is back.
    expect(assetsView(null, false)).toBe('loading');
  });

  it('stays loading on null even when a previous load errored', () => {
    expect(assetsView(null, true)).toBe('loading');
  });

  it('is empty only for a known-empty wallet', () => {
    expect(assetsView([], false)).toBe('empty');
  });

  it('prefers the error message over the empty one', () => {
    // "No assets yet. Fund this wallet" is wrong and discouraging when the
    // truth is that the request failed.
    expect(assetsView([], true)).toBe('error');
  });

  it('shows the list whenever there is anything to show', () => {
    expect(assetsView([XLM], false)).toBe('list');
    // Even mid-error: stale holdings beat an error message that would hide
    // balances the user can still see are theirs.
    expect(assetsView([XLM], true)).toBe('list');
  });
});
