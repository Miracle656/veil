const expoPreset = require('jest-expo/jest-preset');

/**
 * Jest setup for the mobile app.
 *
 * `jest-expo` supplies the React Native transform, module mocks, and test
 * environment. The only change is the transform allow-list: several of the
 * Stellar SDK's dependencies ship ESM only, and Jest cannot `require` them
 * untransformed. Metro handles them natively, so this affects tests alone.
 *
 * `@noble/*` covers the hashing and cipher packages. `uint8array-extras`,
 * `smol-toml` and `@exodus/*` arrived with @stellar/stellar-sdk v17, whose XDR
 * layer imports them — without these, every suite that touches the SDK fails to
 * load with `SyntaxError: Unexpected token 'export'` from deep inside
 * `xdr/values/xdr-value.js`, which reads like a broken test rather than a
 * missing transform.
 *
 * `setupFiles` appends `jest.setup.js` to the preset's own setup files rather
 * than replacing them, so the React Native and Expo environment stubs still
 * run first. It registers the AsyncStorage mock — see that file for why.
 */
module.exports = {
  ...expoPreset,
  setupFiles: [...expoPreset.setupFiles, '<rootDir>/jest.setup.js'],
  transformIgnorePatterns: expoPreset.transformIgnorePatterns.map((pattern) =>
    pattern.startsWith('/node_modules/(?!(')
      ? pattern.replace('(?!(', '(?!(@noble|uint8array-extras|smol-toml|@exodus|')
      : pattern
  ),
};
