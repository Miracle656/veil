import AsyncStorage from '@react-native-async-storage/async-storage';

import {
  SAVED_RECIPIENTS_KEY,
  addRecipient,
  clearSavedRecipients,
  deleteRecipient,
  listRecipients,
  loadSavedRecipients,
  removeRecipient,
  saveRecipient,
  type SavedRecipient,
} from '../savedRecipients';

const bank: SavedRecipient = {
  kind: 'bank',
  bankCode: '001',
  bankName: 'Example Bank',
  accountNumber: '0000000000',
  accountName: 'Sample Recipient',
};
const phone: SavedRecipient = {
  kind: 'phone',
  phoneNumber: '00000000000',
  network: 'Example Network',
};
const meter: SavedRecipient = {
  kind: 'meter',
  meterNumber: '000000000001',
  provider: 'EXAMPLE',
  meterType: 'prepaid',
};

beforeEach(async () => {
  await AsyncStorage.clear();
});

it('adds, lists, updates and removes one kind without changing the others', () => {
  const list = addRecipient(addRecipient(addRecipient([], bank), phone), meter);
  expect(listRecipients(list, 'bank')).toEqual([bank]);
  const updated = { ...bank, accountName: 'Updated Sample' };
  const replaced = addRecipient(list, updated);
  expect(listRecipients(replaced, 'bank')).toEqual([updated]);
  expect(removeRecipient(replaced, updated)).toEqual([meter, phone]);
});

it('persists and clears recipients on this device', async () => {
  await saveRecipient(bank);
  await saveRecipient(phone);
  await saveRecipient(meter);
  expect(await loadSavedRecipients()).toEqual([meter, phone, bank]);
  await deleteRecipient(phone);
  expect(listRecipients(await loadSavedRecipients(), 'phone')).toEqual([]);
  await clearSavedRecipients();
  expect(await AsyncStorage.getItem(SAVED_RECIPIENTS_KEY)).toBeNull();
});

it('ignores malformed local data', async () => {
  await AsyncStorage.setItem(SAVED_RECIPIENTS_KEY, '{bad json');
  expect(await loadSavedRecipients()).toEqual([]);
});
