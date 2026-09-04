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
  },
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
  },
  setupFilesAfterEnv: [],
  collectCoverageFrom: [
    'lib/**/*.ts',
    '!lib/**/*.d.ts',
    '!lib/__tests__/**',
  ],
}

module.exports = config
