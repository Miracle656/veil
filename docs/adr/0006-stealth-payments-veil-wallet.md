# ADR 0006 — Stealth Payments to Veil Wallets: Decorrelated Sweep and Linkage Architecture

| Field     | Value                      |
|-----------|----------------------------|
| Status    | Accepted                   |
| Date      | 2026-11-25                 |
| Deciders  | Veil core team             |

---

## Context

On Stellar, stealth addressing and smart contract wallets live in two entirely different cryptographic domains:

1. **Stealth Addressing (Ed25519 Scalar Arithmetic)**:
   A stealth payment derives a one-time public key using Ed25519 curve point operations:
   $$P = S + \text{scalar}(H(r \cdot V)) \cdot G$$
   The corresponding spending key is:
   $$p = s + \text{scalar}(H(r \cdot V)) \pmod L$$
   The resulting address is a classic Stellar account address starting with `G` (a 56-character Ed25519 public key, such as `GDZX4M24GBL77E6V7TFFWJ6W6O6Q2UPL2H6XGY3BGYUDF63L45WGFK4W`).

2. **Veil Smart Wallet (Soroban Smart Contract)**:
   A Veil wallet is not an Ed25519 keypair. It is a Soroban smart contract at a contract address starting with `C` (a 56-character contract ID, such as `CAUK4MWO3TTFM6PLURSH2GPK3AB747SZGABKTCVLKCU7W2MGKHKP35GA`). Its address is deterministically calculated by the wallet factory from the user's WebAuthn P-256 (secp256r1) passkey and salt. Authorization is enforced through the contract's `__check_auth` entrypoint verifying ECDSA P-256 signatures over transaction authentication envelopes.

Because an Ed25519 scalar cannot be added to a Soroban contract address or to a secp256r1 passkey public key, **a stealth payment cannot land directly in a Veil wallet**. It necessarily lands at an ephemeral Ed25519 one-time address (either as a direct payment or as a CAP-23 claimable balance).

To make these funds spendable by the user's Veil wallet through standard passkey authentication, the funds must move into the contract address. However, moving the funds creates an on-chain trace. If a payment arrives at a one-time address at 14:02:00 and is swept into the user's contract address at 14:02:05, any observer watching the public ledger can correlate the two events with near-certainty through temporal linkage.

---

## Architectural Options Evaluated

Three distinct architectural paths were evaluated to bridge funds from ephemeral stealth addresses into Veil wallets:

### Option 1: Immediate Sweep into the Contract Address
- **Description**: As soon as a stealth payment is detected or claimed at the one-time address, the wallet client immediately constructs, signs, and submits a transaction transferring the full balance into the user's contract address.
- **Evaluation**:
  - *Usability*: Fast; funds appear in the user's contract within seconds.
  - *Privacy*: Catastrophic failure of privacy. Immediate temporal correlation allows any passive observer or indexer to link the stealth payment directly to the recipient's main contract address ($G_{\text{stealth}} \to C_{\text{veil}}$ in the same or adjacent ledger close). A feature promising privacy while linking the payment five seconds later betrays user expectations.
- **Verdict**: **Rejected**.

### Option 2: Hold at the One-Time Address and Spend Directly (UTXO-Style Account Splitting)
- **Description**: The wallet does not sweep funds to the contract address. Instead, the client retains the one-time private key $p$ indefinitely. When the user spends funds, the wallet constructs transactions spending directly from the accumulated pool of one-time classic accounts.
- **Evaluation**:
  - *Dual Custody Violation*: Veil's core security model is smart contract account abstraction governed by hardware WebAuthn passkeys (`__check_auth`), multi-signer rotation, daily spending limits, and emergency guardians. Bypassing the contract forces the wallet into a hybrid model where raw Ed25519 private keys exist in client software storage with neither passkey protection nor contract guardrails.
  - *Exorbitant Classic Reserve Overhead*: On Stellar Classic, an account requires a minimum base reserve of 2 × 0.5 = 1.0 XLM, plus 0.5 XLM for each trustline (e.g. USDC). Retaining 10 separate stealth payments across 10 distinct classic accounts locks up to 15.0 XLM in non-spendable network reserves alone.
  - *Backup & Synchronization Hazards*: Veil's cloud backup protocol (`@veil/backup`) guarantees zero-private-key metadata backups (address, public keys, signer set, and settings). Storing an ever-expanding collection of ephemeral Ed25519 private keys either breaks the zero-private-key cloud backup invariant or leaves stealth funds unrecoverable across devices.
  - *Balance Fragmentation*: Spending arbitrary amounts requires complex multi-account transaction aggregation and higher fee multipliers.
- **Verdict**: **Rejected**.

