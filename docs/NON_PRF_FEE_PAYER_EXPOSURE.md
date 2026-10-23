# Exposure Analysis: WebAuthn Credential ID and Non-PRF Fee-Payer Derivation

**Date:** 2026-10-17  
**Status:** Documented and Mitigated  
**References:** ADR 0001 (`docs/adr/0001-two-account-model.md`), ADR 0003 (`docs/adr/0003-fee-payer-key-from-webauthn-prf.md`), `sdk/src/deriveFeePayer.ts`, `frontend/wallet/lib/feePayer.ts`, `frontend/mobile/lib/feePayerSource.ts`.

---

## 1. Executive Summary

Veil employs a two-account model:
1. A **smart wallet contract** on Soroban whose state and operations are authorized via P-256 WebAuthn signatures passed to the contract's `__check_auth` entrypoint.
2. An Ed25519 **fee-payer (sponsor) account** on Stellar classic (`G`-address) that signs and pays network transaction inclusion fees and provides base reserves.

Historically, the fee-payer keypair was derived deterministically as:
$$\text{seed} = \text{HKDF-SHA256}(\text{IKM}=\text{credentialId}, \text{salt}=\texttt{"veil:feepayer:salt:v1"}, \text{info}=\texttt{"veil:feepayer:ed25519:v1"})$$

Because a WebAuthn `credentialId` is treated by the W3C WebAuthn specification as a public identifier rather than a cryptographic secret, deriving a private spending key directly from it means that any entity able to inspect or obtain the credential ID can compute the private key without a biometric assertion.

This document establishes:
- The actual practical paths that the credential ID travels in the web wallet, mobile app, and client SDK.
- The distinction between theoretical ledger-level exposure and live client/origin-level exposure.
- The blast radius across smart-wallet contracts versus keypair-mode wallets.
- The mitigations implemented across the platform to ensure new wallets never derive spending keys from public values while ensuring existing legacy wallets on-chain remain fully functional.

---

## 2. Practical Exposure Paths of the Credential ID

An audit of `sdk/`, `frontend/wallet/`, and `frontend/mobile/` established the following concrete paths:

### Path 1: Enrolment / Registration Ceremony
- **Mechanism:** In `sdk/src/webauthn.ts` (`webAuthnProvider.create`), `frontend/wallet/app/page.tsx`, and `frontend/mobile/lib/passkey.ts`, the browser or operating system invokes `navigator.credentials.create()`.
- **Output:** The authenticator generates a new credential and returns a `PublicKeyCredential` object containing `credential.id` (a base64url-encoded string) and `credential.rawId` (an ArrayBuffer).
- **Exposure:** The credential ID is returned into unprivileged JavaScript memory in the browser tab or React Native runtime.

### Path 2: Client-Side Storage
- **Web Wallet:** In `sdk/src/core.ts` (`register()` and `recoverWithPasskey()`) and `frontend/wallet/lib/walletStorage.ts`, the credential ID is written directly to browser `localStorage` under the key:
  `invisible_wallet_key_id`
  (or prefixed with the network identifier, such as `veil_testnet_invisible_wallet_key_id`).
- **Mobile Wallet:** In `frontend/mobile/lib/walletStore.ts`, the credential ID is written to Expo `SecureStore` (`SecureKey.passkeyId`) and persisted in `AsyncStorage` under `invisible_wallet_key_id` by the SDK storage adapter.
- **Exposure:** In the web browser, `localStorage` is unencrypted and stored in plaintext within the browser user profile SQLite database on disk. Any script running in the application origin (such as through a Cross-Site Scripting vulnerability or a malicious third-party script), or any browser extension with storage or DOM permissions for the domain, can execute `localStorage.getItem('invisible_wallet_key_id')`.

