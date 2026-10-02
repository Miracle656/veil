# Veil Wallet

The Veil Wallet is a Progressive Web App (PWA) built with Next.js 14. It is the primary user-facing application for the Veil ecosystem — a passkey-powered smart wallet on Stellar Soroban where users authenticate with biometrics (Face ID, fingerprint, Windows Hello) instead of seed phrases or private keys.

**Live:** https://app.useveilapp.xyz

---

## How it works

Veil uses a **two-account model** on Stellar:

| Account | Type | Purpose |
|---|---|---|
| `C...` Wallet contract | Soroban smart contract | On-chain identity and auth layer. Holds XLM via the native SAC. Verified with WebAuthn passkey. |
| `G...` Fee-payer account | Classic Stellar account | Pays transaction fees and holds testnet XLM. Keypair stored in browser storage. |

Horizon only works with classic `G...` accounts — Soroban contract addresses (`C...`) cannot be loaded via `loadAccount`. All sends, swaps, and fee payments go through the fee-payer account. The wallet contract is queried separately via Soroban RPC.

---

## Project structure

```
frontend/wallet/
├── app/
│   ├── page.tsx               # Onboarding / registration entry point
│   ├── layout.tsx             # Root layout — fonts, metadata, PWA manifest
│   ├── globals.css            # Design tokens, utility classes, skeleton shimmer
│   ├── dashboard/             # Main wallet dashboard
│   ├── send/                  # Send XLM or tokens
│   ├── swap/                  # SDEX path payment swap
│   ├── receive/               # QR code receive screen
│   ├── agent/                 # AI agent chat (Claude via WebSocket)
│   ├── token/[code]/          # Individual token detail page
│   ├── contacts/              # Address book
│   ├── settings/              # App settings
│   ├── recover/               # Guardian recovery flow
│   ├── lock/                  # Inactivity lock screen
│   └── offline/               # PWA offline fallback
├── components/
│   ├── VeilLogo.tsx           # Animated SVG logo
│   ├── TxDetailSheet.tsx      # Bottom sheet — transaction detail overlay
│   ├── ContactPicker.tsx      # Address book selector modal
│   ├── QrScanner.tsx          # Camera-based QR code scanner
│   ├── OnboardingTutorial.tsx # First-run walkthrough overlay
│   └── WalletProvider.tsx     # React context — wallet address + signer key
├── hooks/
│   └── useInactivityLock.ts   # 5-minute inactivity timer — redirects to /lock
├── lib/
│   ├── passkeyAuth.ts         # Shared WebAuthn biometric gate (used before every tx)
│   └── txState.ts             # Mid-transaction lock guard (beginTx / endTx)
└── public/
    ├── tokens/
    │   ├── xlm.png            # XLM logo
    │   └── usdc.png           # USDC logo
    └── icons/                 # PWA icons (192×192, 512×512)
```

---

## Pages

### `/` — Onboarding
Registration and first-time setup. Creates a WebAuthn passkey credential on the device, derives a P-256 public key, and deploys the Soroban wallet contract via the factory. Stores the credential ID and wallet address in `localStorage`.

### `/dashboard` — Dashboard
The main home screen. Shows:
- **Total XLM balance** — combined contract (C...) + fee-payer (G...) balance
- **Assets list** — all tokens with logos, clickable to token detail pages
- **Activity feed** — merged Horizon payments + Wraith SAC transfer events, filterable by All / Transfers / Swaps
- **Action row** — Send, Receive, Swap, Agent shortcuts
- **Fee-payer recovery banner** — shown when browser storage was cleared, with a "Set up fee-payer" button

### `/send` — Send
Send XLM or tokens to any Stellar address (`G...` or `C...`).
- `G→G`: classic `Operation.payment` via Horizon
- `G→C`: SAC `transfer` via Soroban RPC
- Biometric passkey required before signing
- QR scanner for recipient address

### `/swap` — Swap
SDEX path payment swap using `pathPaymentStrictSend`.
- Fetches best path via Horizon strict-send path finder
- 0.5% slippage tolerance
- Auto-adds `changeTrust` if fee-payer doesn't have a trustline for the destination asset
- Biometric passkey required before signing

### `/receive` — Receive
Displays the wallet address as a QR code for easy scanning.

### `/agent` — AI Agent
Chat interface connected to the Veil Agent server via WebSocket. Claude can:
- Check XLM and token balances
- Fetch transfer history
- Look up live SDEX/AMM prices (via Lens oracle, x402 micropayment auto-paid)
- Build and propose swap transactions
- Build and propose payment transactions

All transactions built by the agent are returned unsigned to the UI. The user sees a preview card and must approve with Face ID / fingerprint before the transaction is signed and submitted.

### `/token/[code]` — Token Detail
Individual asset page. Shows:
- Token logo and total balance (header)
- **Balance breakdown** (XLM only) — separate rows for smart wallet (C...) and fee-payer (G...)
- Sparkline chart derived from transaction history
- Action buttons (Send, Receive, Swap)
- Transaction history filtered to the specific asset

