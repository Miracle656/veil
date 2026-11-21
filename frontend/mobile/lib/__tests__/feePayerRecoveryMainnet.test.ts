/**
 * The planner, run against the real mainnet wallet it was written for.
 *
 * Every number and every byte below was read off public mainnet on
 * 2026-10-30, not invented:
 *
 *   contract        CARM3RKO7MDAHVAR7RP3AEMO2GXVHRLA5FSEZD5OE2WARCADCEKGDK62
 *   legacy account  GC5S3DWEG3E5KJZDEOBKQE5KE4UKOYCZVOH5ZZNR6RTCSJK7QAOSWTLN
 *                   6.8650850 XLM, 3 subentries, veil:pk1 + veil:pk2 present
 *   PRF account     GA2CDKKI5XY575WCB33XCRCGUZZVA6NODDJWHB7VHXVDRYZ356VI6FNW
 *                   404 on Horizon — it has never existed
 *
 * The contract's sole signer (instance storage key `Signers`, index 0) is
 * byte-for-byte the key the two data entries reconstruct, which is what makes
 * this account provably the wallet's own: only the holder of that passkey
 * could have written those entries.
 *
 * This is a fixture test, not a network test — it pins the DECISION, so a
 * later change to the reserve arithmetic or to the proof cannot silently stop
 * recovering this balance.
 */

import { planFeePayerRecovery, retainedForSweep } from '../feePayerRecovery';

const CONTRACT_SIGNER_HEX =
  '0467ccc912b5d9db75ca4a520b4c551d9e0813ba3aa52b3f93113e26adbad0a4' +
  '838b7f878b2ac1559b91a2363c1818161e5e11aa54f091ff6aa65653f1f804601f';

const LEGACY = 'GC5S3DWEG3E5KJZDEOBKQE5KE4UKOYCZVOH5ZZNR6RTCSJK7QAOSWTLN';
const PRF = 'GA2CDKKI5XY575WCB33XCRCGUZZVA6NODDJWHB7VHXVDRYZ356VI6FNW';

function hexBytes(hex: string): Uint8Array {
  return new Uint8Array(hex.match(/../g)!.map((b) => parseInt(b, 16)));
}

const signer = hexBytes(CONTRACT_SIGNER_HEX);

const REAL = {
  prfAddress: PRF,
  prfBalanceXlm: null, // 404 on Horizon
  legacyAddress: LEGACY,
  legacyBalanceXlm: 6.865085,
  legacySubentryCount: 3, // two data entries + one trustline
  legacyCrumbSigner: signer,
  walletSigner: signer,
};

it('recovers the stranded balance, to the stroop', () => {
  const plan = planFeePayerRecovery(REAL);

  expect(plan.action).toBe('sweep');
  if (plan.action !== 'sweep') return;
  expect(plan.from).toBe(LEGACY);
  expect(plan.to).toBe(PRF);
  // 6.8650850 − (1 account + 3 × 0.5 subentries + 0.1 fee headroom)
  expect(plan.retainedXlm).toBeCloseTo(2.6, 7);
  expect(plan.amount).toBe('4.2650850');
});

it('leaves the breadcrumbs payable, so the account is not bricked', () => {
  // The sweep must not strip the account below what its own three subentries
  // need, or the entries that prove ownership could never be rewritten.
  expect(retainedForSweep(3)).toBeCloseTo(2.6, 7);
  expect(6.865085 - retainedForSweep(3)).toBeGreaterThan(0);
});

it('refuses the same account if the breadcrumbs named a different signer', () => {
  // The guard that stops a derivation collision, or someone else's address,
  // from moving money. One flipped byte is enough.
  const tampered = hexBytes(CONTRACT_SIGNER_HEX);
  tampered[40] ^= 0x01;
  const plan = planFeePayerRecovery({ ...REAL, legacyCrumbSigner: tampered });

  expect(plan).toEqual({ action: 'none', reason: 'unproven' });
});

it('does nothing once the PRF account holds anything at all', () => {
  // After a successful sweep this is the state, so a second sign-in must not
  // try again and must not race a transaction in flight.
  const plan = planFeePayerRecovery({ ...REAL, prfBalanceXlm: 4.265085 });

  expect(plan).toEqual({ action: 'none', reason: 'prf-funded' });
});
