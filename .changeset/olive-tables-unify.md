---
"invisible-wallet-sdk": minor
---

Consolidate React Native passkeys onto `react-native-passkeys` (breaking for RN consumers).

The SDK's native WebAuthn provider (`webauthn.native.ts`) previously required the
`react-native-passkey` package, while apps that also needed PRF assertions and
discoverable sign-in had to add `react-native-passkeys` — two libraries wrapping the
same platform API, pinning different `androidx.credentials` versions. `npm install
invisible-wallet-sdk` still works unchanged (both peers were optional), but React
Native installs must now provide `react-native-passkeys` instead of
`react-native-passkey`:

```bash
npm install react-native-passkeys
```

Registration now runs through `react-native-passkeys.create()`: same challenge/RP/user
encoding, same `extensions: { prf: {} }` PRF enrolment, same base64url SPKI, so the
derived P-256 public key — and therefore the wallet address — is byte-for-byte
unchanged. Assertions return `publicKeyBytes: null` explicitly (platform passkeys do
not expose the key on assertions; this matches the documented interface and the
previous native behaviour, which left it unset).
