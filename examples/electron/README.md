# Veil Electron Wallet Example

A minimal Electron desktop wallet example that runs the Veil **web** SDK
unmodified in the renderer process — no native plugin, no IPC bridge for
crypto. Registration, signing, and sending all use standard
`navigator.credentials` / `crypto.subtle` Web APIs, exactly as they would in
a browser tab.

## Prerequisites

- Node.js 18+
- A deployed Veil factory contract address
- A WebAuthn-capable authenticator: a platform authenticator (Touch ID,
  Windows Hello) or a USB FIDO2 security key

## Setup

From the repository root, build the SDK so the example can consume the local
package:

```bash
cd sdk
npm install
npm run build
```

Install the example's dependencies:

```bash
cd examples/electron
npm install
```

Create a `.env` file in `examples/electron` with:

```env
VITE_FACTORY_ADDRESS=YOUR_FACTORY_ADDRESS
VITE_RPC_URL=https://soroban-testnet.stellar.org
VITE_HORIZON_URL=https://horizon-testnet.stellar.org
VITE_NETWORK_PASSPHRASE=Test SDF Network ; September 2015
VITE_FRIENDBOT_URL=https://friendbot.stellar.org
```

The app will still register passkeys and perform local signing without a
factory address, but on-chain deployment requires a valid factory contract.

## Run

```bash
npm run dev
```

This starts the Vite dev server on `http://localhost:5174` and launches
Electron pointed at it.

## Build

```bash
npm run build
npm start
```

`build` compiles the renderer with Vite into `dist/`. `start` launches
Electron, which serves `dist/` over a local HTTP server (`http://localhost:5180`)
and loads it — see "Why a local HTTP server" below.

## WebAuthn caveats

Electron bundles Chromium and exposes the same `navigator.credentials` APIs
as a browser, but the desktop-app context introduces a few gotchas that
don't show up in the Vite/Next.js web examples:

- **`file://` does not work.** Chromium only treats WebAuthn as available in
  a [secure context](https://developer.mozilla.org/en-US/docs/Web/Security/Secure_Contexts),
  and `file://` pages are not secure contexts. Loading `dist/index.html`
  directly with `BrowserWindow.loadFile()` will leave `navigator.credentials`
  `undefined`. This example works around it by serving the renderer over
  plain HTTP on `localhost` in both dev (Vite's own dev server) and
  production (a tiny static server started in [`electron/main.cjs`](electron/main.cjs)) —
  `localhost` is special-cased as secure even over plain HTTP.
- **The relying party ID is tied to the hostname you load from.** Because the
  app is always served from `localhost`, `rpId` stays stable across dev and
  production. If you change the loading strategy (e.g. a custom
  `app://` protocol), the effective domain changes too, and any passkeys
  registered under the old origin stop being usable.
- **`localStorage` is scoped per origin (host *and* port).** The dev server
  (`:5174`) and the production static server (`:5180`) are different origins,
  so a wallet registered while running `npm run dev` will not appear when you
  run `npm start`, and vice versa. This is expected — it mirrors how a
  passkey registered on `localhost:3000` isn't visible on `localhost:4000`
  in a regular browser either.
- **The biometric prompt is native OS UI, not Electron UI.** Touch ID,
  Windows Hello, and security-key prompts are drawn by the OS outside the
  `BrowserWindow`. If a prompt never appears, check the platform notes below
  before assuming the SDK call failed.
- **macOS:** platform-authenticator (Touch ID) prompts from an Electron app
  generally require the app bundle to be signed; unsigned dev builds may
  silently fail to trigger Touch ID. A USB security key works regardless of
  signing.
- **Windows:** Windows Hello must be enrolled, and some managed/corporate
  devices disable it entirely — a USB security key is the fallback.
- **Linux:** there is no platform-authenticator integration in Chromium on
  Linux (no Touch ID/Windows Hello equivalent), so registration requires an
  external USB FIDO2 security key.
- **`contextIsolation`/`sandbox` stay on.** `navigator.credentials` and
  `crypto.subtle` are standard renderer-side Web APIs — they work fine with
  `nodeIntegration: false` and `contextIsolation: true` and don't need to be
  exposed through the preload script's `contextBridge`.

## Notes

- [`electron/main.cjs`](electron/main.cjs) creates the `BrowserWindow` and
  decides whether to load the Vite dev server or the built `dist/` output.
- [`electron/preload.cjs`](electron/preload.cjs) only exposes Electron/Chromium
  version info for display in the Dashboard — it does not bridge any wallet
  or crypto logic, since none of that needs main-process privileges.
- The `src/` renderer code mirrors the Vite + React starter's three routes
  (`register`, `dashboard`, `send`) so the two examples stay easy to compare.
