import AsyncStorage from '@react-native-async-storage/async-storage';

/**
 * The core vocabulary for a money action that has been signed
 * (after the passkey ceremony) but whose result we cannot prove.
 *
 * The distinction matters: "failed" is a claim that the user was not
 * charged. If the network drops after the transaction has been submitted
 * (but before we read the result), the user may already have been
 * charged. The honest state is "unconfirmed".
 */

export type UnconfirmedKind = 'airtime' | 'payment' | 'transfer';

export interface UnconfirmedAction {
  /** Stable identifier for this action (used as the storage key). */
  id: string;
  /** Which money screen initiated the action. */
  kind: UnconfirmedKind;
  /** The transaction hash we submitted, if we reached that point. */
  hash?: string;
  /** Human-readable summary of what was attempted. */
  summary: string;
  /** Iso timestamp of when the action was signed. */
  createdAt: string;
  /** Network passphrase the action was submitted on. */
  networkPassphrase?: string;
}

export type Resolution =
  | { status: 'confirmed'; action: UnconfirmedAction; hash?: string }
  | { status: 'failed'; action: UnconfirmedAction; reason: string }
  | { status: 'unknown'; action: UnconfirmedAction; reason: string };

const STORAGE_KEY = 'veil.unconfirmed.v1';

async function readRaw(): Promise<UnconfirmedAction[]> {
  try {
    const raw = await AsyncStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(
      (item): item is UnconfirmedAction =>
        typeof item?.id === 'string' &&
        typeof item?.kind === 'string' &&
        typeof item?.summary === 'string' &&
        typeof item?.createdAt === 'string',
    );
  } catch {
    return [];
  }
}

async function writeRaw(actions: UnconfirmedAction[]): Promise<void> {
  await AsyncStorage.setItem(STORAGE_KEY, JSON.stringify(actions));
}

/** List every action we cannot yet prove the outcome of. */
export async function listUnconfirmed(): Promise<UnconfirmedAction[]> {
  return readRaw();
}

/** Record an action as unconfirmed. Id is upserted. */
export async function markUnconfirmed(
  action: Omit<UnconfirmedAction, 'createdAt'> & { createdAt?: string },
): Promise<UnconfirmedAction> {
  const record: UnconfirmedAction = {
    ...action,
    createdAt: action.createdAt ?? new Date().toISOString(),
  };
  const existing = await readRaw();
  const next = existing.filter(item => item.id !== record.id);
  next.push(record);
  await writeRaw(next);
  return record;
}

/** Remove an action once its outcome is known. */
export async function clearUnconfirmed(id: string): Promise<void> {
  const existing = await readRaw();
  await writeRaw(existing.filter(item => item.id !== id));
}

/**
 * The message we show the user when an action is unconfirmed.
 * This is the exact wording the issue asks for: the person has
 * possibly paid, and the screen must say exactly that.
 */
export const UNCONFIRMED_MESSAGE =
  'We lost the network mid-action. You may already have been charged — we are resolving this now.';

export const UNCONFIRMED_OFFLINE_MESSAGE =
  'You are offline. You may already have been charged for this action. We will resolve it when you reconnect — do not retry until then.';

export const UNCONFIRMED_RESOLVED_MESSAGE =
  'Reconnected. We checked your unconfirmed action and resolved it.';
