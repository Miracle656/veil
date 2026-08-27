/** @type {import('jest').Config} */
const config = {
  preset: 'ts-jest',
  testEnvironment: 'jsdom',
  roots: ['<rootDir>'],
  testMatch: ['**/__tests__/**/*.test.ts', '**/tests/**/*.test.ts'],
  moduleFileExtensions: ['ts', 'tsx', 'js', 'jsx', 'json', 'node'],
  resolver: './jest-resolver.cjs',
  transform: {
    '^.+\\.tsx?$': ['ts-jest', {
      tsconfig: {
        jsx: 'react',
        esModuleInterop: true,
        allowSyntheticDefaultImports: true,
      },
    }],
    '^.+\\.jsx?$': 'babel-jest',
  },
  transformIgnorePatterns: [
    '/node_modules/(?!(@stellar/js-xdr|@exodus|@noble)/)',
  ],
  modulePaths: ['<rootDir>/node_modules'],
  moduleNameMapper: {
    '^@/(.*)$':         '<rootDir>/$1',
    '^@veil/utils$':    '<rootDir>/../../sdk/src/utils',
    '^@veil/sdk$':      '<rootDir>/../../sdk/src/useInvisibleWallet',
    '^@veil/events$':   '<rootDir>/../../sdk/src/events',
    '^@veil/recovery$': '<rootDir>/../../sdk/src/recovery/sep30',
    '^@veil/backup$':   '<rootDir>/../../sdk/src/backup',
    '^@veil/sep7$':     '<rootDir>/../../sdk/src/sep7',
    '^@veil/prf$':      '<rootDir>/../../sdk/src/crypto/prf',
    // Mock ESM-only transitive deps to use native Node.js APIs
    '^uint8array-extras$': '<rootDir>/__mocks__/uint8array-extras.js',
  },
  setupFilesAfterEnv: [],
  collectCoverageFrom: [
    'lib/**/*.ts',
    '!lib/**/*.d.ts',
    '!lib/__tests__/**',
  ],
}

module.exports = config
