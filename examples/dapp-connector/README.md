# Veil dApp Connector

A minimal reference implementation showing how a dApp can request transaction
signatures from the Veil wallet extension without ever seeing private key material.

## Architecture

```
dApp page  ──window.postMessage──▶  content-script (connector.js)
                                          │
                                          │ chrome.runtime.sendMessage
                                          ▼
                                    background (wallet)
                                    signs & returns result
                                          │
                                    chrome.runtime.onMessage
                                          │
                               ◀──window.postMessage──  content-script
dApp page receives result
```

The dApp only ever sends serialised transaction payloads (XDR blobs or JSON).
The private key never leaves the extension's background context.

## Files

| File | Purpose |
|---|---|
| `connector.js` | Content script injected into every page — bridges `window.veil` ↔ extension |
| `dapp/index.html` | Minimal reference dApp using the `window.veil` API |
| `dapp/app.js` | dApp logic: connect, sign_tx, display result |
| `manifest.json` | Chrome extension manifest (MV3) |

## API

The connector exposes a Promise-based API on `window.veil`:

```js
// Connect (returns the wallet's Stellar public key)
const { publicKey } = await window.veil.request({ method: 'connect' });

// Sign a transaction XDR
const { signedXdr } = await window.veil.request({
  method: 'sign_tx',
  params: { xdr: '<base64-encoded XDR>' }
});
```

## Running locally

```bash
# 1. Load the extension in Chrome
#    chrome://extensions → Load unpacked → select this directory

# 2. Open dapp/index.html in Chrome (file:// or a local server)
```