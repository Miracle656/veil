---
"invisible-wallet-sdk": minor
---

Ship a real ESM build alongside the CommonJS one, and describe both truthfully.

Until now `main` and `module` both pointed at `dist/index.js`, which is
CommonJS, and no `exports` entry had an `import` or `require` condition, so
ESM and CommonJS consumers were handed the same CommonJS file (#1216). The
0.2.0 notes said the package shipped ESM; it did not.

- `dist/` is CommonJS (`"type": "commonjs"`, `main`, `require`).
- `dist/esm/` is ESM (`module`, `import`), with its own declarations, so
  TypeScript under `node16`/`nodenext` gets ESM types for ESM imports.
- `/angular` is ESM only. `@angular/core` ships only ESM, so a CommonJS build
  of the adapter could not load its own peer on Node before 20.19.
- The `react-native` condition still resolves to TypeScript source for Metro,
  and is now first in each entry so a resolver that also asserts
  `import`/`require` cannot pick `dist/` over it.
- `invisible-wallet-sdk/react` loads again: its build pointed at
  `dist/src/…`, which the post-build flattening had moved, so it threw
  `Cannot find module '../../src/useInvisibleWallet'` on import.
