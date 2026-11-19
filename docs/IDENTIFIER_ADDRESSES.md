# Phone numbers and email addresses as Stellar destinations

Research note, 2026-11-06. Scoping only — nothing here is built.

The question was: what would it take to let someone be paid at
`+2348012345678` or `alice@example.com`, as a separate project, linked back to
the Veil passkey wallet.

The short answer is that the resolution layer is nearly free — Veil already has
most of it — and every genuinely hard part is somewhere else: enumeration,
identifier ownership, attestation liability, and the fact that a Veil wallet is
a `C…` address.

## 0. Two different projects hide in that sentence

**(A) A directory.** The identifier *resolves to* an address. Custody stays
with the passkey. Nothing new holds keys.

**(B) Derivation.** The identifier *is* the wallet — the key is derived from or
guarded by email/SMS. This is Web3Auth, Magic, Privy. Whoever takes over the
mailbox takes the money; Web3Auth's own documentation concedes that in its
semi-custodial tier users "cannot use other factors to recover their account by
themselves."

**Build A.** B is a custodian wearing a cryptography costume, and it discards
the one asset Veil has: a passkey-authorised `C…` address with no server in the
signing path.

## 1. What Veil already has

| Piece | Where | State |
|---|---|---|
| SEP-2 forward resolution | `frontend/wallet/lib/federation.ts` | done, cached, tested |
| SEP-2 reverse (`type=id`) | `frontend/wallet/lib/reverseResolution.ts` | done |
| Names write layer | `frontend/wallet/lib/namesRegistry.ts` | done, incl. a homoglyph skeleton map |
| SEP-30 recovery client | `sdk/src/recovery/sep30.ts` | done, transport-only |
| SEP-45 contract-account auth | `frontend/wallet/lib/sep45.ts` | done |
| Federated address format check | `frontend/mobile/lib/address.ts` | done |

### A live defect found while checking

`www.useveilapp.xyz/.well-known/stellar.toml` publicly advertises

    FEDERATION_SERVER = "https://app.useveilapp.xyz/api/federation"

and that endpoint returns **404**. Only `/api/names/available` and
`/api/names/claim` exist. Any wallet that tries `anything*useveilapp.xyz`
today fails against a server Veil says it runs. The repo's own comment in the
toml admits the URL is aspirational — but it is deployed.

## 2. Enumeration is the actual problem; resolution is the easy part

A phone number carries roughly ten digits of entropy. Published work on
messenger contact discovery found the **entire worldwide mobile number space
sweepable in under 150 seconds** with an optimised approach, against more than
15 hours for naive hashcat. Signal removed hash-based contact discovery from
its Android source in September 2020 and moved to SGX enclaves.

So `sha256(phone) -> address`, on chain or behind a public GET, is not a
directory. **It is a phone-number-to-net-worth oracle** — Stellar balances are
public, so one sweep yields every Nigerian number using Veil, ranked by
holdings. That is a kidnapping and extortion target list, and it is the kind of
thing that makes a product unshippable retroactively.

### Celo's ODIS, which is the construction to copy rather than reinvent

- the identifier is prefix-tagged `{prefix}://{id}` so the same handle on two
  platforms does not collide
- the client **blinds** it with threshold BLS, so ODIS never sees the plaintext
- ODIS signs blinded; the client unblinds; `pepper` = first 13 characters of
  `sha256(unblinded signature)`
- `obfuscatedIdentifier = sha3(sha3({prefix}://{id})__{pepper})`
  (phone numbers use a flatter variant, for ASv1 back-compatibility)
- quota is metered per account at **0.001 cUSD per query**, topped up through an
  `OdisPayments` contract

The pepper defeats rainbow tables. But note the hole Celo's own `privacy.md`
leaves open: it **never establishes that splitting queries across many accounts
is prevented**. This is a cost ceiling, not a guarantee — one million lookups
is 1,000 cUSD, which deters a script kiddie and not a motivated attacker.

## 3. Nobody owns their phone number

This is the finding that kills phone-as-a-durable-address.

Nigeria's NCC runs **TIRMS** specifically to regulate reassignment of dormant
numbers. The documented pattern: a line sits dormant beyond roughly 12 months,
the telco deactivates and resells it, and the new holder inherits the previous
owner's account bindings because there is no national consent layer. MTN's own
Tobe Okigbo has said flatly that the belief you own your mobile number is false.

**Design consequence:** an attestation must carry `verified_at` and
`expires_at` and be re-attested, or a recycled number silently inherits
incoming payments. SocialConnect gets this right —
`registerAttestationAsIssuer` takes the verification time as an argument.

Also: the CBN and NCC signed an MoU in April 2026 giving banks a way to check
whether a number was recently swapped, reassigned or flagged. Veil cannot query
that without a telco relationship, so Veil's phone attestations are strictly
weaker than a bank's.

Email is better — no forced recycling, and DKIM gives a cryptographic handle —
but Gmail reclaims dormant accounts and corporate addresses die with employment.

## 4. Verifying ownership makes you a regulated attestor

