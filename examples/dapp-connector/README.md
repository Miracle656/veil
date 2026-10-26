# Veil dApp Connector — SEP-43 Standard Reference

A reference implementation showing how a Stellar dApp interacts with the Veil wallet via **SEP-0043** (Standard Web Wallet API Interface) without bespoke adapters or seeing private key material.

## Architecture

```
dApp page  ──window.stellar.veil──▶  connector.js (content-script)
                                            │
                                            │ chrome.runtime.sendMessage
                                            ▼
                                      background (wallet)
                                      signs & returns result
                                            │
                                            │ chrome.runtime.onMessage
                                            ▼
dApp page receives SEP-43 response ◀──connector.js
```

The dApp only interacts with the standard SEP-43 methods. The private key material never leaves the user's secure WebAuthn authenticator context.

## Files

| File | Purpose |
|---|---|
| `connector.js` | Content script injected into pages — exposes `window.stellar.veil` & `window.veil` |
| `dapp/index.html` | Reference dApp UI driving the standard SEP-43 interface |
| `dapp/app.js` | dApp logic: `getAddress`, `getNetwork`, `signTransaction`, `signAuthEntry`, `signMessage` |
| `manifest.json` | Chrome extension manifest (MV3) |

## SEP-43 API

The provider is exposed under `window.stellar.veil` (and `window.veil`):

```js
const provider = window.stellar.veil;

// 1. Get Address
const { address } = await provider.getAddress();

// 2. Get Network
const { network, networkPassphrase } = await provider.getNetwork();

// 3. Sign Transaction
const { signedTxXdr, signerAddress } = await provider.signTransaction(txXdr, {
  networkPassphrase,
  address,
  submit: false,
});

// 4. Sign Soroban Auth Entry
const { signedAuthEntry } = await provider.signAuthEntry(authEntryXdr, {
  networkPassphrase,
  address,
});

// 5. Sign Message
const { signedMessage } = await provider.signMessage("Hello Stellar Testnet", {
  address,
});
```

## Running locally

```bash
# 1. Load the extension in Chrome
#    chrome://extensions → Load unpacked → select this directory

# 2. Open dapp/index.html in Chrome (file:// or a local server)
```