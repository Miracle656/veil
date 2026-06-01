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
    configFile: 'jest.config.js',
    enableFindRelatedTests: true,
  },
};

export default config;
