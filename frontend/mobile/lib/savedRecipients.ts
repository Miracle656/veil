import AsyncStorage from '@react-native-async-storage/async-storage';

import { getNetworkName } from './network';

export type BankRecipient = {
  kind: 'bank';
  bankCode: string;
  bankName: string;
  accountNumber: string;
  accountName: string;
};

export type PhoneRecipient = {
  kind: 'phone';
  phoneNumber: string;
  network: string;
};

export type MeterRecipient = {
  kind: 'meter';
  meterNumber: string;
  provider: string;
  meterType: 'prepaid' | 'postpaid';
};

export type SavedRecipient = BankRecipient | PhoneRecipient | MeterRecipient;
export type RecipientKind = SavedRecipient['kind'];

export const SAVED_RECIPIENTS_KEY = 'veil_saved_recipients';

function storageKey(): string {
  return getNetworkName() === 'mainnet' ? `${SAVED_RECIPIENTS_KEY}_mainnet` : SAVED_RECIPIENTS_KEY;
}

function identity(recipient: SavedRecipient): string {
  switch (recipient.kind) {
    case 'bank':
      return `${recipient.kind}:${recipient.bankCode}:${recipient.accountNumber}`;
    case 'phone':
      return `${recipient.kind}:${recipient.phoneNumber}`;
    case 'meter':
      return `${recipient.kind}:${recipient.provider}:${recipient.meterType}:${recipient.meterNumber}`;
  }
}

export function addRecipient(list: SavedRecipient[], recipient: SavedRecipient): SavedRecipient[] {
  return [recipient, ...list.filter((item) => identity(item) !== identity(recipient))];
}

export function removeRecipient(
  list: SavedRecipient[],
  recipient: SavedRecipient
): SavedRecipient[] {
  return list.filter((item) => identity(item) !== identity(recipient));
}

export function listRecipients<K extends RecipientKind>(
  list: SavedRecipient[],
  kind: K
): Extract<SavedRecipient, { kind: K }>[] {
  return list.filter((item): item is Extract<SavedRecipient, { kind: K }> => item.kind === kind);
}

function isRecipient(value: unknown): value is SavedRecipient {
  if (!value || typeof value !== 'object') return false;
  const item = value as Record<string, unknown>;
  if (item.kind === 'bank')
    return ['bankCode', 'bankName', 'accountNumber', 'accountName'].every(
      (key) => typeof item[key] === 'string'
    );
  if (item.kind === 'phone')
    return typeof item.phoneNumber === 'string' && typeof item.network === 'string';
  if (item.kind === 'meter')
    return (
      typeof item.meterNumber === 'string' &&
      typeof item.provider === 'string' &&
      (item.meterType === 'prepaid' || item.meterType === 'postpaid')
    );
  return false;
}

async function loadFromKey(key: string): Promise<SavedRecipient[]> {
  const raw = await AsyncStorage.getItem(key);
  if (!raw) return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter(isRecipient) : [];
  } catch {
    return [];
  }
}

export function loadSavedRecipients(): Promise<SavedRecipient[]> {
  return loadFromKey(storageKey());
}

// Serialize writes so a quick save followed by a delete cannot restore stale data.
let pending: Promise<unknown> = Promise.resolve();

function update(change: (list: SavedRecipient[]) => SavedRecipient[]): Promise<SavedRecipient[]> {
  const key = storageKey();
  const next = pending
    .catch(() => undefined)
    .then(async () => {
      const list = change(await loadFromKey(key));
      await AsyncStorage.setItem(key, JSON.stringify(list));
      return list;
    });
  pending = next;
  return next;
}

export function saveRecipient(recipient: SavedRecipient): Promise<SavedRecipient[]> {
  return update((list) => addRecipient(list, recipient));
}

export function deleteRecipient(recipient: SavedRecipient): Promise<SavedRecipient[]> {
  return update((list) => removeRecipient(list, recipient));
}

export async function clearSavedRecipients(): Promise<void> {
  const key = storageKey();
  await pending.catch(() => undefined);
  await AsyncStorage.removeItem(key);
}
