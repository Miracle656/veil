/**
 * Deciding whether a stranded fee-payer should be swept.
 *
 * Written from a mainnet incident: a wallet created under the credential-id
 * derivation, reinstalled onto a PRF build, which then showed an address that
 * has never existed on the network while 6.865 XLM sat in the account it had
 * abandoned.
 *
 * The assertions that matter most are the refusals. This moves somebody's money
 * between two accounts without asking, so every reason not to has to be pinned
 * harder than the happy path.
 */
import {
  ACCOUNT_RESERVE_XLM,
  BASE_RESERVE_XLM,
  SWEEP_FEE_HEADROOM_XLM,
  planFeePayerRecovery,
  retainedForSweep,
  type RecoveryInputs,
} from '../feePayerRecovery';

const PRF = 'GA2CDKKI5XY575WCB33XCRCGUZZVA6NODDJWHB7VHXVDRYZ356VI6FNW';
const LEGACY = 'GC5S3DWEG3E5KJZDEOBKQE5KE4UKOYCZVOH5ZZNR6RTCSJK7QAOSWTLN';

/** The real signer from the incident wallet, X and Y as written on chain. */
const SIGNER = new Uint8Array([
  4, 103, 204, 201, 18, 181, 217, 219, 117, 202, 74, 82, 11, 76, 85, 29, 158, 8, 19, 186, 58, 165,
  43, 63, 147, 17, 62, 38, 173, 186, 208, 164, 131, 139, 127, 135, 139, 42, 193, 85, 155, 145, 162,
  54, 60, 24, 24, 22, 30, 94, 17, 170, 84, 240, 145, 255, 106, 166, 86, 83, 241, 248, 4, 96, 31,
]);

const OTHER_SIGNER = new Uint8Array(SIGNER);
OTHER_SIGNER[64] = (OTHER_SIGNER[64]! ^ 0xff) & 0xff;

/** The incident, as it actually stood: 3 subentries (a trustline + 2 crumbs). */
function incident(overrides: Partial<RecoveryInputs> = {}): RecoveryInputs {
  return {
    prfAddress: PRF,
    prfBalanceXlm: null, // 404 on Horizon — never funded
    legacyAddress: LEGACY,
    legacyBalanceXlm: 6.865085,
    legacySubentryCount: 3,
    legacyCrumbSigner: SIGNER,
    walletSigner: SIGNER,
    ...overrides,
  };
}

describe('the reported incident', () => {
  it('sweeps what is movable and leaves the reserve behind', () => {
    const plan = planFeePayerRecovery(incident());
    expect(plan.action).toBe('sweep');
    if (plan.action !== 'sweep') return;

    expect(plan.from).toBe(LEGACY);
    expect(plan.to).toBe(PRF);
    // 1 for the account, 0.5 × 3 subentries, 0.1 of fee headroom.
    expect(plan.retainedXlm).toBeCloseTo(2.6, 7);
    expect(plan.amount).toBe('4.2650850');
  });

  it('never moves the reserve, which cannot leave the account anyway', () => {
    const plan = planFeePayerRecovery(incident());
    if (plan.action !== 'sweep') throw new Error('expected a sweep');
    const left = 6.865085 - Number(plan.amount);
    expect(left).toBeGreaterThanOrEqual(ACCOUNT_RESERVE_XLM + 3 * BASE_RESERVE_XLM);
    // And enough on top to still pay a fee.
    expect(left).toBeGreaterThanOrEqual(
      ACCOUNT_RESERVE_XLM + 3 * BASE_RESERVE_XLM + SWEEP_FEE_HEADROOM_XLM - 1e-7,
    );
  });
});

