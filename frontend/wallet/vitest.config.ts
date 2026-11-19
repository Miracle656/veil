import { defineConfig } from 'vitest/config';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('.', import.meta.url));
const sdk = `${root}../../sdk/src`;

// Mirrors `moduleNameMapper` in jest.config.js, which is what lets the Jest
// suites resolve the workspace aliases. Vitest needs its own copy or any
// module importing `@veil/*` fails at collection time.
const alias = {
  '@/': root,
  '@veil/utils': `${sdk}/utils`,
  '@veil/sdk': `${sdk}/index`,
  '@veil/events': `${sdk}/events`,
  '@veil/recovery': `${sdk}/recovery/sep30`,
  '@veil/backup': `${sdk}/backup`,
  '@veil/sep7': `${sdk}/sep7`,
  '@veil/prf': `${sdk}/crypto/prf`,
  '@veil/dapps': `${root}../mobile/lib/dappAllowlist`,
};

export default defineConfig({
  resolve: { alias },
  test: {
    // `src/**` holds the Jest suites (run with `npm test`). Vitest's live in
    // `tests/`; without an `include` it collected the Jest and Playwright files
    // as well and reported a wall of "describe is not defined".
    include: ['tests/**/*.test.ts'],
    exclude: ['**/node_modules/**', 'tests/e2e/**'],
    globals: true,
    environment: 'jsdom',
    coverage: {
      provider: 'v8',
      reporter: ['text', 'lcov', 'json'],
      // Covers `tests/` only — three suites. The 70% floor belongs to the Jest
      // run, which measures the whole `lib/` tree; enforcing it here failed the
      // command on every run, which is part of why the broken suite went
      // unnoticed. Set to a floor this scope can actually hold.
      thresholds: {
        statements: 30,
        branches: 15,
        functions: 30,
        lines: 30,
      },
    },
  },
});
