# Changelog

All notable changes to Veil are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).
New sections are generated automatically by `conventional-changelog-cli` — run `npm run release-notes` from the repo root after tagging a release. See [CONTRIBUTING.md](CONTRIBUTING.md#generating-release-notes) for details.

## [Unreleased]

### Added
- CI pipeline (`.github/workflows/ci.yml`) running contracts, SDK, wallet, and agent checks on every PR
- Contributor documentation (`CONTRIBUTING.md`), issue templates, and PR template
- This changelog

## [0.1.0] — 2025 testnet preview

### Added
- WebAuthn passkey authentication with P-256 key extraction and DER→raw signature parsing
- Soroban wallet contract with `WalletError` enum and 6 unit tests
- Factory contract for deploying user wallets
- TypeScript SDK (`invisible-wallet-sdk`) with `useInvisibleWallet` React hook
- Next.js PWA wallet at https://veil-ezry.vercel.app
  - Dashboard with combined contract + fee-payer XLM balance
  - Send (G→G classic payment, G→C SAC transfer)
  - Swap via SDEX `pathPaymentStrictSend` with auto-trustline
  - Receive screen with QR code
  - Token detail pages with balance breakdown and sparkline
  - Contacts, settings, recovery, and inactivity lock
- AI agent (`packages/agent`) with Claude tools for balance, transfers, price lookup, swap, and payment
- Biometric passkey approval required before every transaction
- Cache-clear recovery: "Signing key not found" banner and fallback flows
- Lens price oracle integration (x402 micropayments)
- Wraith SAC event indexer integration for incoming transfer history
- Marketing site at https://veil-mocha.vercel.app and docs site at https://veil-2ap8.vercel.app

[Unreleased]: https://github.com/Miracle656/veil/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/Miracle656/veil/releases/tag/v0.1.0