### `/contacts` — Contacts
Address book. Save, edit, and delete named Stellar addresses. Used by the Send page's "Choose from contacts" picker.

### `/lock` — Lock Screen
Shown after 5 minutes of inactivity. Re-authenticates with the stored passkey credential before restoring the session. Reads `veil_signer_secret` from `localStorage` back into `sessionStorage`.

### `/recover` — Recovery
Guardian recovery flow. Initiates or completes a time-locked key recovery using a designated guardian address.

### `/settings` — Settings
App preferences and wallet management.

---

## Key behaviours

### Browser storage

| Key | Storage | Value |
|---|---|---|
| `invisible_wallet_address` | `localStorage` | `C...` wallet contract address |
| `invisible_wallet_key_id` | `localStorage` | WebAuthn credential ID (base64url) |
| `veil_signer_secret` | `localStorage` + `sessionStorage` | Fee-payer Ed25519 secret key |
| `veil_signer_public_key` | `localStorage` | Fee-payer public key |

`sessionStorage` is cleared on lock/tab close. `localStorage` persists across sessions. The lock screen restores `veil_signer_secret` from `localStorage` → `sessionStorage` on re-auth.

### Inactivity lock
`useInactivityLock` runs a 5-minute idle timer on every protected page. Activity (mouse, touch, keypress) resets the timer. If a transaction is in progress (`txActive` from `lib/txState.ts`), the lock is rescheduled 35 seconds out to avoid interrupting a signing flow.

### Passkey biometric gate
Every transaction (send, swap, agent approval) calls `requirePasskey()` from `lib/passkeyAuth.ts` before signing. This triggers a WebAuthn assertion with `userVerification: 'required'` — the OS will prompt Face ID, fingerprint, or PIN. If the user cancels, the signing code never runs.

### Cache-clear recovery
If the browser cache is cleared (wiping `localStorage`):
1. Dashboard shows a **"Signing key not found"** banner with a **"Set up fee-payer"** button
2. Tapping it generates a new fee-payer keypair, funds it via Friendbot, and stores it
3. Token pages fall back to `veil_signer_public_key` for read-only display
4. Swap and agent show clear error messages guiding the user back to the dashboard

> **Note:** XLM held in the old fee-payer G... account is unrecoverable after a cache clear — the private key existed only in browser storage. XLM held in the smart wallet contract (C...) is safe and persists on-chain.

---

## Tech stack

| | |
|---|---|
| Framework | Next.js 14 (App Router) |
| Language | TypeScript |
| Styling | CSS custom properties + utility classes (no Tailwind in production styles) |
| Stellar SDK | `@stellar/stellar-sdk` v14 |
| Wallet SDK | `invisible-wallet-sdk` (local package `../../sdk`) |
| PWA | `next-pwa` with offline fallback |
| Animations | `framer-motion` |
| QR codes | `qrcode.react` |
| Auth | WebAuthn / FIDO2 (ES256 / P-256), `navigator.credentials` |

---

## Environment variables

Set these in Vercel (or `.env.local` for local dev):

| Variable | Description |
|---|---|
| `NEXT_PUBLIC_NETWORK` | `testnet` or `mainnet` |
| `NEXT_PUBLIC_FACTORY_CONTRACT_ID_TESTNET` | Testnet factory contract address |
| `NEXT_PUBLIC_FACTORY_CONTRACT_ID_MAINNET` | Mainnet factory contract address |
| `NEXT_PUBLIC_FACTORY_CONTRACT_ID` | Legacy fallback for testnet-only setups |
| `NEXT_PUBLIC_HORIZON_URL` | Optional testnet Horizon override |
| `NEXT_PUBLIC_SOROBAN_RPC_URL` | Optional testnet Soroban RPC override |
| `NEXT_PUBLIC_MAINNET_RPC_URL` | Mainnet Soroban RPC provider URL |
| `NEXT_PUBLIC_WRAITH_URL` | Wraith indexer URL (transfer history) |
| `NEXT_PUBLIC_AGENT_WS_URL` | Veil Agent WebSocket URL |

---

## Running locally

```bash
# From the repo root
cd frontend/wallet
npm install
npm run dev
```

The wallet runs on `http://localhost:3000`.

> WebAuthn requires a secure context (`https://` or `localhost`). The passkey flows work on `localhost` out of the box during development.

### Typecheck

```bash
npm run typecheck
```

### Build

```bash
npm run build
npm start
```

---

## Deployment

Deployed on Vercel. Every push to `main` triggers an automatic deployment. The Vercel project is configured with all required environment variables.

PWA service worker and offline page are only active in production builds (`NODE_ENV=production`). The service worker is disabled in `next.config.js` when `NODE_ENV === 'development'` to avoid caching issues during local development.
