/**
 * Rescuing a random fallback fee-payer.
 *
 * The two account shapes pinned here are real: they are the two users found on
 * 2026-11-04, read off Horizon. One of them is the reason this module merges
 * instead of sweeping — every drop of their balance is reserve, so a payment
 * would have moved nothing and reported success.
 */

import {
    DUST_XLM,
    planFeePayerRepair,
    type RepairInputs,
} from '../feePayerRepair';
import {
    checkPrfDerivation,
    repairRandomFeePayer,
    repairSnapshotFromHorizon,
    type HeldKey,
    type RepairRunDeps,
} from '../feePayerRepairRun';

const RANDOM_FP = 'GBXRZP2PXOZKBSNLRUAAPEZUG3ZMR2JDOYRTZ22KNBCYRC4LFJAGHLTP';
const OTHER_FP = 'GDXMCV2LBW24U5ONKR2BBD24OKUIFUX4ECK7CUUA7XNU4H6IMEP2JQRR';
const PRF_FP = 'GA2CDKKI5XY575WCB33XCRCGUZZVA6NODDJWHB7VHXVDRYZ356VI6FNW';
const USDC_ISSUER = 'GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN';

function inputs(over: Partial<RepairInputs> = {}): RepairInputs {
    return {
        source: 'random',
        currentAddress: RANDOM_FP,
        currentXlm: 5,
        currentSubentryCount: 0,
        currentTrustlines: [],
        currentDataNames: [],
        derivedAddress: PRF_FP,
        derivedXlm: null,
        ...over,
    };
}

describe('planFeePayerRepair — refusals', () => {
    it('refuses when the passkey returned no PRF, so there is no safe destination', () => {
        expect(planFeePayerRepair(inputs({ derivedAddress: null }))).toEqual({
            action: 'none',
            reason: 'no-prf',
        });
    });

    it('leaves a fee-payer alone when it is already derivable', () => {
        expect(planFeePayerRepair(inputs({ source: 'prf' }))).toEqual({
            action: 'none',
            reason: 'not-random',
        });
        expect(planFeePayerRepair(inputs({ source: 'credential-id' }))).toEqual({
            action: 'none',
            reason: 'not-random',
        });
        // A keypair-mode testnet wallet *is* its own fee-payer; moving it would
        // move the wallet.
        expect(planFeePayerRepair(inputs({ source: 'keypair' }))).toEqual({
            action: 'none',
            reason: 'not-random',
        });
    });

    it('does nothing when the derivation produces the account already in use', () => {
        expect(planFeePayerRepair(inputs({ derivedAddress: RANDOM_FP }))).toEqual({
            action: 'none',
            reason: 'same-account',
        });
    });

    it('does nothing for an account that was never funded', () => {
        expect(planFeePayerRepair(inputs({ currentXlm: null }))).toEqual({
            action: 'none',
            reason: 'source-empty',
        });
    });
});

describe('planFeePayerRepair — the two real users', () => {
    // GBXRZP2P… — 2.5138937 XLM, 3 subentries (a USDC trustline and
    // veil:pk1/veil:pk2), holding 0.0600470 USDC. Reserve is 2.5 of the 2.51.
    const allReserve = inputs({
        currentAddress: RANDOM_FP,
        currentXlm: 2.5138937,
        currentSubentryCount: 3,
        currentTrustlines: [{ code: 'USDC', issuer: USDC_ISSUER, balance: 0.060047 }],
        currentDataNames: ['veil:pk1', 'veil:pk2'],
    });

    // GDXMCV2L… — 7.9334326 XLM, 2 subentries, holding 1.2 USDC.
    const mostlyFree = inputs({
        currentAddress: OTHER_FP,
        currentXlm: 7.9334326,
        currentSubentryCount: 2,
        currentTrustlines: [{ code: 'USDC', issuer: USDC_ISSUER, balance: 1.2 }],
        currentDataNames: ['veil:wallet'],
    });

    it('reports the all-reserve account as blocked rather than sweeping nothing', () => {
        // A payment here would move a negative amount, or be rounded to
        // nothing and reported as a success. Naming the blocker is the whole
        // point: the USDC has to move over Soroban before the account can close.
        const plan = planFeePayerRepair(allReserve);
        expect(plan).toEqual({
            action: 'blocked',
            from: RANDOM_FP,
            to: PRF_FP,
            blockers: [
                { blocker: 'token-balance', code: 'USDC', issuer: USDC_ISSUER, balance: 0.060047 },
            ],
        });
    });

    it('moves what sits above the reserve when the rest is blocked', () => {
        const plan = planFeePayerRepair(mostlyFree);
        expect(plan.action).toBe('repair');
        if (plan.action !== 'repair') throw new Error('expected a repair');

        // 7.9334326 − (1 account + 2×0.5 subentry + 0.1 headroom) = 5.8334326
        expect(plan.steps).toEqual([{ step: 'send-xlm', amount: '5.8334326' }]);
        expect(plan.closesAccount).toBe(false);
        expect(plan.blockers).toHaveLength(1);
    });

    it('still names the blocker on a partial recovery, so nobody reads it as done', () => {
        const plan = planFeePayerRepair(mostlyFree);
        if (plan.action !== 'repair') throw new Error('expected a repair');
        expect(plan.blockers[0]).toMatchObject({ code: 'USDC', balance: 1.2 });
    });
});

