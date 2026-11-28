# Stealth payments with Stellar claimable balances

**Issue:** #1321
**Scope:** the send half of a Stellar stealth payment, plus current main's fee-bump claim helper for a missing one-time account. Creating an issued-asset trustline at claim time remains a separate flow.

## Decision: the sender carries the unclaimed reserve

The account that signs and funds `create_claimable_balance` is the reserve holder while the balance is unclaimed. For this implementation that is the sender, not Veil.

This keeps Veil out of custody and avoids a platform account that every stealth payment passes through. CAP-33 sponsorship is not needed for the unclaimed send because the sender is already the transaction source and ledger account. Current main's claim helper can create a missing one-time account from the fee payer; sponsorship remains available for later trustline setup.

The tradeoff is explicit: the sender must have enough spendable XLM for the two-claimant claimable-balance reserve and the transaction fee until the receiver claims or the sender reclaims.

## Send path

`sendStealthPayment` derives a one-time Stellar address and creates a CAP-23 claimable balance with two claimants:

| Claimant | Predicate | Effect |
|---|---|---|
| Derived one-time address | Unconditional | The receiver is eligible to claim at any time. |
| Sender address | `NOT BEFORE_ABSOLUTE_TIME(deadline)` | The sender can reclaim only at or after the deadline. |

The first successful claim consumes the balance. If the receiver claims first, a later sender reclaim fails because the balance no longer exists; the time predicate does not give the sender a second claim on an already-consumed balance. If both are eligible after the deadline, whichever claim is included first wins.

### Address derivation

The receiver publishes a 64-byte meta-address encoded as 128 hexadecimal characters:

```text
identity.publicKey = X25519_public_key (32 bytes) || Ed25519_public_key_A (32 bytes)
identity.secretKey = X25519_secret_key_x (32 bytes) || Ed25519_secret_scalar_a (32 bytes)
```

The Ed25519 secret is scalar material interpreted as a big-endian integer modulo the Ed25519 order, not a seed that is hashed again by a high-level signing API.

The sender generates an ephemeral X25519 key pair `(r, R)` and computes:

```text
sharedSecret = X25519(r, recipientX25519PublicKey)
h = SHA256(
  "veil/stealth-payment/v2"
  || networkPassphrase
  || sharedSecret
  || R
) mod L
P = h * A
```

The one-time Stellar address is the StrKey encoding of `P`. The receiver recovers the same shared secret with `X25519(x, R)` and derives the one-time private scalar:

```text
p = h * a mod L
```

The sender knows `h` but not `a`, so the sender cannot derive `p`. This replaces the earlier construction in which both parties derived the same one-time seed and the sender could therefore spend the payment.

The recovered signer signs the transaction hash with the domain-separated scalar:

```text
prefix = SHA512("veil/stealth-payment/v2/sign" || p_as_32_byte_big_endian)[0:32]
k = SHA512(prefix || transactionHash) mod L
R_signature = k * G
e = SHA512(R_signature || P || transactionHash) mod L
S = k + e * p mod L
signature = R_signature || S_as_32_byte_little_endian
```

Including the network passphrase in `h` separates testnet and mainnet derivations. The send result contains the full one-time address and ephemeral public key. The caller must deliver those values, the balance ID, and the network to the receiver over an authenticated channel. The ephemeral private key is not needed by the receiver and must not be delivered. The receiver's identity secret must be retained to recover the signer.

### SDK usage

Receiver setup, kept by the receiver:

```ts
const identity = createStealthIdentity();
// Publish identity.publicKey. Keep identity.secretKey private.
```

Send:

```ts
const payment = await sendStealthPayment({
  sender,
  recipientPublicKey: receiverPublicKey,
  amount: '0.0000001',
  asset: Asset.native(),
  claimDeadlineSeconds: 3600,
  config: {
    horizonUrl: 'https://horizon.stellar.org',
    networkPassphrase: Networks.PUBLIC,
  },
});

// Deliver payment.address, payment.ephemeralPublicKey,
// payment.balanceId, and the network to the receiver.
```

Recovery and claim, with a separately chosen fee payer:

