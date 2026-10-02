# Veil Elements — `<veil-button>`

A drop-in [custom element](https://developer.mozilla.org/en-US/docs/Web/API/Web_components)
that wraps the Invisible Wallet SDK. It works on any HTML page — including
no-build static sites — once the bundled script is loaded. No framework
required; it's a plain Web Component (vanilla, no Lit).

## Build

The element bundles the SDK into a single browser-loadable ESM file:

```bash
# from the repo root
cd sdk && npm install && npm run build   # build the SDK first
cd elements && npm install && npm run build
# → produces sdk/elements/dist/veil-button.js
```

## Usage

```html
<veil-button network="testnet" factory-address="C..." label="Create wallet"></veil-button>
<script type="module" src="./veil-button.js"></script>

<script>
  document.addEventListener('veil:success', (e) => {
    console.log('wallet address', e.detail.walletAddress)
  })
  document.addEventListener('veil:error', (e) => {
    console.error(e.detail.error)
  })
</script>
```

A complete page lives in [`examples/elements/index.html`](../../examples/elements/index.html).

## Attributes

| Attribute | Default | Description |
|---|---|---|
| `network` | `testnet` | `testnet` or `mainnet`; selects the network passphrase. |
| `factory-address` | _(empty)_ | Veil factory contract id (`C…`). Required to compute a real wallet address; registration still runs without it. |
| `rpc-url` | network default | Soroban RPC URL. |
| `username` | _(none)_ | Optional passkey username / display name. |
| `label` | `Create wallet with passkey` | Button text. |
| `disabled` | _(absent)_ | Present to disable the button. |

## Events

Both events bubble and cross the shadow boundary, so you can listen on `document`.

| Event | `detail` | When |
|---|---|---|
| `veil:success` | `{ walletAddress: string, publicKeyHex: string }` | A passkey was created and the wallet address computed. |
| `veil:error` | `{ error: string }` | Registration failed or was cancelled. |

## Notes

- WebAuthn requires a secure context — serve over `https://` or `http://localhost`.
- The button performs passkey **registration** (creates the credential and
  computes the address). Deploying the contract on-chain needs a funded
  fee-payer and is out of scope for a single drop-in button — see the
  framework examples (`examples/nextjs`, `examples/nuxt`, …) for the full flow.
