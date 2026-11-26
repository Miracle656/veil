# ADR 001: Association-Set Policy for Stellar Private Payments (SPP)

**Status:** Accepted  
**Date:** 2026-09-24  
**Context:** Stellar Wave / Privacy Batch (Issue #797, V132)  

---

## Context and Problem Statement
Stellar Private Payments (SPP) testnet deployments ship with two Association Set Provider (ASP) contracts:
1. `asp_membership` (Allowlist / Approved-key Merkle tree)
2. `asp_non_membership` (Blocklist / Blocked-key Merkle tree)

An Association Set Provider governs which deposits a zero-knowledge proof may be constructed against. Veil must select a concrete association-set policy for its wallet and mobile privacy flows, configure contract selection, articulate the policy and failure semantics in the UI, and document the privacy consequences honestly.

---

## Decision
Veil adopts **`blocklist`** (non-membership proofs against `asp_non_membership`) as its default association-set policy for all SPP shielded pools.

### Architectural & Privacy Rationale
1. **Maximizing Anonymity Set Size**:
   - In an `allowlist` model (`asp_membership`), only pre-cleared/KYC'd addresses can participate in the shielded pool. This fragments user liquidity and creates small anonymity sets.
   - In a `blocklist` model (`asp_non_membership`), all unflagged deposits across the network pool participate in the anonymity set, delivering strong privacy guarantees while still complying with AML/sanctions mandates.
2. **Upstream Compatibility**:
   - Canonical testnet SPP pools deployed by Nethermind/SDF specify `policyFlags: ["blocklist"]`.

---

## Compliance, Maintenance, and Exclusion Semantics
- **Excluded Entities**: Addresses and notes identified as sanctioned (e.g., OFAC lists), exploiter wallets, or illicit actors by the ASP.
- **ASP Maintenance**: The ASP Merkle root is maintained by Nethermind / SDF on testnet, and designated compliance providers on mainnet.
- **Exclusion Consequence**: If a deposit is added to the ASP blocklist Merkle tree, the client cannot construct a valid non-membership proof against the latest ASP root. Any transaction attempting to spend or unshield the note fails with a distinguishable error (`POLICY_REJECTED`).

---

## User Communication and Anonymity Set Definition
Veil communicates the privacy guarantees accurately and honestly:
- **Honest Definition**: The anonymity set is **not** "the entire Stellar network" or "all internet transactions". It is strictly **all non-excluded depositors participating in the same pool under the active policy (`blocklist`)**.
- **Configurability**: Policy selection is configurable via environment settings (`NEXT_PUBLIC_PRIVACY_ASP_POLICY` / `EXPO_PUBLIC_PRIVACY_ASP_POLICY`) and programmatic helpers (`getAssociationSetPolicy()`, `getAssociationSetContract()`), requiring configuration changes rather than code changes to adjust.
