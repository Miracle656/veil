import { pickContactNumber, toLocalNigerianNumber } from '../pickContact';

// Stand in for a build compiled without expo-contacts. jest.mock is hoisted
// above the import regardless of where it is written, so this reads in the
// right order without tripping import/first.
jest.mock('expo-modules-core', () => ({ requireOptionalNativeModule: () => null }));

/**
 * Turning what is actually saved in someone's phone into what the bill API
 * accepts.
 *
 * Contacts are stored every which way, and all of these are one number. A
 * picker that hands back `+2348035124471` and then fails the screen's own
 * validation is worse than no picker: the user watches a number appear and be
 * rejected, with nothing to do about it.
 */
describe('toLocalNigerianNumber', () => {
  const EXPECTED = '08035124471';

  it('keeps a number that is already local', () => {
    expect(toLocalNigerianNumber('08035124471')).toBe(EXPECTED);
  });

  it('strips the spaces and dashes people type', () => {
    expect(toLocalNigerianNumber('0803 512 4471')).toBe(EXPECTED);
    expect(toLocalNigerianNumber('0803-512-4471')).toBe(EXPECTED);
    expect(toLocalNigerianNumber('(0803) 512 4471')).toBe(EXPECTED);
  });

  it('converts the international forms', () => {
    expect(toLocalNigerianNumber('+2348035124471')).toBe(EXPECTED);
    expect(toLocalNigerianNumber('+234 803 512 4471')).toBe(EXPECTED);
    expect(toLocalNigerianNumber('234 803 512 4471')).toBe(EXPECTED);
  });

  it('restores a dropped leading zero', () => {
    expect(toLocalNigerianNumber('8035124471')).toBe(EXPECTED);
  });

  it('refuses anything that is not a Nigerian mobile number', () => {
    // Null means "ask them to type it", which is the right outcome. Guessing
    // would put a wrong number in front of someone about to spend money on it.
    expect(toLocalNigerianNumber('')).toBeNull();
    expect(toLocalNigerianNumber('0803512')).toBeNull();
    expect(toLocalNigerianNumber('+44 7700 900123')).toBeNull();
    expect(toLocalNigerianNumber('080351244710000')).toBeNull();
  });

  it('does not mistake a landline-length string for a mobile', () => {
    // 10 digits starting with 0 is not the dropped-zero case, and is not 11.
    expect(toLocalNigerianNumber('0123456789')).toBeNull();
  });
});

/**
 * A build without the native module must answer, not crash.
 *
 * The first version required `expo-contacts` inside a `try`, which is not
 * enough: the require resolves, and the module's own top-level code throws from
 * `requireNativeModule('ExpoContacts')`. Metro reports that to the global
 * handler as well as to the caller, so a red box appeared on a tap even though
 * the catch had run. Probing with `requireOptionalNativeModule` first means the
 * wrapper is never loaded on a build that cannot support it.
 */
describe('on a build without ExpoContacts', () => {
  it('reports unavailable instead of throwing', async () => {
    const picked = await pickContactNumber();
    expect(picked.ok).toBe(false);
    if (!picked.ok) {
      expect(picked.reason).toBe('unavailable');
      // And says something the user can act on, rather than a module name.
      expect(picked.message).toMatch(/type the number/i);
    }
  });
});