SMS OTP in Nigeria runs roughly 1–2 naira at 10k+ volume, up to 4–7.5 naira at
low volume depending on tier. Sources disagree and OTP is usually priced above
bulk, so get an OTP-specific quote before budgeting.

Bigger than the cost: **NDPA 2023 requires anyone processing 200 or more data
subjects in any six-month period to register with the NDPC as a Controller or
Processor of Major Importance.** A phone/email directory crosses that on day
one. Consent must be withdrawable as easily as it was given, and processing
must stop *immediately* on withdrawal — so revocation is statutory, not a
nice-to-have.

This is a second NDPA surface on top of the NIN rule already in force here, and
it argues for the attestor service living in its own repo and its own legal
entity.

## 5. Email can be made trustless. Phone cannot.

Let that asymmetry drive the roadmap.

zkEmail proves in-circuit that a DKIM RSA signature is valid, and a contract
checks the proof against an on-chain DKIM key registry. No server has to be
trusted to assert that someone controls a mailbox.

**Viability on Soroban.** CAP-0074 is **Final, protocol 25**, and adds
`bn254_g1_add`, `bn254_g1_mul` and `bn254_multi_pairing_check` — deliberate
mirrors of EIP-196/197 — so an existing BN254 Groth16 verifier transfers. Two
cautions: the CAP says final cost calibration is **TBD**, and a community
Soroban port measured a *pure-Rust* BN254 pairing at roughly 560M instructions
against a 100M cap. The native host functions are exactly what closes that gap,
which means this needs **measuring, not assuming**.

**Proving cost.** Roughly 1M constraints without body verification, 3–8M with;
about 15 seconds in-browser with Halo2 on a desktop; ENS-funded work reached
sub-minute client-side proving but reports **WASM memory limits blocking local
proving for some email types entirely**. Whether this runs on a Tecno-class
Android is unknown.

For phone there is **no DKIM equivalent** — no cryptographic carrier
attestation exists. Phone verification is irreducibly a trusted-attestor
problem.

## 6. The Veil wall: a `C…` address cannot be paid classically

Confirmed in source. `contracts/invisible_wallet/src/lib.rs` verifies the
rp_id hash at line 467 and byte-compares `clientDataJSON.origin` at line 471,
both read from storage written only in `init` (lines 137–138). No setter, no
upgrade path.

Three consequences:

- **A federation record pointing at a `C…` address is unpayable** by any
  classic sender — exchange, anchor, or another wallet issuing a `payment`
  operation. This is the same wall the Veil Names work already hit.
- **CAP-84 `W…` addresses do not rescue it.** A muxed contract address is valid
  only as a Soroban `ScAddress`, explicitly *not* a classic payment
  destination, and the SAC's `balance` rejects a muxed argument — attribution
  comes from transfer events, not per-user balances. Useful for
  one-contract-many-users accounting; useless for "pay this phone number from
  an exchange."
- **SEP-30 is G-account-only.** It works by adding classic `SetOptions` signers
  and authenticating via SEP-10. This is exactly why Vibrant's "send to phone"
  works: G-accounts, SEP-30, with Lobstr as a second recovery server so no
  single party holds the key. Veil's existing `sdk/src/recovery/sep30.ts`
  cannot be pointed at a `C…` address. SEP-45 covers contract-account *anchor
  auth* only, and is still Draft v0.1.1.

### The passkey-linkage trap

Related Origin Requests will **not** let a new domain drive an existing Veil
wallet. ROR lets one RP ID serve about five registrable domains via
`/.well-known/webauthn`, and the credential's RP ID stays whatever it was at
registration. So `verify_rp_id` would still pass — but `clientDataJSON.origin`
becomes the *new* site's origin, so `verify_origin` fails with
`OriginMismatch`. Exactly one of the two checks breaks, which is the most
expensive kind of almost-working.

So the new project either lives as a **path under `app.useveilapp.xyz`**, or it
never touches `__check_auth`.

## 7. The architecture worth building

Five layers; only one is new infrastructure.

1. **Normalisation.** E.164 for phone. For email, *decide once and pin it in a
   test* whether Gmail dots and `+tags` are stripped — `a.l.i.c.e@gmail.com` is
   one mailbox at Google and a different one almost everywhere else.
   Prefix-tag like SocialConnect.
2. **Blinded, peppered identifier.** Copy the published construction. This is
   the only genuinely new service and it is a **liveness dependency** — if it
   is down, nobody resolves. Given that a boot-time validator already
   crash-looped wraith here, make it a soft dependency with a local cache,
   never a hard one.
3. **Attestation registry.** A Soroban contract:
   `obfuscatedIdentifier -> (address, issuer, verified_at, expires_at)`.
   Multi-issuer, SocialConnect-style, so Veil is not the only trust root.
4. **Resolution surface.** The key tension: **SEP-2 is specified as a public,
   unauthenticated GET**, which is irreconcilable with anti-enumeration. So
   SEP-2 keeps serving `alice*veil.xyz`-shaped *names*, and phone/email get a
   separate authenticated, quota'd endpoint. Do not serve raw phone lookups
   over SEP-2.