### Path 3: WebAuthn Assertion Ceremonies (`allowCredentials`)
- **Mechanism:** On every passkey assertion ceremony—including unlocking the wallet in `frontend/wallet/app/lock/page.tsx`, signing transaction authorization entries in `sdk/src/core.ts` (`signAuthEntry`), or executing step-up passkey authentication in `frontend/wallet/lib/passkeyAuth.ts`—the credential ID is passed into the WebAuthn options structure:
  ```typescript
  navigator.credentials.get({
    publicKey: {
      challenge: challengeBuffer,
      allowCredentials: [{
        id: credentialIdBuffer,
        type: 'public-key',
      }],
      userVerification: 'required',
    }
  });
  ```
- **Exposure:** By W3C WebAuthn Level 1, 2, and 3 specifications, `allowCredentials` is explicitly a **public routing descriptor** informing authenticators which resident or non-resident key to invoke. It is visible to:
  - Browser developer tools (Console and Network/Security tabs).
  - Web extensions instrumenting or proxying the `navigator.credentials` JavaScript API.
  - Operating system authenticator interfaces (Apple iCloud Keychain, Google Password Manager, Windows Hello dialogs).

### Path 4: Multi-Device Sync and Roaming Authenticators
- **Mechanism:** When using synchronized passkeys (such as iCloud Keychain across iOS/macOS or Google Password Manager across Android/Chrome), the credential ID is synced through the passkey provider's cloud sync fabric to all authenticated devices belonging to that user.
- **Exposure:** The credential ID exists on every synced device within the passkey manager database.

---

## 3. Where the Credential ID Does NOT Travel

To establish whether remote or on-chain attacks are live or theoretical, the ledger, contracts, and network traffic were analyzed:

1. **Not on the Stellar Blockchain or Soroban Ledger:**
   - The Stellar transaction envelope submitted to Horizon contains the fee-payer Ed25519 signature and the Soroban invocation host function.
   - The Soroban `__check_auth` entry receives `clientDataJSON`, `authenticatorData`, and the P-256 ECDSA signature $(r, s)$.
   - Neither `clientDataJSON` nor `authenticatorData` contains the WebAuthn credential ID during an assertion (`navigator.credentials.get`).
   - The deployed factory contract `CAUK4MWO3TTFM6PLURSH2GPK3AB747SZGABKTCVLKCU7W2MGKHKP35GA` and deployed wallet contracts derive contract addresses strictly from the factory address, network passphrase, and the P-256 public key.
   - On-chain account recovery breadcrumbs (`frontend/mobile/lib/walletBreadcrumbs.ts`) store only `veil:pk1` and `veil:pk2` (the 64 public key coordinates). They never write the credential ID to `manage_data` entries.
2. **Not in Remote API Requests or Telemetry:**
   - Veil client applications do not transmit `invisible_wallet_key_id` to any backend server, RPC proxy, off-ramp provider, or analytics pipeline.
   - The encrypted backup envelope (`frontend/wallet/lib/backup.ts`) explicitly excludes `invisible_wallet_key_id` from the metadata payload.
3. **Not Accessible Across Relying Parties:**
   - WebAuthn enforces strict origin and Relying Party ID (`rpId`) partitioning. An external third-party domain cannot query or enumerate credentials created under the `veil.cash` RP ID.

---

## 4. Threat Assessment: Theoretical vs. Live

Based on the paths above, the vulnerability is classified as follows:

| Threat Vector | Exposure Level | Assessment |
|---|---|---|
| **Remote Ledger Observer** | Zero Exposure | **Theoretical.** An observer monitoring Horizon, Soroban RPC, or block explorers cannot observe the credential ID from on-chain data. They cannot reconstruct the legacy fee-payer key without out-of-band data. |
| **Cross-Origin / Third-Party Web** | Zero Exposure | **Theoretical.** WebAuthn browser isolation prevents other web domains from requesting or reading Veil's credential ID. |
| **Origin XSS / Malicious Dependency** | Cleartext Read | **LIVE.** Any JavaScript executing in the origin context can read `localStorage.getItem('invisible_wallet_key_id')`. Because `HKDF-SHA256` uses fixed parameters, the attacker can derive the fee-payer private key in microseconds with zero biometric confirmation. |
| **Browser Extension with Storage Access** | Cleartext Read | **LIVE.** Extensions with storage permissions or DOM content script injection can inspect `localStorage` and `allowCredentials`. |
| **Local Device / Backup Inspection** | Cleartext Read | **LIVE.** An attacker with access to the unencrypted browser profile SQLite files or device filesystem can extract the credential ID. |

