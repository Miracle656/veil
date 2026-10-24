/**
 * #1039 — the agent thread's bottom clearance is a measured figure, not a
 * constant. These are the pure cases; `__tests__/agentComposerClearance.test.tsx`
 * pins the screen to actually using them.
 */

import { THREAD_BOTTOM_GAP, threadBottomInset } from '../agentComposer';

it('with the keyboard closed, reserves the composer and the standing gap', () => {
  // A one-line composer on a small phone.
  expect(threadBottomInset({ composerHeight: 122 })).toBe(THREAD_BOTTOM_GAP + 122);
});

it('with the keyboard open, reserves the composer, the lift, and the gap', () => {
  // Keyboard 300 high, bottom inset 34: the sticky view lifts by 266.
  expect(threadBottomInset({ composerHeight: 122, keyboardLift: 266 })).toBe(
    THREAD_BOTTOM_GAP + 122 + 266
  );
});

it('follows the composer as text size grows — largest dynamic type', () => {
  // The same composer with the system font at its largest: the clearance has
  // to grow with it, which is the whole point of measuring.
  expect(threadBottomInset({ composerHeight: 420 })).toBe(THREAD_BOTTOM_GAP + 420);
  expect(threadBottomInset({ composerHeight: 420, keyboardLift: 266 })).toBe(
    THREAD_BOTTOM_GAP + 420 + 266
  );
});

it('never clears less than the standing gap, whatever it is measured', () => {
  // Before the first onLayout the height is 0; a stray negative measurement
  // must not subtract from the gap.
  expect(threadBottomInset({ composerHeight: 0 })).toBe(THREAD_BOTTOM_GAP);
  expect(threadBottomInset({ composerHeight: -50, keyboardLift: -10 })).toBe(THREAD_BOTTOM_GAP);
});
