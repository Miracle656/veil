import { Keypair } from '@stellar/stellar-sdk';

import {
  claimRetiredFeePayer,
  findRetiredFeePayerWithBalance,
  type RetiredCleanupDeps,
} from '../retiredFeePayerCleanup';

const OLD_KEY = Keypair.random();
const CURRENT_KEY = Keypair.random();

function makeDeps(overrides: Partial<RetiredCleanupDeps> = {}): RetiredCleanupDeps {
  return {
    getRetiredSecrets: jest.fn(async () => [OLD_KEY.secret()]),
    getCurrentSecret: jest.fn(async () => CURRENT_KEY.secret()),
    removeRetiredSecret: jest.fn(async () => undefined),
    loadAccount: jest.fn(async () => ({ xlm: 2.6, subentryCount: 3, hasOtherAssets: false })),
    moveAccount: jest.fn(async () => 'tx-cleanup-hash'),
    ...overrides,
  };
}

describe('retiredFeePayerCleanup', () => {
  it('finds a retired spending key that still holds leftover XLM', async () => {
    const deps = makeDeps();
    const candidate = await findRetiredFeePayerWithBalance(deps);

    expect(candidate).toEqual({
      secret: OLD_KEY.secret(),
      address: OLD_KEY.publicKey(),
      xlm: 2.6,
      hasOtherAssets: false,
    });
    expect(deps.removeRetiredSecret).not.toHaveBeenCalled();
  });

  it('removes a retired key only when its account is confirmed merged (404) or empty', async () => {
    const deps = makeDeps({
      loadAccount: jest.fn(async () => null),
    });

    const candidate = await findRetiredFeePayerWithBalance(deps);
    expect(candidate).toBeNull();
    expect(deps.removeRetiredSecret).toHaveBeenCalledWith(OLD_KEY.secret());
  });

  it('does not delete a retired key when the network lookup fails', async () => {
    const deps = makeDeps({
      loadAccount: jest.fn(async () => {
        throw new Error('horizon unreachable');
      }),
    });

    const candidate = await findRetiredFeePayerWithBalance(deps);
    expect(candidate).toBeNull();
    expect(deps.removeRetiredSecret).not.toHaveBeenCalled();
  });

  it('claims leftover XLM and deletes the retired key only after confirming the account is merged', async () => {
    const loadAccount = jest.fn(async () => null);
    const deps = makeDeps({ loadAccount });
    const candidate = {
      secret: OLD_KEY.secret(),
      address: OLD_KEY.publicKey(),
      xlm: 2.6,
      hasOtherAssets: false,
    };

    const outcome = await claimRetiredFeePayer(candidate, deps);

    expect(outcome).toEqual({
      claimed: true,
      txHash: 'tx-cleanup-hash',
      from: OLD_KEY.publicKey(),
      to: CURRENT_KEY.publicKey(),
      amountXlm: 2.6,
    });
    expect(deps.moveAccount).toHaveBeenCalledWith({
      fromSecret: OLD_KEY.secret(),
      to: CURRENT_KEY.publicKey(),
      toSecret: CURRENT_KEY.secret(),
      xlmAmount: '0',
    });
    expect(deps.removeRetiredSecret).toHaveBeenCalledWith(OLD_KEY.secret());
  });

  it('keeps the retired key if the move fails or the account is not yet empty afterwards', async () => {
    const depsFail = makeDeps({
      moveAccount: jest.fn(async () => {
        throw new Error('tx failed');
      }),
    });
    const candidate = {
      secret: OLD_KEY.secret(),
      address: OLD_KEY.publicKey(),
      xlm: 2.6,
      hasOtherAssets: false,
    };

    const failOutcome = await claimRetiredFeePayer(candidate, depsFail);
    expect(failOutcome).toEqual({ claimed: false, reason: 'tx failed' });
    expect(depsFail.removeRetiredSecret).not.toHaveBeenCalled();

    const depsStillFunded = makeDeps({
      loadAccount: jest.fn(async () => ({ xlm: 1.0, subentryCount: 0, hasOtherAssets: false })),
    });
    const okOutcome = await claimRetiredFeePayer(candidate, depsStillFunded);
    expect(okOutcome.claimed).toBe(true);
    expect(depsStillFunded.removeRetiredSecret).not.toHaveBeenCalled();
  });
});
