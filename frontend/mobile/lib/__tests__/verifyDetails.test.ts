import AsyncStorage from '@react-native-async-storage/async-storage';

import { loadVerifyDetails, saveVerifyDetails } from '../onramp';

/**
 * What the verification screen is allowed to remember between attempts.
 *
 * A rejected NIN is the common case, because Linq matches the number against
 * the name — a middle name or a different spelling fails a NIN that is
 * perfectly correct. So the contact details come back on the next attempt.
 *
 * The NIN does not, and this file exists mostly to keep it that way.
 */
describe('verify details', () => {
  beforeEach(async () => {
    await AsyncStorage.clear();
  });

  const DETAILS = {
    firstName: 'Ebube',
    lastName: 'Ukpai',
    email: 'ebube@example.com',
    phone: '08035124471',
  };

  it('comes back exactly as it went in', async () => {
    await saveVerifyDetails(DETAILS);
    expect(await loadVerifyDetails()).toEqual(DETAILS);
  });

  it('never writes a NIN, whatever it is handed', async () => {
    // The NIN is personal data under the NDPA. It is sent once, kept by nobody,
    // and a stored copy would outlive the reason it was collected.
    await saveVerifyDetails({ ...DETAILS, nin: '70123456789' } as never);

    const raw = (await AsyncStorage.getItem('veil_ngn_details')) ?? '';
    expect(raw).not.toContain('70123456789');
    expect(raw).not.toContain('nin');

    expect(await loadVerifyDetails()).toEqual(DETAILS);
  });

  it('is null before anything has been saved', async () => {
    expect(await loadVerifyDetails()).toBeNull();
  });

  it('survives a corrupt blob rather than throwing on a screen mount', async () => {
    await AsyncStorage.setItem('veil_ngn_details', '{not json');
    expect(await loadVerifyDetails()).toBeNull();
  });

  it('fills missing fields with empty strings, never undefined', async () => {
    // A partial blob from an older build must not put `undefined` into a
    // TextInput, which React Native treats as uncontrolled.
    await AsyncStorage.setItem('veil_ngn_details', JSON.stringify({ firstName: 'Ebube' }));
    expect(await loadVerifyDetails()).toEqual({
      firstName: 'Ebube',
      lastName: '',
      email: '',
      phone: '',
    });
  });
});
