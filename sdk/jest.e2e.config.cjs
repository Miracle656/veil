/**
 * Jest config for the local-network end-to-end tests in `e2e/`.
 *
 * Separate from the unit-test config on purpose: these need a running Stellar
 * network and a built wallet wasm, so they must never run under a plain
 * `npm test`. Run them with `npm run test:e2e:local`.
 */
module.exports = {
  preset: 'ts-jest',
  testEnvironment: 'node',
  rootDir: '.',
  testMatch: ['<rootDir>/e2e/**/*.e2e.ts'],
  // Deploying contracts and waiting on ledgers is slow; each test sets its own timeout.
  testTimeout: 300000,
  // One network, one deployer: keep the suite serial.
  maxWorkers: 1,
  transform: {
    '^.+\\.ts$': [
      'ts-jest',
      {
        // Type-check the e2e code, unlike the unit config: this is the only
        // place these files are compiled.
        diagnostics: true,
        tsconfig: {
          strict: true,
          esModuleInterop: true,
          skipLibCheck: true,
          target: 'es2020',
          module: 'commonjs',
          lib: ['es2020', 'dom'],
          types: ['node', 'jest'],
        },
      },
    ],
  },
};
