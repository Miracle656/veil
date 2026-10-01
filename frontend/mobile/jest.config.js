const expoPreset = require('jest-expo/jest-preset');

/**
 * Jest setup for the mobile app.
 *
 * `jest-expo` supplies the React Native transform, module mocks, and test
 * environment. The only change is the transform allow-list: `@noble/ciphers`,
 * `@noble/hashes`, and — since stellar-sdk 17 — `@exodus/bytes`,
 * `uint8array-extras`, and `smol-toml` ship ESM only, and Jest cannot `require`
 * them untransformed. Metro handles them natively, so this affects tests alone.
 *
 * `setupFiles` appends `jest.setup.js` to the preset's own setup files rather
 * than replacing them, so the React Native and Expo environment stubs still
 * run first. It registers the AsyncStorage mock — see that file for why.
 */
module.exports = {
  ...expoPreset,
  setupFiles: [...expoPreset.setupFiles, '<rootDir>/jest.setup.js'],
  transformIgnorePatterns: expoPreset.transformIgnorePatterns.map((pattern) =>
    pattern.startsWith('/node_modules/(?!(') ? pattern.replace('(?!(', '(?!(@noble|@exodus|uint8array-extras|smol-toml|') : pattern
  ),
  moduleNameMapper: {
    ...(expoPreset.moduleNameMapper ?? {}),
    // `registryParity.test.ts` imports `../wallet/lib/assets.ts` to compare the
    // two asset registries, which is the point of the test — a registry that
    // agrees with itself proves nothing.
    //
    // Babel rewrites that file's imports into `@babel/runtime/helpers/...`
    // requires, and Node resolves those relative to the file doing the
    // requiring. From `frontend/wallet/lib/` that means walking up through
    // `frontend/wallet/node_modules` and the repo root — neither of which the
    // CI mobile job installs, since it runs `npm ci` with
    // `working-directory: frontend/mobile`. So the suite fails to run on CI
    // while passing on any machine that happens to have the other workspaces
    // installed, which is exactly how it reached main green and then went red.
    //
    // Pinning the helpers to this package's own copy makes the resolution
    // independent of which workspace the importing file lives in.
    '^@babel/runtime/(.*)$': '<rootDir>/node_modules/@babel/runtime/$1',
  },
};
