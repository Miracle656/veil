#!/bin/bash
# Creates WalletConnect / dApp browser issues for Veil
set -e
REPO="Miracle656/veil"

# ── ISSUE 1 — WalletConnect session foundation ────────────────────────────

gh issue create --repo $REPO \
  --title "feat(wallet): implement WalletConnect v2 session management for Stellar" \
  --label "help wanted,area:wallet,difficulty:advanced" \
  --body "## Background
Veil users currently can only interact with dApps by copy-pasting their wallet address manually. WalletConnect v2 is the standard protocol that lets dApps initiate a wallet session via QR code or deep link — the same way MetaMask and Freighter work on their respective chains.

Stellar has a WalletConnect v2 namespace (\`stellar:\`) that defines how wallets and dApps negotiate a session. This issue covers the **core session layer**: installing the SDK, handling session proposals from dApps, storing active sessions, and cleanly handling disconnects.

This is the foundation that issues #[signXDR bridge], #[QR UI], #[approval modal], and #[sessions page] all build on top of — start here.

## What to build
Install the WalletConnect Web3Wallet SDK and implement the full session lifecycle:
- Receive and approve a session proposal from a dApp (exposing the user's \`C...\` contract address under the \`stellar:\` namespace)
- Handle session disconnect (from either side)
- Persist active sessions across page reloads
- Emit events the rest of the UI can subscribe to

## Key files
- \`frontend/wallet/lib/walletConnect.ts\` — **create this** — WalletConnect client singleton, session handlers
- \`frontend/wallet/app/dashboard/page.tsx\` — add \"Connect dApp\" entry point (button/icon only — QR UI is a separate issue)
- \`frontend/wallet/lib/network.ts\` — source of \`networkPassphrase\` and \`rpcUrl\` needed for the session metadata

## Suggested execution
\`\`\`bash
git checkout -b feat/walletconnect-session-foundation
\`\`\`
1. Install dependencies in \`frontend/wallet/\`:
   \`\`\`
   npm install @walletconnect/web3wallet @walletconnect/utils
   \`\`\`
2. Create \`frontend/wallet/lib/walletConnect.ts\` and initialise a \`Web3Wallet\` instance:
   \`\`\`ts
   import { Web3Wallet } from '@walletconnect/web3wallet'
   import { Core } from '@walletconnect/core'

   let _client: Web3Wallet | null = null

   export async function getWalletConnectClient(): Promise<Web3Wallet> {
     if (_client) return _client
     const core = new Core({ projectId: process.env.NEXT_PUBLIC_WC_PROJECT_ID! })
     _client = await Web3Wallet.init({
       core,
       metadata: {
         name: 'Veil',
         description: 'Passkey-powered Stellar smart wallet',
         url: 'https://app.useveilapp.xyz',
         icons: [],
       },
     })
     return _client
   }
   \`\`\`
3. Add \`approveSession(proposal, contractAddress)\` — builds a session namespace exposing \`contractAddress\` under \`stellar:pubnet\` (or \`stellar:testnet\` based on \`getNetwork()\`) and calls \`client.approveSession()\`
4. Add \`rejectSession(proposal)\` calling \`client.rejectSession()\`
5. Add \`disconnectSession(topic)\` calling \`client.disconnectSession()\`
6. Persist active sessions to \`sessionStorage\` so the UI can list them
7. Add \`NEXT_PUBLIC_WC_PROJECT_ID\` to \`.env.example\` with a comment pointing to https://cloud.walletconnect.com to get a free project ID
8. Export a \`useWalletConnect()\` React hook that exposes \`sessions\`, \`approveSession\`, \`rejectSession\`, \`disconnectSession\`

**Example commit message:**
\`feat(wallet): add WalletConnect v2 session management with Stellar namespace\`

## Acceptance criteria
- [ ] \`getWalletConnectClient()\` initialises once and returns the same instance on subsequent calls
- [ ] A dApp connecting via WalletConnect URI receives a session with the user's \`C...\` contract address in the \`stellar:\` namespace
- [ ] Sessions survive a page reload (persisted to sessionStorage)
- [ ] \`disconnectSession()\` removes the session from both storage and the WC client
- [ ] \`NEXT_PUBLIC_WC_PROJECT_ID\` documented in \`.env.example\`
- [ ] TypeScript compiles with no errors (\`npm run build\` passes)

---
> **Drips Wave** · Complexity: **High** · **200 points**
> Comment below to request assignment. PR must include \`Closes #[this issue]\`."

# ── ISSUE 2 — signXDR bridge ──────────────────────────────────────────────

gh issue create --repo $REPO \
  --title "feat(wallet): bridge WalletConnect stellar_signXDR to passkey signing" \
  --label "help wanted,area:wallet,difficulty:advanced" \
  --body "## Background
When a dApp wants the user to sign a transaction it sends a \`stellar_signXDR\` request over the WalletConnect session. Standard wallets respond by signing the XDR with an Ed25519 keypair. Veil is different — its wallet is a Soroban smart contract authorised via WebAuthn passkey. There is no keypair to hand WalletConnect.

This issue implements the critical bridge: intercept the incoming \`stellar_signXDR\` (or \`stellar_signAndSubmitXDR\`) request, extract the Soroban auth entries from the XDR, trigger the device's passkey prompt, assemble the signed transaction, and return it to the dApp. The dApp never needs to know Veil is a passkey wallet — it just receives a valid signed transaction.

**Depends on:** WalletConnect session management issue (must be merged first).

## What to build
A handler that:
1. Receives a \`session_request\` event for \`stellar_signXDR\`
2. Parses the XDR into a \`Transaction\` object
3. Simulates it via Soroban RPC to get the assembled footprint + auth entries
4. Calls \`signAuthEntry(payloadHash)\` from the existing SDK passkey flow for each auth entry requiring the contract's signature
5. Attaches the assembled credentials to the transaction
6. Signs the fee envelope with the fee-payer keypair
7. Returns the fully signed XDR to the dApp via \`client.respondSessionRequest()\`

## Key files
- \`frontend/wallet/lib/walletConnect.ts\` — add \`handleSignXdrRequest(event)\` here
- \`frontend/wallet/lib/sweepContractBalance.ts\` — **reference implementation** of the full passkey signing flow (steps 3–6 above are already solved here — adapt that pattern)
- \`frontend/wallet/lib/passkeyAuth.ts\` — \`requirePasskey()\` for biometric gate
- \`sdk/src/useInvisibleWallet.ts\` — \`signAuthEntry()\` method

## Suggested execution
\`\`\`bash
git checkout -b feat/walletconnect-sign-xdr-bridge
\`\`\`
1. In \`walletConnect.ts\`, subscribe to \`session_request\` events on the \`Web3Wallet\` client:
   \`\`\`ts
   client.on('session_request', async (event) => {
     const { topic, params, id } = event
     if (params.request.method === 'stellar_signXDR') {
       await handleSignXdrRequest(topic, id, params.request.params.xdr)
     }
   })
   \`\`\`
2. Implement \`handleSignXdrRequest(topic, requestId, xdrString)\`:
   - Parse XDR: \`TransactionBuilder.fromXDR(xdrString, networkPassphrase)\`
   - Simulate via Soroban RPC to assemble footprint: \`rpc.simulateTransaction(tx)\`
   - For each Soroban auth entry requiring the contract address, build the \`HashIdPreimageSorobanAuthorization\` preimage (see \`sweepContractBalance.ts\` lines 93–103 for exact implementation)
   - Call \`signAuthEntry(payloadHash)\` — this triggers the device passkey prompt
   - Inject the \`sigVec\` credentials back into each auth entry
   - Sign the transaction envelope with the fee-payer keypair
   - Respond: \`client.respondSessionRequest({ topic, response: { id, result: { signedXDR: assembled.toXDR('base64') }, jsonrpc: '2.0' } })\`
3. Handle the \`stellar_signAndSubmitXDR\` method variant: after signing, also call \`rpc.sendTransaction()\` and poll for confirmation before responding
4. On error or user cancellation, call \`client.respondSessionRequest()\` with a WalletConnect error response

**Example commit message:**
\`feat(wallet): bridge WalletConnect stellar_signXDR requests to passkey auth flow\`

## Acceptance criteria
- [ ] A dApp sending \`stellar_signXDR\` receives a signed transaction XDR back
- [ ] User sees a native passkey/biometric prompt before signing
- [ ] If the user cancels, the dApp receives a \`USER_REJECTED\` WalletConnect error
- [ ] \`stellar_signAndSubmitXDR\` variant submits and returns the transaction hash
- [ ] Handles transactions with multiple auth entries (signs each one)
- [ ] TypeScript compiles, \`npm run build\` passes

---
> **Drips Wave** · Complexity: **High** · **200 points**
> Comment below to request assignment. PR must include \`Closes #[this issue]\`."

# ── ISSUE 3 — QR scanner / URI paste UI ──────────────────────────────────

gh issue create --repo $REPO \
  --title "feat(wallet): add dApp connection UI — QR scanner and URI paste" \
  --label "help wanted,area:wallet,difficulty:intermediate" \
  --body "## Background
To connect to a dApp via WalletConnect, the user needs to scan a QR code (or paste a \`wc:\` URI) that the dApp displays. This issue adds the entry point UI to Veil: a \"Connect dApp\" button on the dashboard that opens a modal with camera scan and manual paste options.

**Depends on:** WalletConnect session management issue (must be merged first).

## What to build
A connection modal that:
- Opens from a \"Connect dApp\" button on the dashboard
- Shows two options: scan QR (camera) or paste a \`wc:\` URI manually
- On valid URI, calls \`approveSession()\` from the WalletConnect module
- Shows the dApp's name and icon from the session proposal metadata before the user confirms
- Handles invalid/expired URIs gracefully

## Key files
- \`frontend/wallet/app/dashboard/page.tsx\` — add \"Connect dApp\" button
- \`frontend/wallet/components/ConnectDAppModal.tsx\` — **create this** — modal component
- \`frontend/wallet/lib/walletConnect.ts\` — call \`approveSession()\` / \`rejectSession()\` from here

## Suggested execution
\`\`\`bash
git checkout -b feat/walletconnect-connect-dapp-ui
\`\`\`
1. Add a \"Connect dApp\" button to the dashboard action row (use the existing \`btn-ghost\` style, globe/link SVG icon, no emoji)
2. Create \`frontend/wallet/components/ConnectDAppModal.tsx\`:
   - Tab 1 — **Scan**: use \`getUserMedia\` with a \`<video>\` element and the \`jsQR\` library (\`npm install jsqr\`) to decode QR frames; on decode, call \`getWalletConnectClient().pair({ uri })\`
   - Tab 2 — **Paste**: a text input that accepts a \`wc:\` URI; validate it starts with \`wc:\` before pairing
3. After pairing succeeds, a \`session_proposal\` event fires; show the proposal metadata (dApp name, icon, description) in a confirmation step before calling \`approveSession()\`
4. On approval: close modal, show a brief \"Connected to [dApp name]\" toast
5. On rejection or error: show an error message, keep modal open for retry

**Example commit message:**
\`feat(wallet): add Connect dApp modal with QR scanner and URI paste\`

## Acceptance criteria
- [ ] QR scan decodes a live \`wc:\` URI from the camera
- [ ] Paste input validates the URI format before attempting to pair
- [ ] Confirmation step shows dApp name before the user approves
- [ ] Connected state dismisses the modal
- [ ] Camera is released (stream stopped) when the modal closes
- [ ] Works on iOS Safari and Android Chrome (the two primary PWA platforms)

---
> **Drips Wave** · Complexity: **Medium** · **150 points**
> Comment below to request assignment. PR must include \`Closes #[this issue]\`."

# ── ISSUE 4 — Transaction approval modal ─────────────────────────────────

gh issue create --repo $REPO \
  --title "feat(wallet): add WalletConnect transaction approval modal" \
  --label "help wanted,area:wallet,difficulty:intermediate" \
  --body "## Background
When a connected dApp requests the user to sign a transaction, Veil must show an approval modal before triggering the passkey prompt. Without this, the biometric prompt appears with no context — the user has no idea what they are approving. This is both a UX requirement and a security requirement.

**Depends on:** WalletConnect session management issue and the signXDR bridge issue (both must be merged first).

## What to build
An approval modal that:
- Appears when a \`session_request\` is received from a connected dApp
- Shows: dApp name, operation type (payment / swap / contract call), and the key details (amount, destination, token)
- Has \"Approve\" and \"Reject\" buttons
- On \"Approve\": calls the passkey prompt then \`handleSignXdrRequest()\`
- On \"Reject\": responds to the dApp with \`USER_REJECTED\`

## Key files
- \`frontend/wallet/components/WalletConnectApprovalModal.tsx\` — **create this**
- \`frontend/wallet/lib/walletConnect.ts\` — emit an event when a \`session_request\` arrives so the modal can subscribe to it
- \`frontend/wallet/app/dashboard/page.tsx\` — mount the modal here so it's always listening

## Suggested execution
\`\`\`bash
git checkout -b feat/walletconnect-approval-modal
\`\`\`
1. In \`walletConnect.ts\`, when a \`session_request\` arrives, emit a custom browser event (\`window.dispatchEvent(new CustomEvent('wc:request', { detail: event }))\`) instead of handling it inline
2. Create \`frontend/wallet/components/WalletConnectApprovalModal.tsx\`:
   - Subscribe to \`wc:request\` via \`useEffect\` + \`addEventListener\`
   - Parse the XDR to extract human-readable details:
     - Use \`TransactionBuilder.fromXDR()\` and inspect \`tx.operations\`
     - For \`payment\`: show amount + destination
     - For \`invokeHostFunction\` (Soroban): show contract address + function name
     - Fallback: show \"Contract interaction — review carefully\"
   - Render dApp name from \`session.peer.metadata.name\` and icon if available
   - \"Approve\" button calls \`requirePasskey()\` then \`handleSignXdrRequest()\`
   - \"Reject\" button calls \`client.respondSessionRequest()\` with error code \`4001\`
3. Mount \`<WalletConnectApprovalModal />\` in \`dashboard/page.tsx\` so it renders over the dashboard when a request arrives

**Example commit message:**
\`feat(wallet): add WalletConnect transaction approval modal with XDR preview\`

## Acceptance criteria
- [ ] Modal appears immediately when a dApp sends a sign request
- [ ] dApp name is displayed (not just the contract address)
- [ ] Payment operations show amount and destination
- [ ] Soroban contract calls show function name and contract address
- [ ] \"Reject\" dismisses the modal and notifies the dApp
- [ ] \"Approve\" triggers the passkey prompt then signs

---
> **Drips Wave** · Complexity: **Medium** · **150 points**
> Comment below to request assignment. PR must include \`Closes #[this issue]\`."

# ── ISSUE 5 — Sessions management page ───────────────────────────────────

gh issue create --repo $REPO \
  --title "feat(wallet): add connected dApps sessions page in settings" \
  --label "help wanted,good first issue,area:wallet,difficulty:easy" \
  --body "## Background
Once a user has connected dApps via WalletConnect, they need a way to see which dApps are connected and disconnect any of them. Without this, sessions accumulate invisibly and users have no way to revoke access from a dApp they no longer use.

**Depends on:** WalletConnect session management issue (must be merged first).

## What to build
A \"Connected Apps\" section in the wallet settings page that lists all active WalletConnect sessions and allows the user to disconnect individual ones or disconnect all at once.

## Key files
- \`frontend/wallet/app/settings/page.tsx\` — add the connected apps section here
- \`frontend/wallet/lib/walletConnect.ts\` — \`getSessions()\` and \`disconnectSession(topic)\` are already implemented in the foundation issue; just call them here

## Suggested execution
\`\`\`bash
git checkout -b feat/walletconnect-sessions-settings
\`\`\`
1. In \`settings/page.tsx\`, add a \"Connected Apps\" section below the existing settings
2. Call \`useWalletConnect()\` to get the \`sessions\` array and \`disconnectSession\` function
3. For each session, render a card showing:
   - dApp name: \`session.peer.metadata.name\`
   - dApp URL: \`session.peer.metadata.url\` (truncated, not a clickable link)
   - dApp icon: small 24×24 image if \`session.peer.metadata.icons[0]\` exists, fallback to a generic globe SVG
   - \"Disconnect\" button (use \`btn-ghost\` style)
4. If \`sessions\` is empty, show a muted \"No apps connected\" state
5. Add a \"Disconnect all\" button that appears only when sessions.length > 1
6. After disconnect, remove the card with a fade-out or instant removal

**Example commit message:**
\`feat(wallet): add connected dApps management to settings page\`

## Acceptance criteria
- [ ] All active WalletConnect sessions listed with dApp name and icon
- [ ] \"Disconnect\" removes the session and updates the list immediately
- [ ] Empty state shown when no sessions exist
- [ ] \"Disconnect all\" visible only when more than one session is active
- [ ] No crashes if \`metadata.icons\` is empty or missing

---
> **Drips Wave** · Complexity: **Trivial** · **100 points**
> Comment below to request assignment. PR must include \`Closes #[this issue]\`."

echo "✅ All WalletConnect issues created"
