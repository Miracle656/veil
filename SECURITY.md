# Security Policy

## Supported Versions

Only the most recent release receives security patches. Veil is currently in testnet preview; no version is considered production-ready for Mainnet.

| Version | Status          | Supported |
|---------|-----------------|-----------|
| 0.1.x   | Testnet preview | Yes       |
| < 0.1   | —               | No        |

Once a v1.0 release is cut, the table will track the current stable branch and the one prior minor version.

---

## Reporting a Vulnerability

**Do not open a public GitHub issue for security reports.** Doing so discloses the vulnerability before a fix is available.

### Preferred channel

Email **security@invisible-wallet.dev** with:

- A description of the vulnerability and its potential impact
- Step-by-step reproduction instructions
- The affected component(s): contract, SDK, wallet front-end, or agent
- The affected version(s) or commit range
- Any suggested mitigations you have identified

PGP-encrypted email is accepted. Request the public key by emailing the address above with subject line `PGP key request` — we will respond with the key before you send sensitive details.

### Backup channel

GitHub's [private vulnerability reporting](https://github.com/Miracle656/veil/security/advisories/new) is also available and preferred when you do not need end-to-end encryption.

---

## Response SLA

| Severity     | Acknowledgement | Triage complete | Fix target |
|--------------|-----------------|-----------------|------------|
| Critical     | 24 hours        | 48 hours        | 7 days     |
| High         | 48 hours        | 5 days          | 14 days    |
| Medium / Low | 72 hours        | 10 days         | 30 days    |

Severity is assessed using [CVSS v3.1](https://www.first.org/cvss/calculator/3-1). We reserve the right to adjust timelines if the fix requires a coordinated release with an upstream dependency (Stellar SDK, Soroban runtime).

---

## Disclosure Policy

We follow a coordinated disclosure model:

1. Reporter submits the vulnerability privately.
2. We acknowledge receipt and begin triage.
3. We develop and test a fix on a private branch.
4. We issue a patched release and publish a GitHub Security Advisory.
5. After the advisory is public (minimum 7 days after the patch ships) the reporter may publish their own write-up.

We will credit reporters by name or handle in the advisory unless they request anonymity.

---

## Safe Harbor

We consider security research conducted under this policy to be authorized access. We will not initiate legal action against researchers who:

- Act in good faith and follow this policy
- Avoid accessing or modifying user data beyond what is required to demonstrate the vulnerability
- Do not perform denial-of-service attacks
- Do not exploit the vulnerability beyond a minimal proof of concept
- Disclose findings to us before publishing

This safe-harbor statement does not extend to activities that violate applicable law independent of this policy.

---

## Scope

| In scope | Out of scope |
|---|---|
| `contracts/` — Soroban smart contracts | Third-party dependencies (Stellar Core, Horizon) |
| `sdk/` — TypeScript client SDK | Phishing or social-engineering attacks |
| `frontend/wallet/` — Next.js PWA | Physical access attacks |
| `packages/agent/` — AI agent | Issues already publicly known |
| `frontend/docs/` — documentation site | Stellar network-level issues |

---

## Out-of-Scope Vulnerabilities

The following will not be accepted as valid reports:

- Self-XSS requiring the user to run attacker-supplied JavaScript in their own browser console
- Clickjacking on pages without sensitive actions
- Missing `Strict-Transport-Security` or similar headers on development/preview deployments
- Rate limiting on non-authenticated endpoints

---

## Audit Status

No third-party audit has been completed. Veil is testnet-only. A full audit is planned before any Mainnet deployment. See the [Security](https://veil-2ap8.vercel.app/security) docs page for the current audit roadmap.
