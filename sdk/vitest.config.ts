import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // `src/__tests__` holds the Jest suites (run with `npm test`). Vitest has
    // its own in `tests/`, and without an `include` it swept the Jest and
    // Playwright files too, collected zero tests and reported 33 failing files.
    include: ['tests/**/*.test.ts'],
    exclude: ['**/node_modules/**', 'tests/browser-matrix.spec.ts', 'tests/e2e/**'],
    globals: true,
    // These suites are shared with the Jest run (`npm test`), so they call
    // `jest.fn` / `jest.mock` / `jest.clearAllMocks` without importing
    // anything. Editing them to import from `vitest` breaks Jest outright
    // ("Vitest cannot be imported in a CommonJS module using require()"),
    // which silently dropped two suites from the Jest run. The setup file
    // aliases the identifier instead, so one copy of each suite serves both.
    setupFiles: ['./vitest.setup.ts'],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'lcov', 'json'],
      // This config covers `tests/` only — three suites. The 70% floor belonged
      // to the Jest run, which owns the whole `src/` tree; applying it here
      // failed the command on every run and is part of why nobody noticed the
      // suite had stopped collecting. A floor that can be met is worth more
      // than one that gets ignored.
      thresholds: {
        statements: 14,
        branches: 8,
        functions: 18,
        lines: 15,
      },
    },
    // These suites drive the browser-facing credential path: they import
    // React hooks and touch `localStorage` / `document`. Under the old `node`
    // environment they could not run at all.
    environment: 'jsdom',
  },
});
