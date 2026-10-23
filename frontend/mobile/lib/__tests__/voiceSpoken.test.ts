import { setHiddenAmounts } from '../hiddenAmounts';
import { READ_ONLY_ACTIONS } from '../voice/actions';
import {
  HIDDEN_AMOUNT_SPEECH,
  SPOKEN_INTENTS,
  spokenIntentById,
  spokenResponse,
} from '../voice/spoken';

/**
 * Voice must respect hidden amounts.
 *
 * The assistant answers out loud, so a value it speaks leaves the device in a
 * way a screen does not: bystanders hear it, and the user cannot take it back.
 * The setting is the user saying "not here", and every value-bearing intent has
 * to honour it — both states, every intent.
 */

/** A value that looks like a real answer, with plenty of digits to leak. */
const VALUE = '₦1,600,000.00';

beforeEach(async () => {
  // The store is module state shared with the screens; start each case visible.
  await setHiddenAmounts(false);
});

describe('every intent that speaks a value', () => {
  it.each(SPOKEN_INTENTS.map((intent) => [intent.id, intent] as const))(
    '%s: speaks the value when amounts are visible',
    (_id, intent) => {
      expect(spokenResponse(intent, VALUE)).toContain(VALUE);
    },
  );

  it.each(SPOKEN_INTENTS.map((intent) => [intent.id, intent] as const))(
    '%s: says nothing numeric when amounts are hidden',
    async (_id, intent) => {
      await setHiddenAmounts(true);
      const spoken = spokenResponse(intent, VALUE);

      expect(spoken).toBe(HIDDEN_AMOUNT_SPEECH);
      // The strongest form of "no number is spoken": none of the value's
      // characters reach the response, in any formatting.
      expect(spoken).not.toContain(VALUE);
      expect(spoken).not.toMatch(/[0-9]/);
    },
  );

  it.each(SPOKEN_INTENTS.map((intent) => [intent.id, intent] as const))(
    '%s: the hidden answer is useful rather than an error',
    async (_id, intent) => {
      await setHiddenAmounts(true);
      const spoken = spokenResponse(intent, VALUE);

      // It confirms the question was understood and names where the answer is,
      // instead of failing or apologising without a next step.
      expect(spoken).toMatch(/could not read|will not read|cannot read/i);
      expect(spoken).toMatch(/Veil/);
    },
  );
});

describe('the setting is read live', () => {
  const intent = SPOKEN_INTENTS[0];

  it('changes the answer the moment hiding is turned on, with no re-registration', () => {
    // Captured while visible, the way an intent that registered at launch would
    // have captured it. The next call must not reuse it.
    const whileVisible = spokenResponse(intent, VALUE);
    expect(whileVisible).toContain(VALUE);

    void setHiddenAmounts(true);

    const whileHidden = spokenResponse(intent, VALUE);
    expect(whileHidden).toBe(HIDDEN_AMOUNT_SPEECH);
    expect(whileHidden).not.toBe(whileVisible);
  });

  it('speaks again as soon as hiding is turned off', async () => {
    await setHiddenAmounts(true);
    expect(spokenResponse(intent, VALUE)).toBe(HIDDEN_AMOUNT_SPEECH);

    await setHiddenAmounts(false);
    expect(spokenResponse(intent, VALUE)).toContain(VALUE);
  });
});

describe('the registry', () => {
  it('has unique ids', () => {
    const ids = SPOKEN_INTENTS.map((intent) => intent.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('covers every read-only action whose answer is a value', () => {
    for (const action of READ_ONLY_ACTIONS) {
      expect(spokenIntentById(action.id)).toBeDefined();
    }
  });

  it('names no intent that is not a read-only action', () => {
    const actionIds = READ_ONLY_ACTIONS.map((action) => action.id);
    for (const intent of SPOKEN_INTENTS) {
      expect(actionIds).toContain(intent.id);
    }
  });

  it('returns nothing for an id it does not speak for', () => {
    expect(spokenIntentById('send')).toBeUndefined();
  });
});
