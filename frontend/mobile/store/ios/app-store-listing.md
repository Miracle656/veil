# App Store listing — draft

Drafted now so iOS is a paperwork exercise once the account exists. **Not
submittable yet**: it needs an Apple Developer account and the
`associatedDomains` entry (`webcredentials:veil.app`) that makes passkeys resolve
(backlog #18).

## App information

- **Name** (30 max): `Veil: Stellar Wallet` — 20
- **Subtitle** (30 max): `Passkey, no seed phrase` — 23
- **Bundle ID**: `app.veil.wallet`
- **Primary category**: Finance
- **Secondary category**: Utilities
- **Age rating**: 17+ (unrestricted web access via WalletConnect and anchor flows)
- **Support URL**: https://veil.app
- **Privacy policy**: https://veil.app/privacy

## Promotional text (170 max) — 128

```
Your Stellar account, signed by the passkey already on your phone. Swap, earn on
Blend, and approve dApp requests with Face ID.
```

## Keywords (100 max, comma-separated, no spaces) — 91

```
stellar,xlm,soroban,passkey,wallet,crypto,defi,blend,swap,usdc,payments,web3,walletconnect
```

## Description (4000 max)

Reuse the Play full description verbatim from
[`../android/play-listing.md`](../android/play-listing.md) — the copy is
platform-neutral by design. Replace only the closing line: App Store review
rejects listings that read as promotional cross-links, so drop the GitHub URL
from the description body and put it in the support URL instead.

## Screenshots

Required sizes, same shot list as Android:

- 6.9" (1320×2868) — iPhone 16 Pro Max
- 6.5" (1242×2688) — fallback for older devices
- 13" iPad (2064×2752) — only if iPad is a declared destination; skip it and
  ship iPhone-only for the first release

## App Privacy answers

Same substance as the Play data safety table: no data collected by the
developer, no tracking, no third-party SDK identifiers. Declare the network
endpoints (Stellar RPC/Horizon, WalletConnect relay, Soroswap, Blend, SEP-24
anchors) as service providers.

## Review notes to include

- The app is non-custodial; there is no account to create and no Veil server. A
  reviewer can create a wallet with a device passkey and no credentials.
- Testnet build: assets have no monetary value. Fund the address from
  https://friendbot.stellar.org if the reviewer needs a balance.
- Guideline 3.1.1 does not apply — there are no in-app purchases of digital
  content; on- and off-ramp flows are SEP-24 handoffs to regulated anchors.

## Blocked on

- Apple Developer Program enrolment (backlog #18)
- `associatedDomains: ["webcredentials:veil.app"]` in `app.json` plus
  `apple-app-site-association` served from the domain
- An `ios` submit profile in `eas.json` (`ascAppId`, `appleTeamId`), which can
  only be filled once the account and App Store Connect record exist
