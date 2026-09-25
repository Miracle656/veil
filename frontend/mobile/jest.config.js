const expoPreset = require('jest-expo/jest-preset');

/**
 * Jest setup for the mobile app.
 *
 * `jest-expo` supplies the React Native transform, module mocks, and test
 * environment. The only change is the transform allow-list: several dependencies
 * ship ESM only, and Jest cannot `require` them untransformed.
 * Metro handles them natively, so this affects tests alone.
 *
 * `setupFiles` appends `jest.setup.js` to the preset's own setup files rather
 * than replacing them, so the React Native and Expo environment stubs still
 * run first. It registers the AsyncStorage mock — see that file for why.
 */
module.exports = {
  ...expoPreset,
  transformIgnorePatterns: [
    '/node_modules/(?!(@exodus/bytes|@noble|uint8array-extras|.pnpm|react-native|@react-native|@react-native-community|expo|@expo|@expo-google-fonts|react-navigation|@react-navigation|@sentry/react-native|native-base))',
    '/node_modules/react-native-reanimated/plugin/',
  ],
  setupFiles: [...expoPreset.setupFiles, '<rootDir>/jest.setup.js'],
};
