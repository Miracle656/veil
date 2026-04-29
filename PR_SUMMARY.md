## Summary
This PR implements Lighthouse CI performance budget checks and automated security auditing for the Drips Wave program (Issue #98).

### Lighthouse CI
- **Purpose**: Audits the Wallet PWA frontend for performance, accessibility, best practices, and PWA compliance on every PR.
- **Implementation**:
  - Uses `lhci autorun` with a custom configuration in `frontend/wallet/lighthouserc.js`.
  - Serves the Next.js standalone build using the correct `node .next/standalone/server.js` entry point.
  - Automatically comments on PRs with a summary table of scores and a link to the full report.
- **Thresholds**:
  - **Performance**: ≥ 80
  - **Accessibility**: ≥ 90
  - **PWA**: ≥ 80
  - **Best Practices**: ≥ 90

### Security Auditing
- **Purpose**: Detects known vulnerabilities in Rust dependencies.
- **Implementation**:
  - Adds a `security-audit` job that runs `cargo audit` on the `contracts` workspace.

## Type of change
- [x] CI / tooling

## Component
- [x] Wallet frontend
- [x] Contracts

## Checklist
- [x] I have read [CONTRIBUTING.md](../CONTRIBUTING.md)
- [x] `cargo test` passes (contracts)
- [x] `npm run typecheck` passes (wallet / sdk / agent)
- [x] `npm run build` passes (wallet / agent)
- [x] I added or updated tests where relevant
- [x] I updated docs / README where relevant