5. **Delivery to a non-user.** Claimable balance (CAP-23) plus sponsorship
   (CAP-33), already scoped in the stealth-address work. A fresh G-account plus
   a USDC trustline costs 1.5 XLM; a claimable balance avoids it because the
   destination need not exist yet.

## 8. The synthesis this project should be built around

**Identifier naming and stealth addresses fix each other's defect.**

Naming's fatal flaw is that resolving to a stable address leaks balance history
to anyone who sweeps the identifier space. Stealth addresses' fatal flaw is
that they have no discovery channel — no way to tell a sender where to look.
Point the resolver at a *fresh one-time address per lookup* and both problems
dissolve: enumeration yields nothing correlatable, and stealth gains the
discovery layer it was missing.

See the stealth-address work, veil #1318–#1325.

This also argues for keeping the work in `veil` as new identifier *types* on
the existing registry, rather than a fresh repo — the exception being the
attestor service, which needs its own secrets, telco contracts and NDPC
registration, and where a separate entity is a legal firewall rather than just
tidiness.

## 9. What to cut from v1

Ship **email only**, verified by DKIM proof, with no pepper service. Email has
a cryptographic ownership proof; phone does not. You get the trustless story,
skip the SMS budget, skip the hardest piece of infrastructure, and avoid a
telco dependency that cannot yet be negotiated. Add phone in v2 once an
attestor entity exists and `expires_at` has been load-bearing for months.

## 10. Decisions required before any code

1. **Path or domain?** A new domain means the project can never drive an
   existing Veil wallet's `__check_auth`. A path under `app.useveilapp.xyz`
   keeps the passkey but ties the brand.
2. **G-accounts or `C…` addresses?** Classic senders can pay a G-address and
   SEP-30 can guard it. Neither is true of Veil's `C…` address. If the point is
   "pay this from anywhere," that argues for G.
3. **Sole issuer, or recruit a second?** Vibrant needed Lobstr. One issuer
   means Veil can unilaterally reassign anyone's identifier.
4. **Is the resolver public?** Everything above hinges on this, and SEP-2
   compliance and anti-enumeration cannot both be satisfied on one endpoint.

## 11. Two spikes that de-risk most of it

- Measure a BN254 Groth16 verify against Soroban's real metering (CAP-0074 says
  calibration is TBD; the pure-Rust number does not fit the budget).
- Measure zkEmail proving on a low-end Android, against the documented WASM
  memory ceiling.

Roughly a week each.

## Sources

- Contact discovery attacks — <https://encrypto.de/papers/HWSDS22.pdf>,
  <https://www.ndss-symposium.org/wp-content/uploads/ndss2021_1C-3_23159_paper.pdf>
- SocialConnect — <https://github.com/celo-org/SocialConnect>,
  <https://raw.githubusercontent.com/celo-org/Social-Connect/main/docs/privacy.md>
- ODIS — <https://docs.celo.org/tooling/libraries-sdks/contractkit/odis>
- SEP-2 — <https://github.com/stellar/stellar-protocol/blob/master/ecosystem/sep-0002.md>
- SEP-30 — <https://github.com/stellar/stellar-protocol/blob/master/ecosystem/sep-0030.md>
- SEP-45 — <https://stellar.org/protocol/sep-45>
- CAP-0074 (BN254) — <https://github.com/stellar/stellar-protocol/blob/master/core/cap-0074.md>
- CAP-0084 (muxed contracts) — <https://github.com/stellar/stellar-protocol/blob/master/core/cap-0084.md>
- Protocol 30 upgrade guide — <https://stellar.org/blog/developers/bell-protocol-30-upgrade-guide>
- Vibrant pay-by-phone — <https://www.stellar.org/developers-blog/making-international-remittances-easy-with-pay-by-phone>
- zkEmail — <https://docs.zk.email/architecture/>, <https://blog.aayushg.com/zkemail/>,
  <https://discuss.ens.domains/t/spp2-zk-email-application/20450>
- NCC TIRMS and SIM recycling — <https://www.premiumtimesng.com/news/top-news/867143-ncc-introduces-platform-to-regulate-recycling-of-phone-numbers-sim-fraud.html>,
  <https://kolaking.substack.com/p/how-sim-recycling-systemic-gaps-expose>
- CBN–NCC identity risk system — <https://new.intellinews.com/articles/nigeria-launches-identity-risk-management-system-to-curb-sim-swap-fraud-in-banking-system-439048>
- NDPA 2023 — <https://cert.gov.ng/ngcert/resources/Nigeria_Data_Protection_Act_2023.pdf>,
  <https://securiti.ai/overview-of-nigeria-data-protection-act/>
- WebAuthn ROR and RP ID — <https://web.dev/articles/webauthn-related-origin-requests>,
  <https://www.corbado.com/blog/webauthn-relying-party-id-rpid-passkeys>
- SMS pricing — <https://esmsafrica.io/sms-pricing>
