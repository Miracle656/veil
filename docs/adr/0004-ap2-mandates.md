# ADR 0004 — AP2 Mandates: What They Would Require of Veil

| Field     | Value                                        |
|-----------|----------------------------------------------|
| Status    | Proposed — research spike, no code (#845)    |
| Date      | 2026-09-25                                   |
| Deciders  | Veil core team                               |
| Recommendation | **Wait.** Re-read when any trigger in [What would change this](#what-would-change-this) fires. |

---

## Context

AP2 (Agent Payments Protocol) authorises agent-initiated payments with **Mandates**: signed
credentials proving that a user approved a purchase, or a set of constraints on purchases. Its
governance has moved to the FIDO Alliance. There is also an x402 extension for on-chain settlement.

On the surface, Veil already has pieces of this. Its signer is a FIDO credential (a passkey), and
Lens ran an x402 facilitator. This spike checks whether those pieces actually connect to AP2, using
the specifications rather than announcements.

### Sources and how to read this document

Every external claim links to a pinned commit, so the citation still says the same thing after the
spec moves on:

| Source | Pinned at | Date of pin |
|---|---|---|
| AP2 spec (`google-agentic-commerce/AP2`, v0.2) | [`e1ea56d`][ap2] | 2026-04-29 |
| A2A x402 extension (`google-agentic-commerce/a2a-x402`, v0.2) | [`125db55`][a2ax] | 2026-05-24 |
| x402 `exact` scheme on Stellar (`coinbase/x402`) | [`dd927a2`][xstl] | 2026-04-21 |
| Lens (`Miracle656/Lens`) | [`41b1f62`][lens] | 2026-09-08 |
| Veil | `6504418` (`main`) | 2026-09-24 |

Each claim carries one of three tags:

- **[Spec]**: the linked specification says this, normatively or in a worked example (examples are
  marked as such).
- **[Veil]**: verified in this repository's code at the commit above.
- **[Plausible]**: my inference. It is not written anywhere, and it is the part most likely to be
  wrong.

---

## 1. What a Mandate is

**Two types, each open or closed.** AP2 v0.2 defines a Checkout Mandate (what is bought, verified by
the Merchant) and a Payment Mandate (the payment for it, verified by the Credential Provider,
Network and Merchant Payment Processor). [Spec: [specification.md §Mandates][ap2-spec-mandates]]
A mandate is *closed* when bound to one transaction and *open* when it carries constraints instead.
[Spec: [agent_authorization.md §Mandate Structure][ap2-aa-structure]]

**Naming has changed since launch.** v0.1 defined Cart, Intent and Payment Mandates. [Spec:
[v0.1.0 specification.md §4.1][ap2-v01]] v0.2 uses Checkout and Payment Mandates, with `vct` values such as `mandate.payment.1` and
`mandate.payment.open.1`, and verifiers must match the exact string. [Spec:
[payment_mandate.md §Type][ap2-pm-type], [specification.md §Mandate Versioning][ap2-spec-vers]]
The x402 extension has not caught up: its embedded-flow examples still use
`ap2.mandates.CartMandate`. [Spec: [a2a-x402 spec.md L228][a2ax-cart]] That mismatch is itself a
signal about how settled this layer is.

**Format: SD-JWT.** "AP2 specifies the use of `SD-JWT`s for securing the Payment and Checkout
Mandates." [Spec: [specification.md §VDC Formats][ap2-spec-vdc]] The mandate claims are `vct`
(required), `constraints` (optional) and `cnf`, the proof-of-possession key, which is **required
while the mandate is open**. [Spec: [agent_authorization.md §Mandates using SD-JWT VCs][ap2-aa-sdjwt]]
Open mandates MUST support key binding. [Spec: [agent_authorization.md L415-416][ap2-aa-kb]]

**Verification** follows the Delegate SD-JWT processing rules. Unchanged claims are checked from the
open to the closed mandate, and each constraint is evaluated. **Unknown constraints fail
evaluation.** [Spec: [agent_authorization.md §Verification and Processing Rules][ap2-aa-verify]]
Delegate SD-JWT is cited as an *individual draft*. [Spec: [agent_authorization.md
§References][ap2-aa-refs]] The chain format underneath AP2 is therefore not yet a standard.

**Who signs.** In human-present ("Direct") mode, the user signs the closed mandates. In autonomous
mode, "the closed Mandates are signed by an Agent key", and the user-signed open mandates must
include "the agent's public key as a `cnf` claim". [Spec: [specification.md §Modes][ap2-spec-modes],
[§Autonomous][ap2-spec-auto]]

## 2. Can a passkey produce or attest a Mandate?

**Nothing specifies that it can.** AP2 v0.2 defines exactly two delegation models. [Spec:
[agent_authorization.md §Mandate Delegation][ap2-aa-deleg]]

1. **User Credential.** An issuer-backed verifiable credential is presented over OpenID4VP, with
   the mandate carried in `transaction_data` and bound through the SD-JWT key binding (ES256 in the
   example). [Spec: [§Delegation using OpenID4VP][ap2-aa-oid4vp]]
2. **Trusted Agent Provider.** The agent provider signs mandates with its own key, after its
   Trusted Surface obtains consent. The agent MUST NOT be able to reach that key. [Spec: [§Trusted
   Agent Provider][ap2-aa-tap]]

The only mention of passkeys anywhere in the AP2 docs is a non-normative note listing "a directly
trusted user key, rather than a full credential, such as a passkey or hardware-attested key" among
approaches that "can be explored" **in the future**. [Spec: [agent_authorization.md L61-67][ap2-aa-note]]
In AP2's own words, then, a passkey-rooted mandate is future work, not a supported model.

**A passkey assertion is not a JWS signature, even on the same curve.** Veil's passkey is P-256
(ES256), and so are the SD-JWT examples. But WebAuthn signs `authenticatorData ||
SHA-256(clientDataJSON)`, never caller-chosen bytes. [Spec: [WebAuthn L3 §6.3.3][webauthn-get];
Veil: [ADR 0002](0002-webauthn-signature-verification.md)] An ES256 JWS is a signature over
`base64url(header).base64url(payload)`. A verifier checking the JWS would reject a raw assertion.
**[Plausible]** Making a passkey "sign" a mandate therefore needs a bridge: either a verifier that
accepts WebAuthn assertions (nobody has specified one), or a second key that signs the JWS once the
passkey has approved.

**The ceremony is also bound to one Soroban payload.** Branch 3 of `__check_auth` accepts an
assertion only if its `clientDataJSON` challenge is `base64url(signature_payload)`, the host-computed
hash of one authorised invocation. [Veil: [lib.rs L346-416](../../contracts/invisible_wallet/src/lib.rs#L346-L416),
`auth::verify_webauthn`] An assertion made over mandate content carries a different challenge, so it
cannot also authorise a transaction. **[Plausible]** Even if a verifier someday accepted passkey
assertions, a human-present AP2 payment from Veil would take **two** biometric prompts: one for the
mandate and one for the transfer. The extension's "Atomic Signing" pattern assumes one approval can
produce both signatures. [Spec: [a2a-x402 §4.1.1][a2ax-atomic]] A software wallet key can do that. A
WebAuthn authenticator returns one assertion per ceremony, over one challenge.

### Answer to the issue's third question

> Can Veil's passkey → `__check_auth` ceremony serve as the human-authorisation step?

**On-chain, yes. For AP2 as specified, no.** The passkey ceremony is a sound human-authorisation step
for a Soroban invocation, and that is where Veil's security argument lives. It is not an AP2
mandate signature. AP2 would expect a separate credential: an issuer-backed VC (User Credential
model) or a provider-held signing key (Trusted Agent Provider). [Spec, as cited above]

## 3. The x402 extension, and where Lens sits

### How the extension settles

x402 is a *push* payment: the signed `PaymentPayload` **is** the authorisation to move funds. In the
embedded flow it travels inside the AP2 Payment Mandate. [Spec: [a2a-x402 §4, §4.1][a2ax-4]] The
Merchant Agent "communicates with a type of facilitator to first verify the payment's signature and
validity, and then to settle the transaction on-chain". [Spec: [a2a-x402 §5.1][a2ax-merchant]] The
extension describes three signing models: Atomic (human present), Delegated (the agent's "own key
(or a delegated key)" signs both) and Smart Contract Escrow (a pre-funded contract verifies the
signed order and releases funds). [Spec: [a2a-x402 §4.1][a2ax-41]]

On Stellar, the `exact` scheme has the client sign **Soroban authorisation entries** for a SEP-41
`transfer(from, to, amount)`. The facilitator rebuilds the transaction with its own account as
source, re-simulates it, pays the fee and submits it. [Spec: [scheme_exact_stellar.md §Protocol
Flow, §Settlement Logic][xstl]] That path "supports both C-accounts and G-accounts". [Spec:
[§Authorization Patterns][xstl-cacct]]

**[Plausible]** This is the most useful finding of the spike. **A Veil `C…` wallet can be an x402
payer today at the protocol level**, because the facilitator only needs an address-credential auth
entry, and producing one is exactly what `__check_auth` does. Whether it works end to end with the
real `@x402/stellar` facilitator has not been tested. The next constraint is where it would first
break.

**Concrete incompatibility.** The spec requires the auth entry to expire no later than
`currentLedger + ceil(maxTimeoutSeconds / 5)`. [Spec: [scheme_exact_stellar.md L129][xstl-exp]]
The mobile signing path hard-codes `+100` ledgers. [Veil:
[walletConnect.ts L304](../../frontend/mobile/lib/walletConnect.ts#L304)] With the 120-second
timeout the in-repo example uses, the limit is 24 ledgers, so a facilitator would reject a payload
built by `signXdrPayload()` as it stands. [Veil:
[examples/x402-api/server/src/x402.ts](../../examples/x402-api/server/src/x402.ts)]

### Where x402 payments in Veil actually come from today

**None of them go through the wallet contract.**

- The agent paid Lens with its own ed25519 key until commit `6f02c5d` removed x402 altogether.
  Prices now come from Soroswap with a Horizon fallback, which "replaced the Lens oracle, which
  charged per call over x402 and made the agent hold a funded key of its own". [Veil:
  [packages/agent/src/price.ts L15](../../packages/agent/src/price.ts#L15)] `README.md` still
  describes Lens as x402-gated and auto-paid, which is stale.
- The x402 example client says it pays "with Veil", but it signs with the ed25519 **fee-payer**
  secret. [Veil: [client/src/lib/x402.ts L29](../../examples/x402-api/client/src/lib/x402.ts#L29)]
  Its passkey prompt uses a **random** challenge. [Veil:
  [client/src/lib/veil.ts L75](../../examples/x402-api/client/src/lib/veil.ts#L75)] It is a
  presence check that nothing cryptographically ties to the payment, so it is not an authorisation.

### Lens's facilitator, assessed against the extension

| Question | Finding |
|---|---|
| Does Lens have a facilitator? | Yes. HTTP `/supported`, `/verify` [[api/facilitator.ts L64, L68][lens-api]] and `/settle` [[routes/facilitator.ts L147][lens-settle]], built on `ExactStellarScheme` from `@x402/stellar` with fees sponsored [[x402/facilitator.ts L63-81][lens-fac]]. |
| Custody | None. It holds a fee-paying key only, and the SDK refuses payloads where the facilitator participates in the transfer [[settle-design.md §1][lens-design]]. This matches the spec's facilitator-safety rules. |
| Scheme | `exact` only. `upto`, the natural fit for a budget, exists as a **draft** spec in Lens's docs and would need its own Soroban contract [[scheme_upto_stellar.md][lens-upto]]. |
| On the AP2 path or beside it? | **Beside it.** A facilitator verifies and settles the `PaymentPayload`. It never sees or verifies a mandate: in the embedded flow, the Merchant Agent pulls the payload out of the Payment Mandate first [Spec: [a2a-x402 §5.1][a2ax-merchant]]. In AP2 role terms, mandate verification belongs to the Merchant, Credential Provider and MPP [Spec: [specification.md §Verification][ap2-spec-verif]]. Lens would sit *under* whichever of those settles on Stellar. |
| Is it running? | **No.** `GET https://lens-ldtu.onrender.com/status` returned `503` with `x-render-routing: suspend-by-user` at 2026-09-24 23:19 UTC, so the service is suspended by its owner. Veil no longer calls it. |

**Conclusion.** Lens is a working, non-custodial x402 facilitator of the right kind. AP2 does not
need it specifically, and the facilitator is not where AP2's hard problems live.

## 4. Spending limits and validity: the risky part

An open mandate is a standing authorisation. Its limits are **constraints evaluated by verifiers**:

| AP2 constraint [Spec: [payment_mandate.md §Constraints][ap2-pm-constraints]] | Veil primitive that could enforce it [Veil] | Gap |
|---|---|---|
| `payment.budget`: total across uses | `SessionKeyAcl.amount_cap` and `spent`, cumulative [session_key.rs L18-43](../../contracts/invisible_wallet/src/session_key.rs#L18-L43), checked in `enforce` [L109-151](../../contracts/invisible_wallet/src/session_key.rs#L109-L151) | Units: AP2 amounts are fiat (`"USD"`), the ACL counts token base units of one contract. |
| `exp` / `payment.execution_date` | `SessionKeyAcl.expiry`, and `Allowance.expiry` [lib.rs L458](../../contracts/invisible_wallet/src/lib.rs#L458) | No `not_before`. |
| `payment.allowed_payees` | **None.** The session-key branch checks target contract, selector and amount, never `args[1]` (the `to`) [lib.rs L329-335](../../contracts/invisible_wallet/src/lib.rs#L329-L335) | A session key capped for one token can pay **anyone**. |
| `payment.amount_range`: per payment | None. The cap is cumulative only. A per-key 24-hour limit exists for passkey signers only [lib.rs L418](../../contracts/invisible_wallet/src/lib.rs#L418) | No per-call max for delegated keys. |
| `payment.agent_recurrence` | None | Frequency and occurrence counts. |
| `cnf`: the agent's P-256 key | Session keys are **ed25519** | The agent's AP2 key and its Stellar key would be two keys, and nothing specifies how to bind them. |

The spec's own mitigations for standing authorisations are off-chain. Budget evaluation "requires
tracking the total amount spent". [Spec: [payment_mandate.md §Budget][ap2-pm-budget]] Double-spend
protection rests on the agent not presenting overlapping mandates, with verifiers who "MAY" reject
them. [Spec: [security_and_privacy_considerations.md §Double Spend][ap2-sec-double],
[specification.md L237][ap2-spec-nosub]]

**[Plausible]** That model was designed for *pull* payments, where a credential provider stands
between the agent and the money. With x402 there is no such gate: whatever key signs the auth
entry moves the funds. For Veil, **the wallet contract is the only enforcement point an agent cannot
route around**. A mandate would be *evidence* of what the user approved. The session-key ACL would
have to be the *enforcement*, and it currently cannot express payees, per-payment ranges or
recurrence. The user-facing ceremony for that already exists and is the right shape:
`register_session_key` requires the wallet's own authorisation, which means a passkey assertion.
[Veil: [lib.rs L620](../../contracts/invisible_wallet/src/lib.rs#L620)] It is a closer on-chain
analogue of a user-signed open mandate than anything in AP2's delegation models.

## 5. What adopting would cost

**[Plausible]** A sketch, for sizing only:

1. **Human-present.** Veil acts as a Trusted Agent Provider: the wallet app is the Trusted Surface,
   a Veil-operated key signs the SD-JWT after a passkey approval, and a second passkey assertion
   authorises the x402 auth entry. This adds a **server-held signing key** that merchants must
   trust, a trust anchor Veil does not have today (compare the reasoning in
   [ADR 0003](0003-fee-payer-key-from-webauthn-prf.md) for keeping keys passkey-bound). It also
   costs two biometric prompts per purchase.
2. **Autonomous.** This requires an agent-held key (`cnf`) that signs closed mandates, plus a
   delegated Stellar key that signs transfers. Today the agent builds only unsigned XDR, and the
   voice work under way forbids any intent from signing (#844, and the ground rules in #845's own
   issue body). Adopting autonomous AP2 **reverses a security invariant**, and that belongs in its
   own decision.
3. **Contract work either way.** Payee allow-lists and per-payment ranges in `SessionKeyAcl`. That
   changes the ACL's storage shape.

## Decision

**Wait.** Do not implement AP2 mandates now. Dated **2026-09-25**. The reasons, strongest first:

1. **No specified path from a passkey to a mandate.** Passkeys appear only in a non-normative
   "future" note. Both specified models add a trust anchor Veil does not have.
2. **Autonomous mode requires the agent to hold keys**, which conflicts with Veil's current
   invariants. That decision is bigger than AP2.
3. **The layer is still moving.** AP2 is v0.2, its chain format is an individual draft, and the x402
   extension still uses the pre-v0.2 mandate names.
4. **Nobody is asking.** No Stellar merchant, credential provider or facilitator in view requests
   AP2 mandates, and the only facilitator Veil ran is suspended.

It is not **ignore**. AP2 is where agent-payment authorisation is standardising, the x402 Stellar
scheme already accepts contract accounts, and Veil's session keys are most of an enforcement layer.

## What would change this

Re-read this document if any of these happen:

- **AP2 or FIDO specifies a passkey-rooted delegation model**, meaning the note at
  agent_authorization.md L61-67 becomes normative, or verifiers can check a WebAuthn assertion
  over mandate content. That removes reason 1 and moves the decision towards **adopt** for
  human-present.
- **The maintainers decide the agent may hold a constrained, revocable key.** That removes reason 2.
  The session-key ACL then becomes the enforcement layer, and autonomous AP2 over x402 becomes a
  real option.
- **A Stellar counterparty asks for AP2 mandates**, or the x402 extension aligns with AP2 v0.2.
- **Delegate SD-JWT is adopted by a standards body**, removing part of reason 3.
- Evidence the other way, such as AP2 being dropped or an x402 extension superseding mandates, moves
  this to **ignore**.

## Consequences

- No code changes follow from this ADR.
- Findings that stand on their own, whatever happens to AP2, and are best filed separately:
  - `SessionKeyAcl` cannot restrict the payee. A session key for a token can pay any address.
  - Paying x402 from the `C…` wallet needs the auth-entry expiry taken from `maxTimeoutSeconds`,
    not the fixed `+100` ledgers.
  - `README.md` still describes Lens and the agent's x402 client as live.
  - The x402 example's passkey prompt is not bound to the payment it gates.

<!-- Pinned sources -->
[ap2]: https://github.com/google-agentic-commerce/AP2/tree/e1ea56db72a6385bce3e5c1112b3a56ce60acb43/docs/ap2
[ap2-v01]: https://github.com/google-agentic-commerce/AP2/blob/bb57b6bfdb9a1caafffe7d024ca04d99cefa40be/docs/specification.md?plain=1#L272-L330
[ap2-spec-mandates]: https://github.com/google-agentic-commerce/AP2/blob/e1ea56db72a6385bce3e5c1112b3a56ce60acb43/docs/ap2/specification.md#mandates
[ap2-spec-vers]: https://github.com/google-agentic-commerce/AP2/blob/e1ea56db72a6385bce3e5c1112b3a56ce60acb43/docs/ap2/specification.md#mandate-versioning
[ap2-spec-vdc]: https://github.com/google-agentic-commerce/AP2/blob/e1ea56db72a6385bce3e5c1112b3a56ce60acb43/docs/ap2/specification.md#verifiable-digital-credential-formats-vdcs
[ap2-spec-modes]: https://github.com/google-agentic-commerce/AP2/blob/e1ea56db72a6385bce3e5c1112b3a56ce60acb43/docs/ap2/specification.md#modes
[ap2-spec-auto]: https://github.com/google-agentic-commerce/AP2/blob/e1ea56db72a6385bce3e5c1112b3a56ce60acb43/docs/ap2/specification.md#autonomous-human-not-present
[ap2-spec-verif]: https://github.com/google-agentic-commerce/AP2/blob/e1ea56db72a6385bce3e5c1112b3a56ce60acb43/docs/ap2/specification.md#verification
[ap2-spec-nosub]: https://github.com/google-agentic-commerce/AP2/blob/e1ea56db72a6385bce3e5c1112b3a56ce60acb43/docs/ap2/specification.md?plain=1#L237-L239
[ap2-aa-deleg]: https://github.com/google-agentic-commerce/AP2/blob/e1ea56db72a6385bce3e5c1112b3a56ce60acb43/docs/ap2/agent_authorization.md#mandate-delegation
[ap2-aa-note]: https://github.com/google-agentic-commerce/AP2/blob/e1ea56db72a6385bce3e5c1112b3a56ce60acb43/docs/ap2/agent_authorization.md?plain=1#L61-L67
[ap2-aa-oid4vp]: https://github.com/google-agentic-commerce/AP2/blob/e1ea56db72a6385bce3e5c1112b3a56ce60acb43/docs/ap2/agent_authorization.md#delegation-using-openid4vp
[ap2-aa-tap]: https://github.com/google-agentic-commerce/AP2/blob/e1ea56db72a6385bce3e5c1112b3a56ce60acb43/docs/ap2/agent_authorization.md#trusted-agent-provider
[ap2-aa-structure]: https://github.com/google-agentic-commerce/AP2/blob/e1ea56db72a6385bce3e5c1112b3a56ce60acb43/docs/ap2/agent_authorization.md#mandate-structure
[ap2-aa-kb]: https://github.com/google-agentic-commerce/AP2/blob/e1ea56db72a6385bce3e5c1112b3a56ce60acb43/docs/ap2/agent_authorization.md?plain=1#L415-L416
[ap2-aa-sdjwt]: https://github.com/google-agentic-commerce/AP2/blob/e1ea56db72a6385bce3e5c1112b3a56ce60acb43/docs/ap2/agent_authorization.md#mandates-using-sd-jwt-vcs
[ap2-aa-verify]: https://github.com/google-agentic-commerce/AP2/blob/e1ea56db72a6385bce3e5c1112b3a56ce60acb43/docs/ap2/agent_authorization.md#verification-and-processing-rules
[ap2-aa-refs]: https://github.com/google-agentic-commerce/AP2/blob/e1ea56db72a6385bce3e5c1112b3a56ce60acb43/docs/ap2/agent_authorization.md#normative
[ap2-pm-type]: https://github.com/google-agentic-commerce/AP2/blob/e1ea56db72a6385bce3e5c1112b3a56ce60acb43/docs/ap2/payment_mandate.md#type
[ap2-pm-constraints]: https://github.com/google-agentic-commerce/AP2/blob/e1ea56db72a6385bce3e5c1112b3a56ce60acb43/docs/ap2/payment_mandate.md#payment-mandate-constraints
[ap2-pm-budget]: https://github.com/google-agentic-commerce/AP2/blob/e1ea56db72a6385bce3e5c1112b3a56ce60acb43/docs/ap2/payment_mandate.md#budget
[ap2-sec-double]: https://github.com/google-agentic-commerce/AP2/blob/e1ea56db72a6385bce3e5c1112b3a56ce60acb43/docs/ap2/security_and_privacy_considerations.md#double-spend
[a2ax]: https://github.com/google-agentic-commerce/a2a-x402/blob/125db5526a965d2325459d1a9df2e274a7e42396/spec/v0.2/spec.md
[a2ax-4]: https://github.com/google-agentic-commerce/a2a-x402/blob/125db5526a965d2325459d1a9df2e274a7e42396/spec/v0.2/spec.md?plain=1#L37-L56
[a2ax-41]: https://github.com/google-agentic-commerce/a2a-x402/blob/125db5526a965d2325459d1a9df2e274a7e42396/spec/v0.2/spec.md?plain=1#L48-L92
[a2ax-atomic]: https://github.com/google-agentic-commerce/a2a-x402/blob/125db5526a965d2325459d1a9df2e274a7e42396/spec/v0.2/spec.md?plain=1#L58-L69
[a2ax-merchant]: https://github.com/google-agentic-commerce/a2a-x402/blob/125db5526a965d2325459d1a9df2e274a7e42396/spec/v0.2/spec.md?plain=1#L131-L140
[a2ax-cart]: https://github.com/google-agentic-commerce/a2a-x402/blob/125db5526a965d2325459d1a9df2e274a7e42396/spec/v0.2/spec.md?plain=1#L228
[xstl]: https://github.com/coinbase/x402/blob/dd927a26cfefc98c24b3ec38b3a8f204dad0c60d/specs/schemes/exact/scheme_exact_stellar.md
[xstl-exp]: https://github.com/coinbase/x402/blob/dd927a26cfefc98c24b3ec38b3a8f204dad0c60d/specs/schemes/exact/scheme_exact_stellar.md?plain=1#L129
[xstl-cacct]: https://github.com/coinbase/x402/blob/dd927a26cfefc98c24b3ec38b3a8f204dad0c60d/specs/schemes/exact/scheme_exact_stellar.md?plain=1#L194-L207
[webauthn-get]: https://www.w3.org/TR/webauthn-3/#sctn-op-get-assertion
[lens]: https://github.com/Miracle656/Lens/tree/41b1f6211e8d506873ab6e9e328d1245bffaf0c0
[lens-api]: https://github.com/Miracle656/Lens/blob/41b1f6211e8d506873ab6e9e328d1245bffaf0c0/src/api/facilitator.ts#L64-L68
[lens-settle]: https://github.com/Miracle656/Lens/blob/41b1f6211e8d506873ab6e9e328d1245bffaf0c0/src/routes/facilitator.ts#L147
[lens-fac]: https://github.com/Miracle656/Lens/blob/41b1f6211e8d506873ab6e9e328d1245bffaf0c0/src/x402/facilitator.ts#L63-L81
[lens-design]: https://github.com/Miracle656/Lens/blob/41b1f6211e8d506873ab6e9e328d1245bffaf0c0/docs/x402/settle-design.md#1-what-keys-does-this-hold
[lens-upto]: https://github.com/Miracle656/Lens/blob/41b1f6211e8d506873ab6e9e328d1245bffaf0c0/docs/x402/scheme_upto_stellar.md
