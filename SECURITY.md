# Security Policy

## Supported Versions

Only the most recent release receives security patches.

| Version | Status          | Supported |
|---------|-----------------|-----------|
| 0.2.x   | Current release | Yes       |
| < 0.2   | Unsupported     | No        |

Once a v1.0 release is cut, the table will track the current stable branch and the one prior minor version.

---

## Reporting a Vulnerability

**Do not open a public GitHub issue for security reports.** Doing so discloses the vulnerability before a fix is available.

### Preferred Channel

Email **security@useveilapp.xyz** with:

- A description of the vulnerability and its potential impact
- Step-by-step reproduction instructions
- The affected component(s): contract, SDK, wallet front-end, or agent
- The affected version(s) or commit range
- Any suggested mitigations you have identified

---

## Response Timelines

We review incoming reports on a best-effort basis and aim to acknowledge receipt promptly. We will keep the reporter informed as triage and remediation progress.

---

## Disclosure Policy

We follow a coordinated disclosure model:

1. Reporter submits the vulnerability privately.
2. We acknowledge receipt and begin triage.
3. We develop and test a fix on a private branch.
4. We issue a patched release and publish a security advisory.
5. After the advisory is public (minimum 7 days after the patch ships) the reporter may publish their own write-up.

We will credit reporters by name or handle in the advisory unless they request anonymity.

### Advisory Publication

Security advisories and release notes detailing fixed vulnerabilities are published on GitHub under [Security Advisories](https://github.com/Miracle656/veil/security/advisories) and in project release notes.

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

Veil is live on Stellar Mainnet (deployed 2026-08-23). An external security audit was delivered on 2026-09-17. See the [Security](https://docs.useveilapp.xyz/security) docs page for architecture and security details.
