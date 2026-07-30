const { getDefaultConfig } = require('expo/metro-config');
const path = require('path');

const projectRoot = __dirname;
const config = getDefaultConfig(projectRoot);

// Wire tsconfig `paths` into Metro so `@/components/*`, `@/*`, and
// `@/assets/*` resolve at runtime. The Expo SDK 57 Babel pipeline also
// honors `tsconfig.json` paths, but the alias guarantees the SSR/web
// bundler sees the same resolutions.
config.resolver.alias = {
  ...config.resolver.alias,
  '@/components': path.resolve(projectRoot, 'components'),
  '@/assets': path.resolve(projectRoot, 'assets'),
  '@': path.resolve(projectRoot, 'app'),
};

module.exports = config;
