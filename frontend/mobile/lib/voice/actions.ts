/**
 * The read-only actions Veil exposes outside the app: to the launcher and
 * assistants today, and to voice later.
 *
 * This is the one place an action is defined. Platform surfaces are adapters
 * over this list and add nothing of their own:
 *
 *   - Android App Shortcuts: `plugins/withAndroidShortcuts.js`, fed from the
 *     mirrored list in `app.config.ts` (Expo cannot import this file at config
 *     time; `lib/__tests__/appConfig.test.ts` keeps the two in agreement).
 *   - iOS App Intents: not built yet. They should read the same list.
 *
 * Every action opens an existing screen through the app's own deep-link
 * resolver, so it reads through the same balance and price paths as a tap in the
 * app. There is no second data path and nothing here can sign: an action is a
 * destination, not a function that moves value.
 *
 * ## AppFunctions: not wired, and what an adapter would need
 *
 * Android's AppFunctions is the right long-term target: the app declares
 * functions that an assistant such as Gemini calls directly and gets structured
 * data back, without opening the app. As of 2026-09 the Gemini integration is a
 * private preview for trusted testers, so it can neither be tested nor shipped,
 * and nothing here targets it yet. An adapter would need:
 *
 *   1. Native Kotlin functions, one per action below, added through a config
 *      plugin the same way the shortcuts are. The API is Jetpack
 *      `androidx.appfunctions` on Android 16+; check its current shape before
 *      starting, since it is pre-release.
 *   2. A way to answer without the UI. A shortcut opens a screen; an
 *      AppFunction returns a value. The JS read paths only run inside the app,
 *      so the function needs either a headless JS task or a snapshot the app
 *      writes after each refresh.
 *   3. A read path that holds no secrets. Today the balance screen finds the
 *      fee payer's address by loading its secret seed
 *      (`getFeePayerAddress` in `lib/activity.ts`). An assistant-callable
 *      function must not reach that; it needs the public address instead.
 *
 * The `id`s below are stable and meant to become those function names.
 */

import { DEEP_LINK_SCHEME } from '../deepLinks';

export type ReadOnlyActionId = 'balance' | 'price';

export type ReadOnlyAction = {
  /** Stable identifier: the Android shortcut id, and a future function name. */
  id: ReadOnlyActionId;
  /** Launcher label. Android truncates beyond about 10 characters. */
  shortLabel: string;
  /** Label shown where there is room, and read out by assistants. */
  longLabel: string;
  /**
   * The in-app route the action opens. It must be listed in `LINKABLE_ROUTES`
   * in `lib/deepLinks.ts`, or the resolver sends the link to the home screen.
   */
  path: string;
};

export const READ_ONLY_ACTIONS: readonly ReadOnlyAction[] = [
  {
    id: 'balance',
    shortLabel: 'Balance',
    longLabel: 'Show my balance',
    path: '/dashboard',
  },
  {
    // A launcher shortcut cannot take a parameter, so the price action names
    // its asset. XLM is the native asset and has no issuer to impersonate.
    id: 'price',
    shortLabel: 'XLM price',
    longLabel: 'Show the XLM price',
    path: '/token/XLM',
  },
];

/** The deep link that opens an action, e.g. `veil://dashboard`. */
export function actionUrl(action: ReadOnlyAction): string {
  return `${DEEP_LINK_SCHEME}://${action.path.replace(/^\//, '')}`;
}
