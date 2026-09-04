# Google Play listing — draft

Character limits are Play's; the counts below are the draft's actual length.

## Store presence

- **App name** (30 max): `Veil: Passkey Stellar Wallet` — 28
- **Package**: `app.veil.wallet`
- **Default language**: en-US
- **Category**: Finance
- **Tags**: Crypto, Wallet, Payments
- **Contact email**: `<fill in>`
- **Website**: https://veil.app
- **Privacy policy**: https://veil.app/privacy

## Short description (80 max) — 71

```
Stellar wallet secured by your device passkey — no seed phrase to lose.
```

## Full description (4000 max) — ~1730

```
Veil is a Stellar wallet with no seed phrase. Your account lives in a Soroban
smart contract, and the only key that can move funds is the passkey already on
your phone — protected by Face ID, fingerprint, or your device PIN.

Nothing to write down. Nothing to screenshot. Nothing to lose.

WHAT YOU CAN DO

• Send and receive XLM and Stellar assets, with contacts and QR codes
• Swap tokens at the best available route through Soroswap
• Earn yield by supplying assets to Blend lending pools
• Provide liquidity to pools and track your positions
• Buy and cash out through regulated on- and off-ramps (SEP-24)
• Approve transactions for web apps over WalletConnect
• Pay many recipients at once with bulk payouts
• Require multiple approvals for large transfers with multisig
• Keep an encrypted, passphrase-sealed backup of your wallet settings

HOW THE SECURITY WORKS

Every transaction is signed by your passkey. The signature covers the exact
authorization payload the wallet contract verifies on-chain — the biometric
prompt is the signature, not decoration around it. Your private key never leaves
the secure hardware on your device, and Veil never sees it.

Lost your phone? Recovery is bound to a fresh signer through SEP-30, with a
timelock, rather than a phrase that anyone who finds it can use.

BUILT FOR THE REAL WORLD

Queue a payment with no signal and Veil sends it when you reconnect. Lock the app
behind biometrics after a timeout you choose. Switch between light and dark to
match your system.

OPEN SOURCE

Veil is developed in the open. Read the contracts, the SDK, and this app:
https://github.com/Miracle656/veil

Veil is non-custodial. You hold your keys; we cannot move, freeze, or recover
your funds on your behalf.
```

## Release notes — first release (500 max)

```
First release. Passkey-signed Stellar wallet: send, receive, swap, earn on Blend,
provide liquidity, on- and off-ramp, WalletConnect approvals, bulk payouts,
multisig, and encrypted backups. Testnet build.
```

## Data safety declarations

Answer the Play form from what the code actually does:

| Question | Answer | Why |
| --- | --- | --- |
| Does the app collect or share user data? | No collection by the developer | No analytics or backend of ours; there is no Veil server |
| Financial info | Not collected | Balances are read from public Stellar RPC by the device |
| Device or other IDs | Not collected | — |
| Data encrypted in transit | Yes | HTTPS/WSS to Stellar RPC, Horizon, WalletConnect relay |
| Data deletion request path | Uninstall clears local state | Keys live in the OS keychain via `expo-secure-store` |
| Third parties contacted | Stellar RPC/Horizon, WalletConnect relay, Soroswap API, Blend, SEP-24 anchors | Disclose as service providers |

Note for review: no crash/analytics SDK ships in this build. Revisit if error
reporting is added — the web wallet's opt-in Sentry is not in the mobile app.

## Content rating

IARC questionnaire — expected outcome: everyone / no restricted content. Declare:
no user-generated content sharing, no ads, no gambling. Discloses financial
transactions (crypto), which is what triggers the financial-features form.

## Blocked on

- Play Console app creation and the App Signing SHA-256 fingerprint, which is what
  `assetlinks.json` must list (backlog #19) — passkeys will not resolve on a
  store-signed build until that file is live.
- Feature graphic and screenshots (see `../README.md`).
