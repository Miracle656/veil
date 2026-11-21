/**
 * Tests that run against a real Soroban network (testnet by default).
 *
 * Kept out of `npm test`: they need the network, friendbot and several minutes.
 * Run with `npm run test:network`. VEIL_NETWORK_RPC_URL, VEIL_NETWORK_PASSPHRASE
 * and VEIL_FRIENDBOT_URL point them at another network, a local quickstart for one.
 */
module.exports = {
    preset: 'ts-jest',
    testEnvironment: 'node',
    testMatch: ['<rootDir>/tests/network/**/*.network.test.ts'],
    testTimeout: 600_000,
    moduleNameMapper: {
        '^@stellar/stellar-sdk$': '<rootDir>/node_modules/@stellar/stellar-sdk',
    },
    transform: {
        '^.+\\.tsx?$': ['ts-jest', { isolatedModules: true, diagnostics: false }],
    },
};
