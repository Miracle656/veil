## #263 Architecture diagram: wallet ↔ contract ↔ anchor
### Background
Newcomers ask "what talks to what." A Mermaid diagram embedded in the docs answers in 30 seconds.

### What to build
A Mermaid sequence diagram showing register → fund → send → SEP-24 deposit flow, and a component diagram of the SDK / contract / anchor / Horizon boundary.

### Key files
- frontend/docs/content/architecture.mdx (new)
### Acceptance criteria
- Two diagrams (sequence + component)
- Renders in the live docs site

## #265 Troubleshooting guide: passkey errors

### Background
We've seen support questions about "NotAllowedError", "InvalidStateError", iOS Safari quirks. Centralize the answers.

### What to build
A docs page with each error name, its cause, and the user-facing fix.

### Key files
frontend/docs/content/troubleshooting/passkeys.mdx (new)
### Acceptance criteria
- Covers 8+ error names
- Includes iOS Safari section

## #267 Document the fee/gas budget model

### Background
Soroban resource fees confuse devs. We need a single page that explains base fee, resource fee, refundable fee, and how Veil handles them.

### What to build
A docs page with a worked example: deploy → invoke → measure resource consumption → derive fee.

### Key files
frontend/docs/content/guides/fees.mdx (new)
### Acceptance criteria
- Worked example with real numbers
- Refundable-fee section

## #268 "Choosing a network" page (futurenet / testnet / mainnet)

### Background
Three networks, two friendbots, different passphrases — new contributors get stuck here.

### What to build
A docs page with a network comparison table and a copy-paste env block for each.

### Key files
frontend/docs/content/guides/networks.mdx (new)
### Acceptance criteria
- All three networks documented
- Env vars listed per network