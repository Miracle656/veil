# Veil Capacitor Mobile Wallet Example

> [!WARNING]
> **Demonstration only — not production-safe**
> This example generates extractable ECDSA keys via WebCrypto and stores the raw PKCS#8 private key hex in plaintext browser `localStorage` (`cap_priv_${credentialId}`). Any malicious script, XSS vulnerability, or physical device inspection can extract the private key. Production mobile applications must generate non-extractable keys inside hardware-backed keystores (such as Android Keystore or iOS Keychain / Secure Enclave) using native biometric authentication plugins.

A Capacitor 6 mobile wallet example for Veil demonstrating biometric authentication passkey flows on iOS and Android.

## Setup

```bash
# 1. Build the SDK (once)
cd ../../sdk && npm install && npm run build

# 2. Install dependencies
cd ../examples/capacitor
npm install
```

## Run

```bash
# Web development
npm run dev

# Mobile sync and run
npx cap sync
npx cap open android # or npx cap open ios
```
