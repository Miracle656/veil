/**
 * Pure rules for swiping between the bottom tabs.
 *
 * Only these four routes are reachable by swipe, in this order. Swap is not a
 * tab (it is a root push route) and `prover-spike` is a hidden route, so neither
 * may be reached by swiping. Keep this list in step with VeilTabBar's order.
 */
export const SWIPE_TABS = ['dashboard', 'earn', 'agent', 'settings'] as const;

export type SwipeTab = (typeof SWIPE_TABS)[number];

/** Direction of a swipe: +1 moves to the next tab (swipe left), -1 to the previous. */
export type SwipeDirection = 1 | -1 | 0;

/** A drag commits once it passes this share of the screen width. */
export const SWIPE_DISTANCE_RATIO = 0.25;

/** A flick commits once it is faster than this, in points per second. */
export const SWIPE_VELOCITY = 500;

/** Horizontal drag before a swipe is recognised. Vertical drift past the fail offset cancels it. */
export const SWIPE_ACTIVE_OFFSET_X = 15;
export const SWIPE_FAIL_OFFSET_Y = 12;

/** Width of the edge strips that still swipe on the Agent screen, where the middle is the chat. */
export const AGENT_EDGE_WIDTH = 24;

/**
 * The tab a swipe lands on, or null at either end or when the current route is
 * not a swipeable tab (for example Swap is pushed over the tabs).
 */
export function adjacentTab(current: string | undefined, direction: 1 | -1): SwipeTab | null {
  const index = SWIPE_TABS.indexOf(current as SwipeTab);
  if (index < 0) return null;
  const target = index + direction;
  if (target < 0 || target >= SWIPE_TABS.length) return null;
  return SWIPE_TABS[target];
}

/**
 * Decide from the finished gesture whether it commits to a tab change.
 * Positive translation is a drag to the right, so it means previous.
 * Returns 0 when the gesture is too short or too slow to count.
 */
export function resolveSwipe(translationX: number, velocityX: number, width: number): SwipeDirection {
  'worklet';
  if (width <= 0) return 0;
  const far = Math.abs(translationX) > width * SWIPE_DISTANCE_RATIO;
  const fast = Math.abs(velocityX) > SWIPE_VELOCITY;
  if (!far && !fast) return 0;
  if (translationX === 0) return 0;
  return translationX < 0 ? 1 : -1;
}
