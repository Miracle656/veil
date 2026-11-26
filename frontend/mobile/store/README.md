# Store submission

Drafts and build wiring for shipping Veil Mobile. Android goes first: its passkey
domain binding (`assetlinks.json`) is self-serve, so nothing blocks a build.
iOS waits on an Apple Developer account and the `associatedDomains` entry.

## Build profiles

`../eas.json` defines three:

| Profile | Distribution | Android artifact | Use |
| --- | --- | --- | --- |
| `development` | internal | APK | dev client, native debugging, Metro attached |
| `preview` | internal | APK | installable QA build shared by link/QR |
| `production` | store | AAB | Play upload, `autoIncrement` version code |

```bash
npm i -g eas-cli
eas login
eas init                    # writes extra.eas.projectId into app.json
eas build -p android --profile preview
```

`appVersionSource` is `remote`, so EAS owns `versionCode`/`buildNumber` and
`app.json` only carries the user-facing `version`. Bump `version` for a release;
never hand-edit a build number.

### Secrets

The profiles pin `EXPO_PUBLIC_NETWORK` only. Everything else is per-account and
belongs in EAS, not in the repo:

```bash
eas secret:create --scope project --name EXPO_PUBLIC_WC_PROJECT_ID --value <id>
eas secret:create --scope project --name EXPO_PUBLIC_PASSKEY_RP_ID --value veil.app
```

All three profiles build against **testnet**. Flip `EXPO_PUBLIC_NETWORK` in the
`production` profile only once mainnet contracts are deployed — a store build
pointed at contracts that do not exist is worse than no store build.

## Application id

`app.veil.wallet` for both platforms (`android.package`, `ios.bundleIdentifier`).
It is permanent once published — Play rejects a changed package name as a
different app.

## Listing drafts

- [`android/play-listing.md`](android/play-listing.md) — Google Play, ready to paste
- [`ios/app-store-listing.md`](ios/app-store-listing.md) — App Store, blocked on the Apple account

## Asset status

| Asset | Spec | Status |
| --- | --- | --- |
| App icon | 512×512 PNG, 32-bit, no alpha for Play | derive from `assets/images/icon.png` |
| Adaptive icon | foreground/background/monochrome | in repo, `app.json` |
| Feature graphic | 1024×500 PNG/JPEG, no alpha | **to produce** |
| Phone screenshots | 2–8, 9:16, 1080×1920 | **to capture** — see shot list below |
| Tablet screenshots | 7" and 10", optional | skip for first release |
| Promo video | YouTube URL, optional | skip for first release |

Screenshot shot list, in listing order — each one shows a capability the store
copy claims:

1. Dashboard with balances
2. Send, with the passkey prompt visible
3. Receive QR
4. Swap quote (Soroswap)
5. Earn positions and APYs (Blend)
6. dApp approval sheet (WalletConnect)

Capture from a `preview` build on a 1080×1920 device so the frames match what a
user installs.

## Pre-launch checklist

- [ ] `assetlinks.json` served at `https://veil.app/.well-known/assetlinks.json` with the Play App Signing SHA-256 (backlog #19)
- [ ] Play Console app created under the `app.veil.wallet` package
- [ ] Data safety form — see the declarations in the Android draft
- [ ] Content rating questionnaire (IARC)
- [ ] Financial features declaration: Play classifies a software wallet under **Crypto Exchanges and Software Wallets** and requires the form plus, in some regions, licensing evidence
- [ ] Privacy policy URL live
- [ ] Internal testing track release from the `production` profile before any public track
