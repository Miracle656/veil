/**
 * #1039 — the agent thread's bottom clearance is a measured figure, not a
 * constant. These are the pure cases; `__tests__/agentComposerClearance.test.tsx`
 * pins the screen to actually using them.
 */

import {
  THREAD_BOTTOM_GAP,
  UNMEASURED_COMPOSER_CLEARANCE,
  threadBottomInset,
} from '../agentComposer';

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

it('reserves an estimate before the composer has been measured', () => {
  // This case used to return the gap alone, reading 0 as "nothing to clear"
  // rather than "not measured yet" — so until onLayout first fired, the last
  // message was drawn underneath the composer. A reported bug: the answer had
  // the chips and the input field showing through it.
  expect(threadBottomInset({ composerHeight: 0 })).toBe(
    THREAD_BOTTOM_GAP + UNMEASURED_COMPOSER_CLEARANCE
  );
  // A stray negative measurement is no more "measured" than 0 is, and must
  // never subtract from the gap.
  expect(threadBottomInset({ composerHeight: -50, keyboardLift: -10 })).toBe(
    THREAD_BOTTOM_GAP + UNMEASURED_COMPOSER_CLEARANCE
  );
  expect(threadBottomInset({ composerHeight: Number.NaN })).toBe(
    THREAD_BOTTOM_GAP + UNMEASURED_COMPOSER_CLEARANCE
  );
});

it('a real measurement always wins, including a small one', () => {
  // The estimate must not become a floor: 122 is a one-line composer on a
  // small phone and reserving 140 there would waste 18dp of thread forever.
  expect(threadBottomInset({ composerHeight: 122 })).toBeLessThan(
    THREAD_BOTTOM_GAP + UNMEASURED_COMPOSER_CLEARANCE
  );
});
