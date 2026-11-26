---
"invisible-wallet-sdk": patch
---

Mark `react` and `@tanstack/react-query` as optional in `peerDependenciesMeta`
so non-React consumers (`/vanilla`, `/vue`, `/svelte`, `/solid`, `/angular`) do
not have React installed automatically by npm 7+.
