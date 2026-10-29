/**
 * Carrying out a stranded-fee-payer sweep.
 *
 * `planFeePayerRecovery` decides; this decides nothing. What is pinned here is
 * the orchestration around that decision — that it proves before it moves, that
 * it never sends anywhere but the wallet's own PRF account, that it does not
 * pay for Horizon round trips it does not need, and above all that it cannot
 * take a sign-in down with it.
 */
import { snapshotFromHorizon, sweepStrandedFeePayer, type SweepDeps } from '../feePayerSweep';

const WALLET = 'CARM3RKO7MDAHVAR7RP3AEMO2GXVHRLA5FSEZD5OE2WARCADCEKGDK62';
const PRF = 'GA2CDKKI5XY575WCB33XCRCGUZZVA6NODDJWHB7VHXVDRYZ356VI6FNW';
const LEGACY = 'GC5S3DWEG3E5KJZDEOBKQE5KE4UKOYCZVOH5ZZNR6RTCSJK7QAOSWTLN';
const SECRET = 'SATOSHIFAKESECRETFAKESECRETFAKESECRETFAKESECRETFAKESECRE';

const SIGNER = new Uint8Array(65);
SIGNER[0] = 4;
SIGNER.fill(7, 1);

const STRANGER = new Uint8Array(65);
STRANGER[0] = 4;
STRANGER.fill(9, 1);

function deps(over: Partial<SweepDeps> = {}): SweepDeps {
  return {
    loadAccount: jest.fn(async (address: string) =>
      address === LEGACY ? { xlm: 6.865085, subentryCount: 3 } : null,
    ),
    readCrumbSigner: jest.fn(async () => SIGNER),
    readWalletSigner: jest.fn(async () => SIGNER),
    sendXlm: jest.fn(async () => 'tx_hash_abc'),
    ...over,
  };
}

const args = {
  walletAddress: WALLET,
  prfAddress: PRF,
  legacyAddress: LEGACY,
  legacySecret: SECRET,
};

describe('the happy path', () => {
  it('moves the movable balance to the wallet own PRF account', async () => {
    const d = deps();
    const out = await sweepStrandedFeePayer(args, d);

    expect(out).toEqual({
      swept: true,
      amount: '4.2650850',
      txHash: 'tx_hash_abc',
      from: LEGACY,
      to: PRF,
    });
    // The destination is derived, never taken from a caller or a screen.
    expect(d.sendXlm).toHaveBeenCalledWith(SECRET, PRF, '4.2650850');
  });
});

describe('it proves before it moves', () => {
  it('refuses when the breadcrumbs name a different signer', async () => {
    const d = deps({ readCrumbSigner: jest.fn(async () => STRANGER) });
    await expect(sweepStrandedFeePayer(args, d)).resolves.toEqual({
      swept: false,
      reason: 'unproven',
    });
    expect(d.sendXlm).not.toHaveBeenCalled();
  });

  it('refuses when the account carries no breadcrumbs', async () => {
    const d = deps({ readCrumbSigner: jest.fn(async () => null) });
    await expect(sweepStrandedFeePayer(args, d)).resolves.toEqual({
      swept: false,
      reason: 'unproven',
    });
    expect(d.sendXlm).not.toHaveBeenCalled();
  });

  it('does not read the proof when there is nothing worth proving', async () => {
    // An unfunded legacy account means no sweep whatever the breadcrumbs say,
    // so two Horizon round trips per sign-in would be paid for nothing.
    const d = deps({ loadAccount: jest.fn(async () => null) });
    const out = await sweepStrandedFeePayer(args, d);
    expect(out.swept).toBe(false);
    expect(d.readCrumbSigner).not.toHaveBeenCalled();
    expect(d.readWalletSigner).not.toHaveBeenCalled();
  });
});

describe('it never moves money it should not', () => {
  it('does nothing when the PRF account is already funded', async () => {
    const d = deps({
      loadAccount: jest.fn(async (address: string) =>
        address === PRF ? { xlm: 3, subentryCount: 0 } : { xlm: 6.8, subentryCount: 3 },
      ),
    });
    await expect(sweepStrandedFeePayer(args, d)).resolves.toEqual({
      swept: false,
      reason: 'prf-funded',
    });
    expect(d.sendXlm).not.toHaveBeenCalled();
  });

  it('does nothing without the legacy secret, even with a valid plan', async () => {
    const d = deps();
    await expect(
      sweepStrandedFeePayer({ ...args, legacySecret: null }, d),
    ).resolves.toEqual({ swept: false, reason: 'no-legacy-secret' });
    expect(d.sendXlm).not.toHaveBeenCalled();
  });

  it('does nothing when there is no legacy candidate at all', async () => {
    const d = deps();
    const out = await sweepStrandedFeePayer({ ...args, legacyAddress: null }, d);
    expect(out).toEqual({ swept: false, reason: 'no-legacy-candidate' });
    expect(d.sendXlm).not.toHaveBeenCalled();
  });
});

describe('it cannot take a sign-in down', () => {
  it('reports a Horizon failure rather than throwing', async () => {
    const d = deps({
      loadAccount: jest.fn(async () => {
        throw new Error('Horizon unreachable');
      }),
    });
    await expect(sweepStrandedFeePayer(args, d)).resolves.toEqual({
      swept: false,
      reason: 'Horizon unreachable',
    });
  });

  it('reports a failed submission rather than throwing', async () => {
    // The money is still where it was, which is the state the user is already
    // in. A sign-in that failed because of this would be strictly worse.
    const d = deps({
      sendXlm: jest.fn(async () => {
        throw new Error('tx_insufficient_fee');
      }),
    });
    await expect(sweepStrandedFeePayer(args, d)).resolves.toEqual({
      swept: false,
      reason: 'tx_insufficient_fee',
    });
  });
});

describe('snapshotFromHorizon', () => {
  it('reads the native balance and the subentry count', () => {
    expect(
      snapshotFromHorizon({
        balances: [
          { asset_type: 'credit_alphanum4', balance: '0.0000000' },
          { asset_type: 'native', balance: '6.8650850' },
        ],
        subentry_count: 3,
      }),
    ).toEqual({ xlm: 6.865085, subentryCount: 3 });
  });

  it('reports zero rather than null for an account with no XLM line', () => {
    // An account that exists always has a native balance; treating a missing
    // one as "does not exist" would read an odd response as a sweep candidate.
    expect(snapshotFromHorizon({ balances: [], subentry_count: 0 })).toEqual({
      xlm: 0,
      subentryCount: 0,
    });
  });
});
