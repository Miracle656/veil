import { adjacentTab, resolveSwipe, SWIPE_TABS } from '../lib/tabSwipe';

describe('adjacentTab', () => {
  it('walks Home, Earn, Agent, Settings in that order', () => {
    expect(SWIPE_TABS).toEqual(['dashboard', 'earn', 'agent', 'settings']);
    expect(adjacentTab('dashboard', 1)).toBe('earn');
    expect(adjacentTab('earn', 1)).toBe('agent');
    expect(adjacentTab('agent', 1)).toBe('settings');
    expect(adjacentTab('settings', -1)).toBe('agent');
    expect(adjacentTab('agent', -1)).toBe('earn');
    expect(adjacentTab('earn', -1)).toBe('dashboard');
  });

  it('stops at both ends instead of wrapping', () => {
    expect(adjacentTab('dashboard', -1)).toBeNull();
    expect(adjacentTab('settings', 1)).toBeNull();
  });

  it('never lands on Swap or the hidden prover-spike route', () => {
    expect(adjacentTab('earn', 1)).not.toBe('swap');
    expect(adjacentTab('settings', 1)).not.toBe('prover-spike');
    expect(SWIPE_TABS as readonly string[]).not.toContain('swap');
    expect(SWIPE_TABS as readonly string[]).not.toContain('prover-spike');
  });

  it('returns null when the current route is not a swipeable tab', () => {
    expect(adjacentTab('swap', 1)).toBeNull();
    expect(adjacentTab('prover-spike', -1)).toBeNull();
    expect(adjacentTab(undefined, 1)).toBeNull();
  });
});

describe('resolveSwipe', () => {
  const width = 400;

  it('commits to next on a long drag left', () => {
    expect(resolveSwipe(-150, 0, width)).toBe(1);
  });

  it('commits to previous on a long drag right', () => {
    expect(resolveSwipe(150, 0, width)).toBe(-1);
  });

  it('commits on a fast flick even when the drag is short', () => {
    expect(resolveSwipe(-30, -900, width)).toBe(1);
    expect(resolveSwipe(30, 900, width)).toBe(-1);
  });

  it('does nothing for a short, slow drag', () => {
    expect(resolveSwipe(-40, -100, width)).toBe(0);
    expect(resolveSwipe(40, 100, width)).toBe(0);
  });

  it('does nothing when there is no width to measure against', () => {
    expect(resolveSwipe(-300, -900, 0)).toBe(0);
  });

  it('does nothing for a zero translation even with a velocity', () => {
    expect(resolveSwipe(0, 900, width)).toBe(0);
  });
});
