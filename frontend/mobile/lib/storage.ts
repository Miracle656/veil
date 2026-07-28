/**
 * Storage abstraction for the Veil mobile app.
 *
 * In production this should be backed by expo-secure-store for secrets.
 * For now we use a simple in-memory map so the app can be developed
 * and tested without native module linking.
 */

const store = new Map<string, string>();

export async function getItem(key: string): Promise<string | null> {
  return store.get(key) ?? null;
}

export async function setItem(key: string, value: string): Promise<void> {
  store.set(key, value);
}

export async function removeItem(key: string): Promise<void> {
  store.delete(key);
}

export async function clear(): Promise<void> {
  store.clear();
}