---

## 5. Blast Radius Analysis

The consequence of reconstructing the fee-payer keypair differs fundamentally depending on the wallet architecture:

### A. Smart Wallet Contracts (Soroban Contract Addresses)
- **Impact:** Bounded to the fee-payer account.
- **Details:** User savings, tokens, and contract positions are held by the Soroban smart wallet contract. The contract requires authorization through `__check_auth`, which validates a live P-256 biometric signature produced inside the secure enclave/authenticator. The fee-payer account (Stellar G-address) holds only native XLM for transaction gas fees and base reserves. A compromised fee-payer key allows an attacker to drain the gas account, but **cannot** authorize contract calls or steal contract-held funds.

### B. Plain Keypair Wallets (Classic Stellar G-Accounts)
- **Impact:** Total loss of all funds.
- **Details:** In a plain keypair wallet (such as testnet keypair mode), the fee-payer account is the wallet account itself. If a keypair wallet were derived from the credential ID, an attacker reconstructing the key gains complete control over all assets held by the account.

### C. SPP Privacy Keys
- **Impact:** Catastrophic if unmitigated.
- **Details:** Stellar Private Payments (SPP) derives note keypairs (BN254) and encryption keypairs (X25519) from an Ed25519 signature over `Privacy Pool Key Derivation [v1]`. If the legacy credential-ID fee payer were permitted to produce this signature, private notes would be reconstructable by anyone who obtained the credential ID. This was mitigated by explicitly prohibiting `legacy` mode in `frontend/wallet/lib/privacy/keys.ts` (`preparePrivacySigner`).

---

## 6. Mitigation and Resolution

To eliminate deriving spending keys from public values while preserving access to funds in existing wallets:

1. **Passkey-Bound PRF for Supported Authenticators:**
   Where the authenticator supports the WebAuthn PRF extension (e.g. Safari on iOS, Chrome on macOS/Android with compatible authenticators), the fee-payer seed is derived from the high-entropy PRF output using `FEE_PAYER_PRF_SALT` (`invisible-wallet/prf/feepayer/v1`). The seed is held strictly in session memory and `sessionStorage`, never written to `localStorage`.
   
2. **Random Fallback for Non-PRF Authenticators:**
   Where the authenticator does not support PRF (such as non-Safari browsers on iOS or Android password managers without PRF), new wallets **stop deriving a spending key from the public credential ID**. Instead, the wallet generates a cryptographically secure random keypair (`Keypair.random()`, mode `'random'`). The key is persisted locally on the device (matching mobile's behavior in `frontend/mobile/lib/passkeyWallet.ts`) and cannot be reconstructed from the credential ID by any third party.

3. **On-Chain Existence Probe for Legacy Wallets:**
   To prevent stranding existing users whose fee-payer account was established under the legacy HKDF scheme before PRF and random fallback support were introduced, `frontend/wallet/lib/feePayer.ts` retains the legacy derivation candidate for on-chain probing:
   - When establishing a wallet without a pinned mode, `pickFundedCandidate` queries Horizon for all candidate addresses.
   - If Horizon reports that the legacy candidate account exists on-chain (`status: 'exists'`), the legacy account is selected and preserved.
   - If no candidate exists on-chain, a new wallet never selects `legacy`; it defaults to `prf-raw` (if PRF succeeded) or `random` (if PRF was unavailable).

4. **Updated Security Warnings:**
   `sdk/src/deriveFeePayer.ts`, `frontend/wallet/lib/deriveFeePayer.ts`, and `frontend/mobile/lib/deriveFeePayer.ts` have been updated to reflect current system reality, deprecating `deriveFeePayerKeypair` for any new wallet establishment.
