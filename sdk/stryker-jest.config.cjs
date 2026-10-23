/**
 * Jest config for Stryker runs only (named by stryker.conf.mjs).
 *
 * It is the package.json "jest" config verbatim, with one change: the test
 * environment is Stryker's coverage-reporting equivalent of jsdom, which
 * `coverageAnalysis: 'perTest'` requires. Kept out of package.json so a plain
 * `npm test` keeps using stock jsdom. Test files that pin their environment
 * with a `@jest-environment` docblock name Stryker's node equivalent directly,
 * since a docblock outranks any config file.
 */
const pkg = require('./package.json')

module.exports = {
  ...pkg.jest,
  testEnvironment: '@stryker-mutator/jest-runner/jest-env/jsdom',
}
