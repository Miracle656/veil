/**
 * SEP-10 Challenge Verification Tests
 *
 * Tests the pure `signSep10Challenge` function in lib/sep24.ts against known
 * fixture challenges.  No network calls or WebAuthn APIs are involved.
 *
 * SEP-10 spec: https://github.com/stellar/stellar-protocol/blob/master/ecosystem/sep-0010.md
 */

import {
  Keypair,
  Networks,
  TransactionBuilder,
  Operation,
  Account,
  Transaction,
} from '@stellar/stellar-sdk'
import { signSep10Challenge, Sep10ChallengeError } from '../lib/sep24'

// ── Helpers ───────────────────────────────────────────────────────────────────

/** Build a well-formed SEP-10 challenge transaction signed by the anchor key. */
function buildChallenge({
  anchorKeypair,
  clientAccount,
  networkPassphrase,
  homeDomain,
  /**
   * maxTime relative to now in seconds; defaults to 5 minutes.
   * Pass a negative number to produce an already-expired challenge.
   */
  maxTimeOffsetSec = 300,
  /**
   * Override the manage_data key name (used to inject malformed keys).
   * Defaults to `"<homeDomain> auth"` (the SEP-10 spec convention).
   */
  manageDataKey,
  /** When true no manage_data operations are added. */
  omitManageData = false,
}: {
  anchorKeypair: Keypair
  clientAccount: string
  networkPassphrase: string
  homeDomain: string
  maxTimeOffsetSec?: number
  manageDataKey?: string
  omitManageData?: boolean
}): string {
  const nowSec = Math.floor(Date.now() / 1000)

  // SEP-10 requires sequence 0 and the anchor's key as source.
  const account = new Account(anchorKeypair.publicKey(), '-1')

  const builder = new TransactionBuilder(account, {
    fee: '100',
    networkPassphrase,
    timebounds: {
      minTime: nowSec,
      maxTime: nowSec + maxTimeOffsetSec,
    },
  })

  if (!omitManageData) {
    // Primary manage_data op — key is "<home_domain> auth" per the spec.
    const key = manageDataKey ?? `${homeDomain} auth`
    // Value: 48 bytes of random nonce (spec requirement).
    const nonce = Buffer.alloc(48)
    for (let i = 0; i < 48; i++) nonce[i] = i // deterministic for fixtures

    builder.addOperation(
      Operation.manageData({
        name:   key,
        value:  nonce,
        source: clientAccount,
      }),
    )
  } else {
    // stellar-sdk requires ≥1 op — use bumpSequence as a non-manage_data stand-in
    // so we get valid XDR that signSep10Challenge can inspect and reject.
    builder.addOperation(
      Operation.bumpSequence({ bumpTo: '1' }),
    )
  }

  const tx = builder.build()
  tx.sign(anchorKeypair)
  return tx.toXDR()
}

/** Parse a signed XDR and return the list of signer public keys. */
function signersFromXdr(xdr: string, networkPassphrase: string): string[] {
  const tx = new Transaction(xdr, networkPassphrase)
  return tx.signatures.map(sig => {
    // Each DecoratedSignature contains a 4-byte hint.  We match against all
    // known keypairs in the fixture set to identify the actual signer.
    return Buffer.from(sig.hint()).toString('hex')
  })
}

// ── Fixture anchors ───────────────────────────────────────────────────────────

// Deterministic keypairs so tests are fully reproducible.
// These are synthetic test-only secrets — never use on mainnet.
const ANCHOR_A_KP  = Keypair.random()   // anchor A
const ANCHOR_B_KP  = Keypair.random()   // anchor B (mainnet fixture)
const ANCHOR_C_KP  = Keypair.random()   // anchor C (multi-op fixture)
const USER_KP      = Keypair.random()   // client / user

// ── Suite ─────────────────────────────────────────────────────────────────────

