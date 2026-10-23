/** @type {import('@stryker-mutator/core').PartialStrykerOptions} */
const config = {
  packageManager: 'npm',
  reporters: ['progress', 'clear-text', 'json'],
  testRunner: 'jest',
  coverageAnalysis: 'perTest',
  mutate: ['src/utils.ts'],
  thresholds: { high: 80, low: 60, break: 0 },
  checkers: ['typescript'],
  tsconfigFile: 'tsconfig.json',
  jsonReporter: {
    fileName: 'reports/mutation/mutation.json',
  },
  jest: {
    projectType: 'custom',
    // This package keeps its jest config in package.json's "jest" key, and the
    // previous value here ('jest.config.js') named a file that does not exist —
    // the jest-runner require()d it inside every sandbox and threw
    // MODULE_NOT_FOUND before a single mutant ran (the six-for-six red streak).
    // The named file re-exports the package.json config with Stryker's
    // coverage-reporting jsdom environment, which perTest analysis requires.
    configFile: 'stryker-jest.config.cjs',
    enableFindRelatedTests: true,
  },
};

export default config;
