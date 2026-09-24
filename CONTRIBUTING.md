# Contributing to Veil

Thanks for your interest in Veil — a passkey-powered smart wallet on Stellar Soroban. Contributions of all sizes are welcome, from typo fixes to new features.

## Ways to contribute

- **Good first issues** — look for the [`good first issue`](https://github.com/Miracle656/veil/labels/good%20first%20issue) label for scoped, beginner-friendly tasks
- **Bug reports** — use the [bug report template](.github/ISSUE_TEMPLATE/bug_report.md)
- **Feature requests** — use the [feature request template](.github/ISSUE_TEMPLATE/feature_request.md)
- **Docs improvements** — typos, clarifications, examples are all welcome
- **Tests** — we're actively growing coverage; see [`area:tests`](https://github.com/Miracle656/veil/labels/area%3Atests)

## Repository layout

```
invisible_wallet/
├── contracts/          # Rust Soroban smart contracts (workspace)
│   ├── invisible_wallet/   # Main wallet contract — WebAuthn auth
│   └── factory/            # Factory for deploying new wallets
├── sdk/                # TypeScript client SDK
├── frontend/
│   ├── wallet/         # Next.js PWA — main user-facing wallet
│   ├── website/        # Marketing site
│   └── docs/           # Docs site
└── packages/
    ├── agent/              # Claude-powered AI agent (Node.js)
    └── create-veil-app/    # Project scaffolder
```

## Development setup

### Prerequisites
- **Rust** with `wasm32-unknown-unknown` target (contracts)
- **Node.js 20+** (SDK, wallet, agent)
- **Stellar CLI** (`stellar`) for deploying contracts
- A browser that supports WebAuthn (Chrome, Safari, Edge, Firefox)

### How installation works — one npm project per directory

**Veil is not an npm workspace.** Every JavaScript directory — `sdk/`,
`packages/*`, `frontend/*`, `examples/*` and the repo root — is a standalone npm
project with its own `package.json` and its own committed `package-lock.json`.
You install the one you are working on, in its own directory. There is no
top-level install that pulls in everything, and there is no hoisted
`node_modules` at the repo root.

That is deliberate. The packages disagree on major versions on purpose (the SDK
builds against `@stellar/stellar-sdk` 15 and TypeScript 6, the root smoke test
against 14 and TypeScript 5), the SDK's Jest config maps modules through
`<rootDir>/node_modules`, and Dependabot and every CI job are wired per package
lockfile. A root `workspaces` field flattened all of that into one tree and
rewrote the root lockfile from ~950 to ~21,000 lines on every fresh clone
([#670](https://github.com/Miracle656/veil/issues/670)), so it was removed.

Use **npm**. Do not use Yarn or pnpm — `pnpm-workspace.yaml` exists only to tell
Changesets which packages are publishable (npm ignores that file); it is not an
invitation to run `pnpm install`.

### Clone and install

```bash
git clone https://github.com/Miracle656/veil.git
cd veil

# Contracts
cd contracts && cargo build && cd ..

# SDK
cd sdk && npm install && npm run build && cd ..

# Wallet
cd frontend/wallet && npm install && cd ../..

# Agent
cd packages/agent && npm install && cd ../..
```

Each of those uses that directory's lockfile. On CI, and any time you want a
byte-exact install, use `npm ci` instead of `npm install`.

### The repo root

The root is its own small project. It installs only the release and changelog
tooling (Changesets, `conventional-changelog-cli`) plus the `@stellar/stellar-sdk`
that `scripts/smoke_test.ts` needs — nothing from `sdk/` or `packages/*`:

```bash
npm install        # or: npm ci
```

A root install **must leave `git status` clean**. If `package-lock.json` shows up
modified afterwards, something has desynced — check it before committing:

```bash
npm run verify:lockfile
```

That check asserts three things, and CI runs it in the `Repo root — install is
clean (#670)` job on every PR:

1. the root `package.json` declares no npm `workspaces`;
2. `npm ci` can install it — `package.json` and `package-lock.json` agree;
3. a plain `npm install` reproduces the committed lockfile byte for byte.

If you add or change a root dependency, run `npm install` at the root and commit
the resulting `package-lock.json` in the same change.

### Running the wallet locally

```bash
cd frontend/wallet
npm run dev
```

Open `http://localhost:3000`. WebAuthn requires a secure context, and `localhost` qualifies.

## Branch and commit conventions

- Branch from `main`: `git checkout -b feat/my-feature` or `fix/my-bug`
- Commit messages follow a loose [Conventional Commits](https://www.conventionalcommits.org/) style:
  - `feat(wallet): add recovery flow`
  - `fix(agent): derive feePayerAddress from secret`
  - `docs: update README`
  - `test(contracts): add WalletError enum coverage`
- Keep PRs focused — one logical change per PR

## Before opening a PR

Run the checks that apply to what you changed:

```bash
# Contracts
cd contracts && cargo fmt --all -- --check && cargo clippy --all-targets -- -D warnings && cargo test

# SDK
cd sdk && npx tsc --noEmit && npm test

# Wallet
cd frontend/wallet && npm run typecheck && npm run lint && npm run build

# Agent
cd packages/agent && npx tsc --noEmit && npm run build

# Repo root — only if you touched the root package.json or package-lock.json
npm run verify:lockfile
```

CI will run these on every PR — see `.github/workflows/ci.yml`.

## Code style

- **Rust**: `cargo fmt` and `cargo clippy` must pass
- **TypeScript**: no explicit style guide yet; match surrounding code. Prefer `const` over `let`, avoid `any`, use async/await over raw promises.
- **Comments**: only write comments that explain *why* — not what. Well-named identifiers should carry the meaning.
- **No emojis** in UI or code (brand rule)

## Testing guidance

- **Contracts** — unit tests live next to the code (`#[cfg(test)] mod tests`). Use the Soroban test harness.
- **SDK** — Jest tests in `sdk/__tests__` or alongside source as `*.test.ts`
- **Wallet** — end-to-end tests are still being set up; see [`area:tests`](https://github.com/Miracle656/veil/labels/area%3Atests) for tracked work
- **Agent** — unit tests for tool handlers, integration tests for WebSocket session

## Picking up an issue

1. Comment on the issue saying you'd like to work on it
2. Wait for a maintainer to assign it (usually within a day)
3. Open a draft PR early so we can give feedback as you go
4. Mark ready for review when CI is green

## Releasing packages

`sdk/` (`invisible-wallet-sdk`), `packages/agent` (`@veil/agent`) and
`packages/create-veil-app` are published with
[Changesets](https://github.com/changesets/changesets). If your change affects
one of them, describe the release from the repo root:

```bash
npm run changeset
```

Commit the generated file in `.changeset/`. On merge to `main`,
`.github/workflows/release.yml` opens or updates a "Version Packages" PR that
bumps the versions and changelogs.

Because each package owns its own lockfile, the version bump has to reach the
lockfile too — `npm run version-packages` runs `changeset version` and then
`scripts/sync-package-lockfiles.mjs`, which refreshes each package's
`package-lock.json` so the next `npm install` there is still a no-op.

The publishable package set lives in `pnpm-workspace.yaml`. That is the only
thing that file does: Changesets discovers packages through a workspace
manifest, npm does not read this one, and that separation is what keeps a root
`npm install` from hoisting the whole repo (#670).

## Generating release notes

`CHANGELOG.md` is updated automatically from commit messages via [`conventional-changelog-cli`](https://github.com/conventional-changelog/conventional-changelog).

### Setup

Install the root dev dependencies if you haven't already (from the repo root):

```bash
npm ci
```

### Running the script

After tagging a release (e.g. `git tag v0.2.0`), run from the repo root:

```bash
npm run release-notes
```

This prepends a new versioned section to `CHANGELOG.md` using the `angular` preset, which maps conventional-commit types to changelog categories:

| Commit type | Changelog section |
|---|---|
| `feat` | Features |
| `fix` | Bug Fixes |
| `perf` | Performance Improvements |
| `revert` | Reverts |
| `docs`, `style`, `chore`, `test` | omitted by default |

The script is defined in root `package.json` as:
```json
"release-notes": "conventional-changelog -p angular -i CHANGELOG.md -s"
```

Commit all changes to `CHANGELOG.md` as part of the release commit before pushing the tag.

## Questions

Open a [discussion](https://github.com/Miracle656/veil/discussions) or comment on an existing issue. We're friendly.