```ts
const signer = recoverStealthSigner({
  secretKey: identity.secretKey,
  ephemeralPublicKey: payment.ephemeralPublicKey,
  oneTimeAddress: payment.address,
  balanceId: payment.balanceId,
  networkPassphrase: Networks.PUBLIC,
});

const claim = await claimEscrowWithFeeBump({
  claimant: signer,
  feePayer,
  balanceId: payment.balanceId,
  config: {
    horizonUrl: 'https://horizon.stellar.org',
    networkPassphrase: Networks.PUBLIC,
  },
});
```

`recoverStealthSigner` does not expose the private scalar. It rejects a different network or a recovered address that does not match the supplied one-time address. The returned signer accepts only a classic transaction sourced by that one-time address with exactly one `claimClaimableBalance` operation for the bound balance ID.

`claimEscrowWithFeeBump` separates authorization from payment: the one-time key signs the inner claim, and the fee payer signs the fee bump. An existing one-time account needs no XLM to pay the claim fee. If the account does not exist, the helper first creates it with 1 XLM from the fee payer, then submits the claim. The fee source and any account creation are public ledger links; the helper does not create an issued-asset trustline, which the receiver must establish before claiming that asset.

## Reserve and fee accounting

CAP-23 reserves `claimants.size × baseReserve` for a claimable balance, regardless of whether its asset is native or issued. At a 0.5 XLM base reserve, this send path has:

| Asset | Reserve formula | XLM locked while unclaimed |
|---|---|---:|
| Native XLM | 2 claimants × 1 base reserve | 1.0 XLM |
| USDC or another issued asset | 2 claimants × 1 base reserve | 1.0 XLM |

`claimableBalanceReserveXlm(baseReserveXlm)` exposes this calculation. The transaction fee is separate: it is charged when the create transaction is included and is not returned when the balance is claimed or reclaimed. The SDK defaults to Veil's network inclusion-fee policy and returns Horizon's actual `fee_charged` alongside the transaction hash.

The reserved XLM becomes unavailable to the sender, but Horizon's displayed native `balance` does not decrease merely because the reserve becomes unavailable. The measurement harness therefore sums live sponsored claimable balances as `claimants.length × baseReserve` and measures that delta separately from native-asset debits and fees. Its preflight uses the account minimum-balance formula, including `num_sponsoring`, without subtracting those same sponsored reserves a second time.

The sender must already have a trustline for an issued asset, and that trustline's existing 0.5 XLM reserve remains separate; creating this claimable balance does not add another trustline reserve. The issue's 1.5 XLM receiver cost is the 1.0 XLM account reserve plus a 0.5 XLM trustline reserve. The send path creates neither the receiver account nor its trustline. The fee-bump claim helper can fund account creation when needed, but trustline setup remains separate.

## If the balance is never claimed

A claimable balance does not expire automatically. The sender can reclaim it at or after `expiresAt`; reclamation returns the asset and releases the reserve to the sender, less the reclaim transaction fee. If neither the receiver nor the sender ever claims, the asset and reserve remain locked indefinitely.

The sender should therefore retain the balance ID and deadline until the balance is claimed or reclaimed. The SDK computes the deterministic balance ID and transaction hash before submission and preserves them on an ambiguous submission error or a successful response with an unexpected transaction hash. The measurement harness prints the full creation evidence before waiting, recovers that context if Horizon times out after accepting the create, and reconciles an ambiguously submitted reclaim by its preserved transaction hash instead of blindly submitting another reclaim.

## Mainnet evidence

The approved measurement uses `FUNDER_SECRET` from the environment, creates one minimal native balance and one minimal USDC balance on mainnet, and reclaims each after its deadline. It sends no funds to third parties and reports the actual reserve, charged fees, full addresses, full balance IDs, and full transaction hashes. The secret is never printed, committed, or passed as a command-line argument.

No mainnet measurement transaction has been submitted because `FUNDER_SECRET` is not present in the execution environment. There are intentionally no mainnet hashes in this document yet; testnet evidence must not be presented as mainnet evidence.

Reproduction commands, after setting `FUNDER_SECRET` securely in the environment:

```sh
npm --prefix sdk run build
node scripts/measure-claimable-balance.mjs --network mainnet --asset usdc --apply
node scripts/measure-claimable-balance.mjs --network mainnet --asset native --apply
```

## Testnet evidence: secure v2 native create and reclaim

