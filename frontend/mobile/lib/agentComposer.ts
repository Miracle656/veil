/**
 * The agent thread's bottom clearance (#1039).
 *
 * The composer floats over the thread: `KeyboardStickyView` translates it up
 * by the keyboard height without a layout pass, so the layout tree never
 * guarantees the distance between the last message and the composer. The
 * thread states that distance itself, in its own content padding — and the
 * only honest figure for "what has to be cleared" is the composer as it was
 * actually drawn. Chips plus input card grow with the system font size and
 * with the lines typed into the field, so a constant clears the composer on
 * the device it was measured on and lands on top of it on the next one
 * (the resting-case bug in #1039).
 *
 * Both inputs are therefore measured: the composer reports its own height
 * from `onLayout`, and the keyboard lift is the same figure the sticky view
 * is translated by.
 */

/** Standing gap kept between the last message and the composer's top edge. */
export const THREAD_BOTTOM_GAP = 16;

/**
 * What to reserve before the composer has ever been measured.
 *
 * `onLayout` reads 0 until it first fires, and 0 was being taken literally —
 * nothing to clear — so the inset collapsed to the gap alone and the last
 * message was drawn underneath the composer. That is the reported bug: an
 * answer with the suggestion chips and the input field showing through it.
 *
 * This is NOT a floor on a real measurement: a genuine 122 on a small phone
 * still reserves 122, which is the whole point of measuring (#1039). It only
 * stands in when nothing has been measured yet. 140 is this composer added up
 * from its own styles — 10 top padding + 12 bottom + 10 gap, a chip row of
 * about 29 (6 padding each side, 1 border, ~15 of text), and an input card of
 * about 84 (14 + 10 padding, 2 border, ~20 of field, 6 gap, ~32 of actions) —
 * so an unmeasured screen errs towards a little too much space rather than
 * painting over itself.
 */
export const UNMEASURED_COMPOSER_CLEARANCE = 140;

export type ThreadClearance = {
  /** Composer height as reported by its own `onLayout`, in dp. */
  composerHeight: number;
  /** Distance the keyboard has lifted the composer, in dp. 0 when closed. */
  keyboardLift?: number;
};

/**
 * How far the thread's content must sit above the bottom of its viewport.
 *
 * The viewport runs the full height of the screen *behind* the composer, so
 * the content reserves the composer's own height, plus the distance the
 * keyboard has moved it, plus the standing gap. One figure covers every case
 * the screen has to get right: keyboard closed (lift 0), keyboard open, one
 * message or a hundred, and any text size — because nothing in it is assumed.
 */
export function threadBottomInset({ composerHeight, keyboardLift = 0 }: ThreadClearance): number {
  const measured = Number.isFinite(composerHeight) ? Math.max(0, composerHeight) : 0;
  const clearance = measured > 0 ? measured : UNMEASURED_COMPOSER_CLEARANCE;
  return THREAD_BOTTOM_GAP + clearance + Math.max(0, keyboardLift);
}
