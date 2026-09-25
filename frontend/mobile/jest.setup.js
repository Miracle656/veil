/**
 * Per-test-file setup, appended to the `jest-expo` preset's own setup files.
 *
 * `@react-native-async-storage/async-storage` is a native module: under Jest
 * there is no native runtime, so it resolves to `null` and every file that
 * imports it — directly or transitively — throws at import time, before a
 * single test runs. The package ships an official in-memory mock for exactly
 * this; registering it here is what lets those suites execute at all.
 */
jest.mock('@react-native-async-storage/async-storage', () => {
  try {
    return require('@react-native-async-storage/async-storage/jest/async-storage-mock')
  } catch {
    const store = new Map()
    return {
      getItem: jest.fn((k) => Promise.resolve(store.get(k) ?? null)),
      setItem: jest.fn((k, v) => { store.set(k, String(v)); return Promise.resolve(null) }),
      removeItem: jest.fn((k) => { store.delete(k); return Promise.resolve(null) }),
      clear: jest.fn(() => { store.clear(); return Promise.resolve(null) }),
      getAllKeys: jest.fn(() => Promise.resolve([...store.keys()])),
      multiGet: jest.fn((keys) => Promise.resolve(keys.map((k) => [k, store.get(k) ?? null]))),
      multiSet: jest.fn((pairs) => { pairs.forEach(([k, v]) => store.set(k, String(v))); return Promise.resolve(null) }),
    }
  }
});