The successful testnet run used the compiled v2 SDK, a fresh friendbot-funded sender, a minimal native amount, and a 20-second claim window. Both transactions were successful and the one-time account did not exist before creation or after reclaim.

| Field | Value |
|---|---|
| Sender and reserve holder | `GDYPUM2CLEIFXUDPAHGO22CN7BLZ2YAHH5WFOAMH2OGQ4T76ULNCB2BZ` |
| Recipient meta-address | `bfc3bdd21add4421b218dc12687a0d8fa7b35d50aa1c232a0a518c254b5f6224653f3a421bbbac45288d2bd164f14eea19cc30a2e986e3a9829114405d304ce5` |
| One-time claimant | `GCZTU452EQ2LGI4I62Y63B7SAIY2D56JVP355YEF3SV2Y5G3P3OMCD4P` |
| Ephemeral X25519 public key | `2212d993b0b19fc84a4196b68b9a5cdfab18f840b2519d26efe20f061501e20c` |
| Balance ID | `00000000011b1d325799db1b3c2cc155c07cde489ace1647ba6a04d8941fa99ec2509581` |
| Deadline | `1795562914` (`2026-11-24T23:28:34Z`) |
| Create transaction | `d91ae3d61b7fe247ae26452c268ec847dbf8bf8c638e0b2eca0e93f1d68e62c9` |
| Create ledger | `5907851` |
| Reclaim transaction | `685569ff78c81b2b798a9a44dd107689269f06db7a8692cbaaf4feba4af57bec` |
| Reclaim ledger | `5907856` |

Horizon returned the exact unconditional receiver predicate and `NOT BEFORE_ABSOLUTE_TIME(1795562914)` sender predicate. The live sponsored-balance count moved `0 → 1 → 0`.

| Measurement | Result |
|---|---:|
| Claimable-balance reserve while unclaimed | `10000000` stroops / `1.0000000` XLM |
| Native amount | `1` stroop / `0.0000001` XLM |
| Create fee charged | `100` stroops / `0.0000100` XLM |
| Native debit at creation | `101` stroops / `0.0000101` XLM |
| Reclaim fee charged | `100` stroops / `0.0000100` XLM |
| Native amount returned | `1` stroop / `0.0000001` XLM |
| Reserve released | `10000000` stroops / `1.0000000` XLM |
| Net native cost | `200` stroops / `0.0000200` XLM |

## Testnet evidence: issued asset create and reclaim

A separate testnet run used a fresh issuer and the `USDC` asset code to exercise issued-asset accounting. This was not canonical Circle USDC and is not mainnet evidence. The issuer funding, trustline creation, and initial issuance happened before the measurement snapshot, so their fees are excluded from the reported net cost.

| Field | Value |
|---|---|
| Sender and reserve holder | `GDYPUM2CLEIFXUDPAHGO22CN7BLZ2YAHH5WFOAMH2OGQ4T76ULNCB2BZ` |
| Test issuer | `GAMYWFC5BAP6SQ3RU2B4JTLPHT5JZDYUPSBIWEL63FW3QUXPNESOYWJH` |
| Test asset | `USDC:GAMYWFC5BAP6SQ3RU2B4JTLPHT5JZDYUPSBIWEL63FW3QUXPNESOYWJH` |
| Recipient meta-address | `2e578492415d573f5d8ba1750c636350aee658a45860e2f829ab6d760c4a89252fa38648ba02bc485e218c8287b0908f2f0de1c11575579e1de46651e4e5284a` |
| One-time claimant | `GBKD4JDYSMZIIDVBHYFYPOSGBUPPBLDUINZ26PXUOJZNL62SK7S7VZ4R` |
| Ephemeral X25519 public key | `4239d7b213c4b586bb60de18960b14abfd39dabaaff32c16862f1f535be1e616` |
| Balance ID | `00000000c5e693bdc7ea0e50012ef2ce61a1a3e22abdefecc47e8e916aea43ab443be16f` |
| Deadline | `1795562958` (`2026-11-24T23:29:18Z`) |
| Create transaction | `2cae9ff2899d15e714ed51d282101d7f1ce23f2d6f5988753dbb85fd8dcbeddb` |
| Create ledger | `5907860` |
| Reclaim transaction | `9a7864a835b71ba0760df1f1009778021d2df7ea28bdb0e66a42c839b1fa2abd` |
| Reclaim ledger | `5907865` |

