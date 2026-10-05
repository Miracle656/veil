/**
 * Pick a phone number from the device's contacts.
 *
 * `expo-contacts` is a native module, so it exists only in a build that was
 * compiled with it. Importing it at the top of a screen would mean a screen
 * that cannot render at all on an older build — a blank Airtime page instead of
 * a missing button.
 *
 * Requiring it lazily inside a `try` is NOT enough, which is what the first
 * version of this got wrong. `require('expo-contacts')` resolves fine; it is the
 * module's own top-level code that calls `requireNativeModule('ExpoContacts')`
 * and throws. Metro reports an error thrown while initialising a module to the
 * global handler as well as to the caller, so the red box appears even though
 * the `catch` ran — and the half-initialised module stays in Metro's registry.
 *
 * So the native side is probed first with `requireOptionalNativeModule`, which
 * is built to answer `null` rather than throw. The JS wrapper is only required
 * once that probe says it is there.
 *
 * Nothing here keeps anything. The chosen number goes into the field the user
 * is already filling in, and the contact list is never copied, stored or sent.
 */

import { requireOptionalNativeModule } from 'expo-modules-core';

export type ContactPick =
  | { ok: true; phone: string; name: string | null }
  | { ok: false; reason: 'unavailable' | 'denied' | 'cancelled' | 'no-number'; message: string };

/**
 * Nigerian mobile numbers as the bill API wants them: 11 digits beginning 0.
 *
 * Contacts are stored every which way — `+234 803 512 4471`, `0803-512-4471`,
 * `234 803 512 4471` — and all three are the same number. A picker that hands
 * back `+2348035124471` and then fails validation is worse than no picker, so
 * the conversion happens here rather than being left to the caller.
 */
export function toLocalNigerianNumber(raw: string): string | null {
  const digits = raw.replace(/\D/g, '');
  if (digits.length === 11 && digits.startsWith('0')) return digits;
  // +234 / 234 prefix: drop it and restore the leading 0.
  if (digits.length === 13 && digits.startsWith('234')) return `0${digits.slice(3)}`;
  // Some contacts drop the leading zero entirely: 8035124471.
  if (digits.length === 10 && !digits.startsWith('0')) return `0${digits}`;
  return null;
}

export async function pickContactNumber(): Promise<ContactPick> {
  const unavailable: ContactPick = {
    ok: false,
    reason: 'unavailable',
    message: 'Choosing from contacts needs the next app update. Type the number for now.',
  };

  // Ask whether the native module is there WITHOUT loading the JS wrapper that
  // would throw if it is not.
  if (!requireOptionalNativeModule('ExpoContacts')) return unavailable;

  let Contacts: typeof import('expo-contacts');
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    Contacts = require('expo-contacts');
  } catch {
    return unavailable;
  }

  try {
    const { status } = await Contacts.requestPermissionsAsync();
    if (status !== 'granted') {
      return {
        ok: false,
        reason: 'denied',
        message: 'Veil has no access to your contacts. You can type the number instead.',
      };
    }

    const contact = await Contacts.presentContactPickerAsync();
    if (!contact) return { ok: false, reason: 'cancelled', message: '' };

    const numbers = contact.phoneNumbers ?? [];
    for (const entry of numbers) {
      const local = toLocalNigerianNumber(entry.number ?? '');
      if (local) return { ok: true, phone: local, name: contact.name ?? null };
    }

    return {
      ok: false,
      reason: 'no-number',
      message: numbers.length
        ? `${contact.name ?? 'That contact'} has no Nigerian mobile number saved.`
        : `${contact.name ?? 'That contact'} has no phone number saved.`,
    };
  } catch {
    return {
      ok: false,
      reason: 'unavailable',
      message: 'Could not open your contacts. You can type the number instead.',
    };
  }
}
