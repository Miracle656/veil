/**
 * Per-test-file setup, appended to the `jest-expo` preset's own setup files.
 *
 * `@react-native-async-storage/async-storage` is a native module: under Jest
 * there is no native runtime, so it resolves to `null` and every file that
 * imports it — directly or transitively — throws at import time, before a
 * single test runs. The package ships an official in-memory mock for exactly
 * this; registering it here is what lets those suites execute at all.
 */
jest.mock('@react-native-async-storage/async-storage', () =>
  require('@react-native-async-storage/async-storage/jest/async-storage-mock')
);
