const expoPreset = require('jest-expo/jest-preset');

/**
 * Jest setup for the mobile app.
 *
 * `jest-expo` supplies the React Native transform, module mocks, and test
 * environment. Two changes on top of the preset, both affecting tests alone
 * (Metro resolves both packages natively at bundle time):
 *
 * 1. The transform allow-list: `@noble/ciphers` and `@noble/hashes` ship ESM
 *    only, and Jest cannot `require` them untransformed.
 *
 * 2. `moduleNameMapper` points `expo-asset` at the copy nested under
 *    `node_modules/expo/`. `expo-font` imports `expo-asset` in its module
 *    body, but npm only nests `expo-asset` under `expo` (the package that
 *    actually declares the dependency), so plain Node resolution from
 *    `expo-font` fails with MODULE_NOT_FOUND — and every suite that reaches
 *    `theme/typography.ts` → `@expo-google-fonts/*` → `expo-font` died at
 *    import time, before a single test ran. Mapping the specifier past the
 *    nesting is the test-environment fix; the app bundle was never broken.
 *
 * `setupFiles` appends `jest.setup.js` to the preset's own setup files rather
 * than replacing them, so the React Native and Expo environment stubs still
 * run first. It registers the AsyncStorage mock — see that file for why.
 */
module.exports = {
  ...expoPreset,
  moduleNameMapper: {
    ...expoPreset.moduleNameMapper,
    '^expo-asset$': require.resolve('expo/node_modules/expo-asset'),
  },
  setupFiles: [...expoPreset.setupFiles, '<rootDir>/jest.setup.js'],
  transformIgnorePatterns: expoPreset.transformIgnorePatterns.map((pattern) =>
    pattern.startsWith('/node_modules/(?!(') ? pattern.replace('(?!(', '(?!(@noble|') : pattern
  ),
};
