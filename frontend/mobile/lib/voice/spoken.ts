/**
 * Spoken responses — what the assistant may say out loud.
 *
 * Voice is the loudest surface the wallet has. A balance read aloud in a shared
 * room tells everyone nearby, and unlike the screen the user cannot take it
 * back. So every value-bearing utterance is assembled here, and every one of
 * them honours the same "hide amounts" preference the screens and notifications
 * already honour (`lib/hiddenAmounts.ts`).
 *
 * The rule, which is the whole point of this module:
 *
 *   - amounts hidden  → the assistant says the value exists but will not read it
 *     out, and points the user at the app. No number is spoken.
 *   - amounts visible → the value may be spoken.
 *
 * The preference is read when a response is built, not when an intent is
 * registered, so flipping the toggle takes effect on the very next question.
 *
 * Like `actions.ts`, this is platform-neutral: the iOS App Intents and Android
 * AppFunctions adapters call in here rather than assembling their own strings,
 * so the rule cannot be forgotten on one platform. This module deliberately
 * resolves nothing itself — the caller passes an already-resolved, formatted
 * value, which keeps the voice path out of the balance read path (and out of
 * the secret-touching helpers that path reaches).
 */

import { getHiddenAmounts } from '../hiddenAmounts';

/**
 * What the assistant says instead of a value while amounts are hidden.
 *
 * Deliberately a sentence rather than an error: the request was understood and
 * the answer exists, it is just not one to say out loud. It names no amount,
 * and it tells the user where the number is.
 */
export const HIDDEN_AMOUNT_SPEECH =
  'Amounts are hidden on this device, so I cannot read that out. Open Veil to see it.';

/** Ids of the read-only actions whose answer is a value that could be spoken. */
export type SpokenIntentId = 'balance' | 'price';

export type SpokenIntent = {
  /** Matches the `ReadOnlyAction.id` this answers for (`lib/voice/actions.ts`). */
  id: SpokenIntentId;
  /** What the user hears, given an already-resolved and formatted value. */
  phrase: (value: string) => string;
};

/**
 * Every intent that can speak a value. A new value-bearing intent belongs here;
 * one that only opens a screen does not, because a destination is not a number.
 */
export const SPOKEN_INTENTS: readonly SpokenIntent[] = [
  {
    id: 'balance',
    phrase: (value) => `Your balance is ${value}.`,
  },
  {
    id: 'price',
    phrase: (value) => `The XLM price is ${value}.`,
  },
];

/** The intent with this id, or undefined when nothing speaks for it. */
export function spokenIntentById(id: string): SpokenIntent | undefined {
  return SPOKEN_INTENTS.find((intent) => intent.id === id);
}

/**
 * Build the utterance for one read-only value.
 *
 * The hidden-amounts preference is read here — the same live store the screens
 * and notifications read — rather than passed in, so a caller cannot cache an
 * answer to "are amounts hidden?" and speak a number after the user has turned
 * hiding on.
 */
export function spokenResponse(intent: SpokenIntent, value: string): string {
  if (getHiddenAmounts()) return HIDDEN_AMOUNT_SPEECH;
  return intent.phrase(value);
}
