/**
 * Passkey labels have to be distinguishable from each other.
 *
 * A device can legitimately hold more than one Veil passkey — a second wallet,
 * or a replacement credential enrolled by rotation — and the platform chooser
 * is the only place a person ever sees them. When every row said the same
 * thing, a user who had reinstalled and accidentally created a second wallet
 * could not tell which row opened the funded one; Android, offered two
 * indistinguishable candidates, skipped the chooser altogether. The fix was to
 * rename the entries by hand in Google Password Manager, which is not a fix.
 */

import { defaultPasskeyLabel } from '../core';

const USER_A = new Uint8Array([0xa3, 0xf1, 0x00, 0x11, 0x22]);
const USER_B = new Uint8Array([0x7c, 0x04, 0x00, 0x11, 0x22]);

it('names the day it was made, in words a person can read', () => {
  const label = defaultPasskeyLabel(USER_A, new Date(Date.UTC(2026, 9, 30, 12, 0, 0)));
  expect(label).toBe('Veil 30 Oct 2026 (a3f1)');
});

it('separates two passkeys made on the same day', () => {
  const when = new Date(Date.UTC(2026, 9, 30, 12, 0, 0));
  expect(defaultPasskeyLabel(USER_A, when)).not.toBe(defaultPasskeyLabel(USER_B, when));
});

it('separates two passkeys made on different days', () => {
  const a = defaultPasskeyLabel(USER_A, new Date(Date.UTC(2026, 9, 18, 9, 0, 0)));
  const b = defaultPasskeyLabel(USER_A, new Date(Date.UTC(2026, 9, 30, 9, 0, 0)));
  expect(a).not.toBe(b);
  expect(a).toContain('18 Oct');
  expect(b).toContain('30 Oct');
});

it('reads the date in UTC, so the label does not depend on the phone zone', () => {
  // One fixed clock, deliberately. Read in local time, a registration late on
  // the 30th would be labelled the 30th on one phone and the 31st on another,
  // and the label is meant to help someone match a row to a day they
  // remember, not to record the moment precisely.
  const late = new Date(Date.UTC(2026, 9, 30, 23, 30, 0));
  expect(defaultPasskeyLabel(USER_A, late)).toContain('30 Oct 2026');
});

it('is stable for the same handle and day', () => {
  const when = new Date(Date.UTC(2026, 9, 30, 1, 2, 3));
  expect(defaultPasskeyLabel(USER_A, when)).toBe(defaultPasskeyLabel(USER_A, when));
});