describe('planFeePayerRepair — closing the account', () => {
    it('clears every subentry and merges when nothing holds a balance', () => {
        const plan = planFeePayerRepair(
            inputs({
                currentXlm: 2.5,
                currentSubentryCount: 3,
                currentTrustlines: [{ code: 'USDC', issuer: USDC_ISSUER, balance: 0 }],
                currentDataNames: ['veil:pk1', 'veil:pk2'],
            }),
        );
        if (plan.action !== 'repair') throw new Error('expected a repair');

        expect(plan.steps).toEqual([
            { step: 'close-trustline', code: 'USDC', issuer: USDC_ISSUER },
            { step: 'delete-data', name: 'veil:pk1' },
            { step: 'delete-data', name: 'veil:pk2' },
            { step: 'create-destination', amount: '1.0000000' },
            { step: 'merge' },
        ]);
        expect(plan.closesAccount).toBe(true);
        // The merge returns the account's own reserve too, which a payment
        // could never have reached.
        expect(plan.recoverableXlm).toBe('2.4000000');
    });

    it('skips creating a destination that already exists', () => {
        const plan = planFeePayerRepair(inputs({ currentXlm: 3, derivedXlm: 1.5 }));
        if (plan.action !== 'repair') throw new Error('expected a repair');
        expect(plan.steps.some((s) => s.step === 'create-destination')).toBe(false);
        expect(plan.steps[plan.steps.length - 1]).toEqual({ step: 'merge' });
    });

    it('refuses dust, where the fee would eat the recovery', () => {
        expect(planFeePayerRepair(inputs({ currentXlm: 0.1 + DUST_XLM / 2 }))).toEqual({
            action: 'none',
            reason: 'below-reserve',
        });
    });
});

describe('repairSnapshotFromHorizon', () => {
    it('separates trustlines from native and lists the data entries', () => {
        const snapshot = repairSnapshotFromHorizon({
            balances: [
                { asset_type: 'credit_alphanum4', balance: '1.2000000', asset_code: 'USDC', asset_issuer: USDC_ISSUER },
                { asset_type: 'native', balance: '7.9334326' },
            ],
            subentry_count: 2,
            data_attr: { 'veil:wallet': 'Q0FSTQ==' },
        });
        expect(snapshot).toEqual({
            xlm: 7.9334326,
            subentryCount: 2,
            trustlines: [{ code: 'USDC', issuer: USDC_ISSUER, balance: 1.2 }],
            dataNames: ['veil:wallet'],
        });
    });
});

describe('checkPrfDerivation', () => {
    it('reports the address a working passkey derives', async () => {
        const result = await checkPrfDerivation(async () => ({ secret: 'S_PRF', address: PRF_FP }));
        expect(result).toEqual({ available: true, address: PRF_FP });
    });

    it('reports unavailable when the passkey returns no PRF', async () => {
        expect(await checkPrfDerivation(async () => null)).toEqual({
            available: false,
            address: null,
        });
    });

    it('treats a thrown ceremony as unavailable rather than letting it escape', async () => {
        // A cancelled prompt is not proof the device lacks PRF, so this must
        // not be recorded as a capability answer — but it must not throw into
        // a screen either.
        const result = await checkPrfDerivation(async () => {
            throw new Error('NotAllowedError');
        });
        expect(result).toEqual({ available: false, address: null });
    });
});

describe('repairRandomFeePayer', () => {
    const current: HeldKey = { secret: 'S_RANDOM', address: RANDOM_FP };
    const derived: HeldKey = { secret: 'S_PRF', address: PRF_FP };

    function deps(over: Partial<RepairRunDeps> = {}): RepairRunDeps {
        return {
            derivePrfKey: jest.fn(async () => derived),
            currentKey: jest.fn(async () => current),
            currentSource: jest.fn(async () => 'random' as const),
            loadAccount: jest.fn(async (address: string) =>
                address === RANDOM_FP
                    ? { xlm: 3, subentryCount: 0, trustlines: [], dataNames: [] }
                    : null,
            ),
            submit: jest.fn(async () => 'TXHASH'),
            adopt: jest.fn(async () => undefined),
            ...over,
        };
    }

    it('submits the plan and only then adopts the derived key', async () => {
        const d = deps();
        const outcome = await repairRandomFeePayer(d);

        expect(outcome).toMatchObject({ repaired: true, txHash: 'TXHASH', from: RANDOM_FP, to: PRF_FP });
        expect(d.submit).toHaveBeenCalledWith('S_RANDOM', PRF_FP, expect.any(Array));
        expect(d.adopt).toHaveBeenCalledWith(derived);
    });

    it('does NOT adopt when submission fails, so the money is never orphaned', async () => {
        // The failure this module exists to prevent: forgetting the key that
        // still holds the balance.
        const d = deps({
            submit: jest.fn(async () => {
                throw new Error('tx_failed');
            }),
        });
        const outcome = await repairRandomFeePayer(d);

        expect(outcome).toEqual({ repaired: false, error: 'tx_failed' });
        expect(d.adopt).not.toHaveBeenCalled();
    });

    it('hands back the plan when there is nothing to do, rather than a bare failure', async () => {
        const d = deps({ currentSource: jest.fn(async () => 'prf' as const) });
        const outcome = await repairRandomFeePayer(d);

        expect(outcome).toEqual({ repaired: false, plan: { action: 'none', reason: 'not-random' } });
        expect(d.submit).not.toHaveBeenCalled();
    });

    it('never submits when the device no longer holds the random secret', async () => {
        const d = deps({ currentKey: jest.fn(async () => null) });
        expect(await repairRandomFeePayer(d)).toEqual({ repaired: false, error: 'no-current-secret' });
        expect(d.submit).not.toHaveBeenCalled();
    });
});
