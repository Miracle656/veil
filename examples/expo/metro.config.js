const { getDefaultConfig } = require('expo/metro-config');
const path = require('path');

const config = getDefaultConfig(__dirname);

// Resolve invisible-wallet-sdk from the monorepo's sdk/ directory
// when running this example without publishing to npm.
config.resolver.extraNodeModules = {
  'invisible-wallet-sdk': path.resolve(__dirname, '../../sdk'),
};

// Ensure Metro resolves .native.ts before .ts for React Native
// (this is the default behaviour, but made explicit here for clarity).
config.resolver.sourceExts = ['native.ts', 'native.tsx', 'ts', 'tsx', 'js', 'jsx', 'json'];

module.exports = config;