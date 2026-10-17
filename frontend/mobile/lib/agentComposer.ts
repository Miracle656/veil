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
  return THREAD_BOTTOM_GAP + Math.max(0, composerHeight) + Math.max(0, keyboardLift);
}
