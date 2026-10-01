const expoPreset = require('jest-expo/jest-preset');

/**
 * Jest setup for the mobile app.
 *
 * `jest-expo` supplies the React Native transform, module mocks, and test
 * environment. The only change is the transform allow-list: `@noble/ciphers` and
 * `@noble/hashes` ship ESM only, and Jest cannot `require` them untransformed.
 * Metro handles them natively, so this affects tests alone.
 *
 * `setupFiles` appends `jest.setup.js` to the preset's own setup files rather
 * than replacing them, so the React Native and Expo environment stubs still
 * run first. It registers the AsyncStorage mock — see that file for why.
 */
module.exports = {
  ...expoPreset,
  setupFiles: [...expoPreset.setupFiles, '<rootDir>/jest.setup.js'],
  transformIgnorePatterns: expoPreset.transformIgnorePatterns.map((pattern) =>
    pattern.startsWith('/node_modules/(?!(') ? pattern.replace('(?!(', '(?!(@noble|') : pattern
  ),
  moduleNameMapper: {
    // The parity harness imports `frontend/wallet/lib/assets.ts`, which stays
    // import-free by design — but babel's expo preset still rewrites every
    // transformed module with `@babel/runtime` helper requires, and node's
    // walk-up from `frontend/wallet/lib/` never reaches this package's
    // node_modules (the wallet install is absent in the mobile-only CI job;
    // main's Mobile run is red with exactly this error since the expo bump).
    // Point those requires at our copy — the same package node resolution
    // already finds for our own files, so nothing else changes.
    '^@babel/runtime/(.+)$': '<rootDir>/node_modules/@babel/runtime/$1',
  },
};