Horizon returned the exact unconditional receiver predicate and `NOT BEFORE_ABSOLUTE_TIME(1795562958)` sender predicate. The live sponsored-balance count moved `0 → 1 → 0`.

| Measurement | Result |
|---|---:|
| Claimable-balance reserve while unclaimed | `10000000` stroops / `1.0000000` XLM |
| Issued-asset amount | `1` stroop / `0.0000001` USDC |
| Create fee charged | `100` stroops / `0.0000100` XLM |
| Native debit at creation | `100` stroops / `0.0000100` XLM |
| Issued-asset debit at creation | `1` stroop / `0.0000001` USDC |
| Reclaim fee charged | `100` stroops / `0.0000100` XLM |
| Issued asset returned | `1` stroop / `0.0000001` USDC |
| Reserve released | `10000000` stroops / `1.0000000` XLM |
| Net native cost | `200` stroops / `0.0000200` XLM |
| Net issued-asset cost | `0` |

The issued-asset fixture can be reproduced on testnet with a funded `FUNDER_SECRET`; the harness creates and funds a separate random issuer automatically:

```sh
node scripts/measure-claimable-balance.mjs --network testnet --asset usdc --test-asset --apply
```

## Testnet evidence: receiver claim consumes the balance

A final testnet run created a minimal native balance, funded the derived one-time account with friendbot to satisfy the transaction-source requirement, recovered the v2 signer, and claimed successfully. It exercises first-claim consumption rather than fee-bump account creation, which has separate unit coverage. After the deadline, the sender's reclaim was rejected by Stellar with `op_does_not_exist`, confirming that the time predicate cannot reclaim an already-consumed balance.

| Field | Value |
|---|---|
| Sender | `GAB6OWJJHPD3Q657O3JSGUJJVAG77RJ743JQB53ONRT3C57RALRRJKAF` |
| One-time claimant and claim source | `GDG2HZ4XVLIAKMAR663S25EPG3WQOXYK6EKVDNFAIQCZTWHBMJEJFWEK` |
| Ephemeral X25519 public key | `cf0583c52fbdace96fc15f42213d5965536dbfad1992b108b1b84914c1a82e28` |
| Balance ID | `0000000032a2ea097d2faf9f2440b819810c3d4126ce7df15790d5c6a77e3f5267d85199` |
| Deadline | `1795558533` |
| Create transaction | `7b69448350e1af18d6441ecb9b6fe3c0efc80df68b67da6b4bbefc85d1857ae8` |
| Receiver claim transaction | `a629293e9546e02707dd63f9947209cd063ce65cf16f1f32dc7548df24fc08e9` |
| Claim ledger | `5906981` |
| Claim fee charged | `100` stroops / `0.0000100` XLM |
| Sender reclaim after claim | HTTP `400`, `tx_failed`, `op_does_not_exist` |

## SDK bundle budget

The root SDK bundle includes the Noble X25519/Ed25519 implementation, SHA-256, SHA-512, and the send/recovery wrapper. It does not add a Buffer polyfill: Stellar's XDR constructor accepts `Uint8Array` signature hints and signatures directly. Removing that redundant polyfill saved 5,269 B after Brotli compression. The reserve helper, fee reporting, and signer recovery are required by the issue and were retained.

Measured with the repository's `size-limit` configuration, minified and brotlied:

| Entry point | Current main (`4035923a`) | This change | Delta | Budget | Headroom |
|---|---:|---:|---:|---:|---:|
| Main SDK | 237,314 B | 252,898 B | +15,584 B | 256,000 B | 3,102 B |
| Vanilla | 216,234 B | 216,502 B | +268 B | 225,000 B | 8,498 B |

The main entry point grows by 15,584 B. Current main is already 2,314 B over its former 235,000 B ceiling, so the 256,000 B ceiling clears that pre-existing drift and leaves 3,102 B after the complete secure v2 implementation, including SHA-512 scalar signing. Reusing Noble's existing byte-conversion helpers avoids duplicate implementations, and passing byte arrays directly to Stellar XDR avoids bundling a second Buffer implementation. No feature was removed to meet the budget.