### Option 3: Decorrelated Sweep with Randomized Delay and User Agency (Chosen Architecture)
- **Description**:
  1. When a stealth payment arrives at or is claimed by the one-time address, it is queued in local storage (`veil_stealth_pending_sweeps`) with a randomized delay window:
     $$\Delta t \in [t_{\text{min}}, t_{\text{max}}] \quad (\text{default: } 15 \text{ to } 45 \text{ minutes})$$
     On Stellar, where ledgers close every ~5 seconds, a 15–45 minute window spans approximately 180 to 540 distinct ledgers and decouples the receipt from the sweep.
  2. The ephemeral private key $p$ is stored in namespaced local storage (`walletLocal`) strictly for the duration of the delay.
  3. The ephemeral key is **explicitly excluded** from cloud backups (`backup.ts`), preserving the zero-private-key backup invariant.
  4. The client provides an immediate "Sweep now" control in the user interface, giving users full agency to prioritize instant liquidity over temporal privacy when desired.
  5. When the delay elapses (or when manually triggered), the sweep transaction transfers funds from the one-time address into the contract address.
  6. Upon confirmed transaction inclusion on-chain, the ephemeral private key $p$ is permanently purged from local storage.
  7. Once funds reach the contract address, they are immediately spendable by the user's Veil wallet through standard passkey authorization.
- **Verdict**: **Accepted**.

---

## Linkage & Threat Model: What an Observer Learns

Veil must be uncompromisingly honest with users about what this mechanism achieves and what remains observable on the public ledger.

```
Sender ─────────(Stealth Payment)─────────► One-Time Address (Classic Account)
                                                   │
                                                   │ [Randomized Delay: 15–45 min]
                                                   ▼
Veil Smart Wallet ◄─────(Sweep Transfer)─────── One-Time Address (Classic Account)
(Contract Account)
```

### 1. What is Hidden / Broken
- **Sender Unlinkability**: The sender cannot identify the recipient's identity or contract address. The sender only interacted with the recipient's public stealth meta-address and published an ephemeral public key or announcement.
- **Temporal Correlation Decoupling**: An observer cannot correlate the sender's payment to the recipient's wallet balance by matching transaction timestamps or ledger sequence numbers. The sweep occurs hundreds of ledgers later with randomized jitter.

### 2. What an Observer Can Still Correlate
- **On-Chain Graph Edge ($G_{\text{stealth}} \to C_{\text{veil}}$)**: Because the Stellar ledger is public, any party inspecting the sweep transaction on a block explorer will observe funds transferring from the one-time address directly into the contract address. If the one-time address only ever received that single payment, graph-analysis heuristics can link the source payment to the destination contract address.
- **Value Matching**: Unless combined with value batching or split sweeps, the swept amount closely matches the incoming payment amount (minus Stellar network transaction fees).

### 3. Composition with Shielded Pools
To achieve full unlinkability where even the on-chain graph edge is destroyed, the funds from the one-time address must be deposited into the Stellar Private Payments (SPP) shielded pool rather than swept directly into the contract address. In Veil's privacy architecture, stealth addressing protects counterparty identity at receipt, while the shielded pool protects transaction amounts and asset graph linkages.

---

## One-Time Key Storage and Cloud Backup Policy

1. **Storage Location**: Ephemeral one-time keys are stored in namespaced local web storage (`walletLocal` / `localStorage`) under the key `veil_stealth_pending_sweeps`.
2. **Key Lifecycle**:
   - Created/derived upon scanning incoming stealth payment or claimable balance.
   - Retained only until the sweep transaction confirms on-chain.
   - Cleared and zeroed immediately upon confirmation.
3. **Explicit Exclusion from Cloud Backups**:
   - Veil's backup engine (`collectWalletMetadata` in `frontend/wallet/lib/backup.ts`) strictly reads public identifiers (`invisible_wallet_address`, `invisible_wallet_public_key`, signer list, settings).
   - Ephemeral keys under `veil_stealth_pending_sweeps` are explicitly barred from serialization into `WalletBackupMetadata`.
   - Even if an encrypted backup is uploaded to cloud storage during the delay window, no ephemeral private keys are included in the backup envelope.

---

## User-Facing Disclosure Specification

Every user interface surface presenting pending stealth payments or sweeps must display unambiguous copy disclosing the privacy boundary:

> **"Private Receipt (Stealth Transfer)**
> Your sender cannot see which wallet received these funds. To prevent outside observers from linking this payment to your wallet using timestamps, your wallet delays moving funds into your main wallet contract address.
>
> **What observers can see:** Once swept, anyone looking at the public Stellar blockchain ledger can see a transfer from the one-time stealth address to your wallet contract address. To break the ledger link entirely, deposit these funds into the Shielded Pool."

---

## Reference Mainnet and Testnet Identifiers

All addresses in this specification and the implementation are full 56-character Stellar identifiers without abbreviation:

- Mainnet Native Asset Contract:
  `CAS3J7GYLGXMF6TDJBBYYSE3HQ6BBSMLNUQ34T6TZMYMW2SLH3KUY3NO`
- Testnet Native Asset Contract:
  `CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC`
- Mainnet Passkey Factory Contract:
  `CCZ3JLRESNLDADGXWNEH4YQ4NXUUAHRJNCWZHYG6QB4KTDYHOH6OQ7BK`
- Testnet Passkey Factory Contract:
  `CAUK4MWO3TTFM6PLURSH2GPK3AB747SZGABKTCVLKCU7W2MGKHKP35GA`
