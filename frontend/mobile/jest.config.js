const expoPreset = require('jest-expo/jest-preset');

/**
 * Jest setup for the mobile app.
 *
 * `jest-expo` supplies the React Native transform, module mocks, and test
 * environment. The only change is the transform allow-list: `@noble/ciphers` and
 * `@noble/hashes` ship ESM only, and Jest cannot `require` them untransformed.
 * Metro handles them natively, so this affects tests alone.
 */
module.exports = {
  ...expoPreset,
  transformIgnorePatterns: expoPreset.transformIgnorePatterns.map((pattern) =>
    pattern.startsWith('/node_modules/(?!(') ? pattern.replace('(?!(', '(?!(@noble|') : pattern
  ),
};
