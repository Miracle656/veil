/** @type {import('jest').Config} */
const config = {
  preset: 'ts-jest',
  testEnvironment: 'jsdom',
  roots: ['<rootDir>'],
  testMatch: ['**/__tests__/**/*.test.ts', '**/tests/**/*.test.ts'],
  moduleFileExtensions: ['ts', 'tsx', 'js', 'jsx', 'json', 'node'],
  transform: {
    '^.+\\.tsx?$': ['ts-jest', {
      tsconfig: {
        jsx: 'react',
        esModuleInterop: true,
        allowSyntheticDefaultImports: true,
      },
    }],
    // stellar-sdk 17's runtime deps (@exodus/bytes, @noble/*, uint8array-extras,
    // smol-toml) and @scure/bip39 2.x are ESM-only; babel-jest converts them to
    // CJS. Config is inline (babelrc/configFile off) so no root babel config can
    // leak into the Next build.
    '^.+\\.jsx?$': ['babel-jest', {
      configFile: false,
      babelrc: false,
      presets: [['@babel/preset-env', { targets: { node: 'current' }, modules: 'commonjs' }]],
    }],
  },
  transformIgnorePatterns: [
    '[\\\\/]node_modules[\\\\/](?!.*(@exodus|@noble|uint8array-extras|smol-toml|@scure)[\\\\/])',
  ],
  // SDK source (compiled from ../../sdk/src) imports @stellar/stellar-sdk and
  // friends, but its sibling sdk/node_modules isn't installed in the wallet CI
  // job. Add the wallet's node_modules to the resolver search path (the jest
  // analog of next.config's resolve.modules prepend) so those imports resolve
  // to the wallet's copy through normal package resolution — a moduleNameMapper
  // would instead force a specific build and break jsdom's browser-field logic.
  modulePaths: ['<rootDir>/node_modules'],
  // Replicate tsconfig paths so Jest resolves workspace aliases
  moduleNameMapper: {
    // The app-root alias (`@/*` -> `./*` in tsconfig). Without this, any module
    // under test that imports a sibling via `@/lib/...` fails to resolve.
    '^@/(.*)$':         '<rootDir>/$1',
    '^@veil/utils$':    '<rootDir>/../../sdk/src/utils',
    '^@veil/sdk$':      '<rootDir>/../../sdk/src/index',
    '^@veil/events$':   '<rootDir>/../../sdk/src/events',
    '^@veil/recovery$': '<rootDir>/../../sdk/src/recovery/sep30',
    '^@veil/backup$':   '<rootDir>/../../sdk/src/backup',
    '^@veil/sep7$':     '<rootDir>/../../sdk/src/sep7',
    '^@veil/prf$':      '<rootDir>/../../sdk/src/crypto/prf',
    // The ONE dApp allow-list — mobile's module, imported by the web wallet
    // (see dappParity.test.ts, which pins this mapping to the real file).
    '^@veil/dapps$':    '<rootDir>/../mobile/lib/dappAllowlist',
  },
  // jsdom lacks TextEncoder/TextDecoder; the polyfills they need are installed
  // before any module loads, because uint8array-extras caches a TextEncoder at
  // import time and stellar-sdk 17 tests `instanceof Uint8Array` on its output.
  setupFiles: ['<rootDir>/jest.setup.ts'],
  setupFilesAfterEnv: [],
  collectCoverageFrom: [
    'lib/**/*.ts',
    '!lib/**/*.d.ts',
    '!lib/__tests__/**',
  ],
}

module.exports = config