describe('refusals', () => {
  it('does nothing when the PRF account already holds something', () => {
    // Someone funded it, or a previous sweep ran. Moving money here could race
    // a transaction already in flight.
    expect(planFeePayerRecovery(incident({ prfBalanceXlm: 0.0001 }))).toEqual({
      action: 'none',
      reason: 'prf-funded',
    });
  });

  it('does nothing without a credential id to derive from', () => {
    expect(planFeePayerRecovery(incident({ legacyAddress: null }))).toEqual({
      action: 'none',
      reason: 'no-legacy-candidate',
    });
  });

  it('does nothing when both derivations agree', () => {
    expect(planFeePayerRecovery(incident({ legacyAddress: PRF }))).toEqual({
      action: 'none',
      reason: 'same-account',
    });
  });

  it('does nothing when the legacy account is unfunded or missing', () => {
    expect(planFeePayerRecovery(incident({ legacyBalanceXlm: null })).action).toBe('none');
    expect(planFeePayerRecovery(incident({ legacyBalanceXlm: 0 }))).toEqual({
      action: 'none',
      reason: 'legacy-empty',
    });
  });

  it('REFUSES a funded account whose breadcrumbs name a different signer', () => {
    // The whole safety argument. A derivation landing on a funded account is
    // not evidence it belongs to this wallet; the breadcrumbs are, because only
    // that passkey's holder could have written them. Without this, a collision
    // or a bad address would move a stranger's money.
    expect(planFeePayerRecovery(incident({ legacyCrumbSigner: OTHER_SIGNER }))).toEqual({
      action: 'none',
      reason: 'unproven',
    });
  });

  it('REFUSES when the account carries no breadcrumbs at all', () => {
    expect(planFeePayerRecovery(incident({ legacyCrumbSigner: null }))).toEqual({
      action: 'none',
      reason: 'unproven',
    });
  });

  it('REFUSES when the wallet signer is unknown', () => {
    // Nothing to check the breadcrumbs against means nothing is proved.
    expect(planFeePayerRecovery(incident({ walletSigner: null }))).toEqual({
      action: 'none',
      reason: 'unproven',
    });
  });

  it('refuses an account consumed entirely by its own reserve', () => {
    // 1 XLM with a trustline open: every drop is reserve.
    expect(
      planFeePayerRecovery(incident({ legacyBalanceXlm: 1.4, legacySubentryCount: 1 })),
    ).toEqual({ action: 'none', reason: 'below-reserve' });
  });

  it('refuses dust, where the fee would eat most of what moved', () => {
    const retained = retainedForSweep(3);
    expect(
      planFeePayerRecovery(incident({ legacyBalanceXlm: retained + 0.005 })),
    ).toEqual({ action: 'none', reason: 'below-reserve' });
  });
});

describe('reserve arithmetic', () => {
  it('charges the account reserve plus one base reserve per subentry', () => {
    expect(retainedForSweep(0)).toBeCloseTo(1 + 0.1, 7);
    expect(retainedForSweep(1)).toBeCloseTo(1.5 + 0.1, 7);
    expect(retainedForSweep(3)).toBeCloseTo(2.5 + 0.1, 7);
  });

  it('treats a nonsense subentry count as none rather than throwing', () => {
    expect(retainedForSweep(-4)).toBe(retainedForSweep(0));
    expect(retainedForSweep(2.7)).toBe(retainedForSweep(2));
  });

  it('grows the amount retained as subentries are added', () => {
    const a = planFeePayerRecovery(incident({ legacySubentryCount: 1 }));
    const b = planFeePayerRecovery(incident({ legacySubentryCount: 5 }));
    if (a.action !== 'sweep' || b.action !== 'sweep') throw new Error('expected sweeps');
    expect(Number(b.amount)).toBeLessThan(Number(a.amount));
    expect(b.retainedXlm - a.retainedXlm).toBeCloseTo(4 * BASE_RESERVE_XLM, 7);
  });

  it('emits an amount Stellar will accept — seven decimal places', () => {
    const plan = planFeePayerRecovery(incident());
    if (plan.action !== 'sweep') throw new Error('expected a sweep');
    expect(plan.amount).toMatch(/^\d+\.\d{7}$/);
  });
});
