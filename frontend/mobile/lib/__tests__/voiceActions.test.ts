import { FALLBACK_ROUTE, resolveDeepLink } from '../deepLinks';
import { READ_ONLY_ACTIONS, actionUrl } from '../voice/actions';

/**
 * Every surface that exposes these actions (launcher shortcuts now, App Intents
 * and AppFunctions later) opens them through the deep-link resolver. An action
 * whose link the resolver does not route lands on the home screen instead,
 * which looks like a working shortcut that goes to the wrong place.
 */

describe('READ_ONLY_ACTIONS', () => {
  it('has unique ids', () => {
    const ids = READ_ONLY_ACTIONS.map((action) => action.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it.each(READ_ONLY_ACTIONS.map((action) => [action.id, action] as const))(
    '%s: its link opens its own screen',
    (_id, action) => {
      const route = resolveDeepLink(actionUrl(action));
      expect(route).not.toBe(FALLBACK_ROUTE);
      expect(route).toBe(action.path);
    },
  );

  it.each(READ_ONLY_ACTIONS.map((action) => [action.id, action] as const))(
    '%s: its screen accepts no parameters from outside',
    (_id, action) => {
      // A read-only action must not be steerable. If its route ever gained
      // accepted parameters (an amount, a recipient), a link could pre-fill it.
      const probe = `${actionUrl(action)}?to=G&amount=1&asset=USDC&memo=x`;
      expect(resolveDeepLink(probe)).toBe(action.path);
    },
  );

  it('never opens a screen that can move funds', () => {
    const fundMoving = ['/pay', '/send', '/swap', '/withdraw', '/cash-out', '/bulk-payout'];
    for (const action of READ_ONLY_ACTIONS) {
      expect(fundMoving).not.toContain(action.path);
    }
  });

  it('keeps short labels within what the Android launcher shows', () => {
    for (const action of READ_ONLY_ACTIONS) {
      expect(action.shortLabel.length).toBeLessThanOrEqual(10);
    }
  });
});