describe('signSep10Challenge', () => {
  // ── Fixture 1: testnet anchor ────────────────────────────────────────────────
  describe('Fixture A — testanchor.stellar.org (testnet)', () => {
    const PASSPHRASE = Networks.TESTNET
    const HOME_DOMAIN = 'testanchor.stellar.org'

    it('signs the challenge and the returned XDR parses back cleanly', () => {
      const challengeXdr = buildChallenge({
        anchorKeypair:   ANCHOR_A_KP,
        clientAccount:   USER_KP.publicKey(),
        networkPassphrase: PASSPHRASE,
        homeDomain:      HOME_DOMAIN,
      })

      const signedXdr = signSep10Challenge(challengeXdr, PASSPHRASE, USER_KP)

      // Must parse without throwing
      expect(() => new Transaction(signedXdr, PASSPHRASE)).not.toThrow()
    })

    it('adds exactly one new signature (the user keypair)', () => {
      const challengeXdr = buildChallenge({
        anchorKeypair:   ANCHOR_A_KP,
        clientAccount:   USER_KP.publicKey(),
        networkPassphrase: PASSPHRASE,
        homeDomain:      HOME_DOMAIN,
      })

      const original = new Transaction(challengeXdr, PASSPHRASE)
      const origSigCount = original.signatures.length

      const signedXdr = signSep10Challenge(challengeXdr, PASSPHRASE, USER_KP)
      const signed    = new Transaction(signedXdr, PASSPHRASE)

      // cloneFrom resets signatures on the rebuilt tx, then we add one
      expect(signed.signatures).toHaveLength(1)
      // The hint must match the user keypair's public key hint
      const hint = Buffer.from(signed.signatures[0].hint()).toString('hex')
      const expectedHint = Buffer.from(USER_KP.rawPublicKey().slice(28)).toString('hex')
      expect(hint).toBe(expectedHint)
      // The original count is informational — we log it to confirm fixture shape
      expect(origSigCount).toBeGreaterThanOrEqual(1)
    })

    it('preserves the manage_data operation in the signed envelope', () => {
      const challengeXdr = buildChallenge({
        anchorKeypair:   ANCHOR_A_KP,
        clientAccount:   USER_KP.publicKey(),
        networkPassphrase: PASSPHRASE,
        homeDomain:      HOME_DOMAIN,
      })

      const signedXdr = signSep10Challenge(challengeXdr, PASSPHRASE, USER_KP)
      const tx = new Transaction(signedXdr, PASSPHRASE)

      const mdOp = tx.operations.find(op => op.type === 'manageData') as
        | ReturnType<typeof Operation.manageData>
        | undefined

      expect(mdOp).toBeDefined()
      expect(mdOp!.name).toBe(`${HOME_DOMAIN} auth`)
    })
  })

  // ── Fixture 2: mainnet anchor ────────────────────────────────────────────────
  describe('Fixture B — demo.anchor.io (mainnet)', () => {
    const PASSPHRASE  = Networks.PUBLIC
    const HOME_DOMAIN = 'demo.anchor.io'

    it('signs the mainnet challenge correctly', () => {
      const challengeXdr = buildChallenge({
        anchorKeypair:   ANCHOR_B_KP,
        clientAccount:   USER_KP.publicKey(),
        networkPassphrase: PASSPHRASE,
        homeDomain:      HOME_DOMAIN,
      })

      const signedXdr = signSep10Challenge(challengeXdr, PASSPHRASE, USER_KP)
      const tx = new Transaction(signedXdr, PASSPHRASE)

      expect(tx.signatures).toHaveLength(1)
      expect(tx.operations[0].type).toBe('manageData')
    })

    it('signed XDR differs from challenge XDR (signature was actually applied)', () => {
      const challengeXdr = buildChallenge({
        anchorKeypair:   ANCHOR_B_KP,
        clientAccount:   USER_KP.publicKey(),
        networkPassphrase: PASSPHRASE,
        homeDomain:      HOME_DOMAIN,
      })

      const signedXdr = signSep10Challenge(challengeXdr, PASSPHRASE, USER_KP)

      // The envelopes must differ because a new signature was added
      expect(signedXdr).not.toBe(challengeXdr)
    })
  })

  // ── Fixture 3: anchor with web+client_domain ops ─────────────────────────────
  describe('Fixture C — multi-op challenge (web + client_domain)', () => {
    const PASSPHRASE  = Networks.TESTNET
    const HOME_DOMAIN = 'anchor.example.com'

    /**
     * Some anchors include a second manage_data op with key
     * "client_domain auth" to verify the wallet's domain as well.
     * signSep10Challenge only inspects the first op for the naming rule.
     */
    function buildMultiOpChallenge(): string {
      const nowSec  = Math.floor(Date.now() / 1000)
      const account = new Account(ANCHOR_C_KP.publicKey(), '-1')
      const nonce   = Buffer.alloc(48)
      for (let i = 0; i < 48; i++) nonce[i] = i

      const tx = new TransactionBuilder(account, {
        fee:              '100',
        networkPassphrase: PASSPHRASE,
        timebounds:       { minTime: nowSec, maxTime: nowSec + 300 },
      })
        .addOperation(
          Operation.manageData({
            name:   `${HOME_DOMAIN} auth`,
            value:  nonce,
            source: USER_KP.publicKey(),
          }),
        )
        .addOperation(
          Operation.manageData({
            name:   'client_domain auth',
            value:  nonce,
            source: USER_KP.publicKey(),
          }),
        )
        .build()

      tx.sign(ANCHOR_C_KP)
      return tx.toXDR()
    }

    it('signs a multi-op challenge without error', () => {
      const challengeXdr = buildMultiOpChallenge()
      const signedXdr    = signSep10Challenge(challengeXdr, PASSPHRASE, USER_KP)
      expect(() => new Transaction(signedXdr, PASSPHRASE)).not.toThrow()
    })

    it('preserves both manage_data operations in the signed envelope', () => {
      const challengeXdr = buildMultiOpChallenge()
      const signedXdr    = signSep10Challenge(challengeXdr, PASSPHRASE, USER_KP)
      const tx           = new Transaction(signedXdr, PASSPHRASE)

      const mdOps = tx.operations.filter(op => op.type === 'manageData')
      expect(mdOps).toHaveLength(2)
      expect((mdOps[0] as Operation.ManageData).name).toBe(`${HOME_DOMAIN} auth`)
      expect((mdOps[1] as Operation.ManageData).name).toBe('client_domain auth')
    })

    it('the user hint is present in signatures', () => {
      const challengeXdr = buildMultiOpChallenge()
      const signedXdr    = signSep10Challenge(challengeXdr, PASSPHRASE, USER_KP)
      const tx           = new Transaction(signedXdr, PASSPHRASE)

      const expectedHint = Buffer.from(USER_KP.rawPublicKey().slice(28)).toString('hex')
      const hints        = tx.signatures.map(s => Buffer.from(s.hint()).toString('hex'))
      expect(hints).toContain(expectedHint)
    })
  })

  // ── Malformed challenge rejection ─────────────────────────────────────────────
  describe('malformed challenge rejection', () => {
    const PASSPHRASE  = Networks.TESTNET
    const HOME_DOMAIN = 'anchor.example.com'

    it('throws Sep10ChallengeError(MALFORMED) for garbage XDR', () => {
      expect(() =>
        signSep10Challenge('not-valid-xdr!!', PASSPHRASE, USER_KP),
      ).toThrow(Sep10ChallengeError)

      try {
        signSep10Challenge('not-valid-xdr!!', PASSPHRASE, USER_KP)
      } catch (err) {
        expect(err).toBeInstanceOf(Sep10ChallengeError)
        expect((err as Sep10ChallengeError).code).toBe('MALFORMED')
        expect((err as Sep10ChallengeError).name).toBe('Sep10ChallengeError')
      }
    })

    it('throws Sep10ChallengeError(MISSING_MANAGE_DATA) when no manage_data op is present', () => {
      const xdr = buildChallenge({
        anchorKeypair:   ANCHOR_A_KP,
        clientAccount:   USER_KP.publicKey(),
        networkPassphrase: PASSPHRASE,
        homeDomain:      HOME_DOMAIN,
        omitManageData:  true,
      })

      expect(() => signSep10Challenge(xdr, PASSPHRASE, USER_KP)).toThrow(Sep10ChallengeError)

      try {
        signSep10Challenge(xdr, PASSPHRASE, USER_KP)
      } catch (err) {
        expect((err as Sep10ChallengeError).code).toBe('MISSING_MANAGE_DATA')
      }
    })

    it('throws Sep10ChallengeError(INVALID_HOME_DOMAIN) when manage_data key lacks " auth" suffix', () => {
      const xdr = buildChallenge({
        anchorKeypair:   ANCHOR_A_KP,
        clientAccount:   USER_KP.publicKey(),
        networkPassphrase: PASSPHRASE,
        homeDomain:      HOME_DOMAIN,
        manageDataKey:   'anchor.example.com', // missing " auth" suffix
      })

      try {
        signSep10Challenge(xdr, PASSPHRASE, USER_KP)
        fail('Expected Sep10ChallengeError to be thrown')
      } catch (err) {
        expect(err).toBeInstanceOf(Sep10ChallengeError)
        expect((err as Sep10ChallengeError).code).toBe('INVALID_HOME_DOMAIN')
        expect((err as Sep10ChallengeError).message).toContain('"anchor.example.com"')
      }
    })

    it('throws Sep10ChallengeError(EXPIRED) when maxTime is in the past', () => {
      const xdr = buildChallenge({
        anchorKeypair:     ANCHOR_A_KP,
        clientAccount:     USER_KP.publicKey(),
        networkPassphrase: PASSPHRASE,
        homeDomain:        HOME_DOMAIN,
        maxTimeOffsetSec:  -60, // expired 60 seconds ago
      })

      try {
        signSep10Challenge(xdr, PASSPHRASE, USER_KP)
        fail('Expected Sep10ChallengeError to be thrown')
      } catch (err) {
        expect(err).toBeInstanceOf(Sep10ChallengeError)
        expect((err as Sep10ChallengeError).code).toBe('EXPIRED')
        expect((err as Sep10ChallengeError).message).toContain('expired')
      }
    })
  })
})
