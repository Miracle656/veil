/**
 * Moving every asset off a spending account in one transaction.
 *
 * The figures in the first group are the real ones from 2026-11-14: an account
 * holding 7.8776763 XLM and 31.07 USDC behind three subentries, on a random key
 * that died with an uninstall. The repair that existed then would have moved
 * 5.2776763 XLM, replaced the stored key, and left the USDC behind for good.
 */
import { Account, Keypair, Networks, type Transaction } from '@stellar/stellar-sdk';

import {
  MoveRefusedError,
  fromStroops,
  holdsOtherAssets,
  planMove,
  submitMove,
  toStroops,
  type MoveAccount,
} from '../feePayerMove';

const USDC_ISSUER = 'GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN';
const usdc = (balance: string, extra: Record<string, unknown> = {}) => ({
  asset_type: 'credit_alphanum4',
  asset_code: 'USDC',
  asset_issuer: USDC_ISSUER,
  balance,
  selling_liabilities: '0.0000000',
  is_authorized: true,
  ...extra,
});
const native = (balance: string) => ({ asset_type: 'native', balance });

/** The stranded account as Horizon reported it. */
const INCIDENT: MoveAccount = {
  balances: [usdc('31.0700000'), native('7.8776763')],
  subentry_count: 3,
  num_sponsoring: 0,
  num_sponsored: 0,
};
/** What the existing arithmetic says may leave: balance − (1 + 3 × 0.5 + 0.1). */
const INCIDENT_MOVABLE = toStroops('5.2776763');

describe('amounts', () => {
  it('round-trips a Stellar amount through stroops without floating point', () => {
    expect(toStroops('31.0700000')).toBe(310_700_000n);
    expect(toStroops('0.0000001')).toBe(1n);
    expect(toStroops('7')).toBe(70_000_000n);
    expect(fromStroops(310_700_000n)).toBe('31.0700000');
    expect(fromStroops(1n)).toBe('0.0000001');
  });

  it('refuses something that is not an amount', () => {
    expect(() => toStroops('1e3')).toThrow();
    expect(() => toStroops('-1')).toThrow();
  });
});

describe('planMove — the account from the incident', () => {
  it('carries the USDC as well as the XLM, into an account that does not exist yet', () => {
    const plan = planMove({ from: INCIDENT, to: null, xlmStroops: INCIDENT_MOVABLE, hasDestinationKey: true });

    expect(plan).toEqual({
      ok: true,
      createsAccount: true,
      xlmStroops: INCIDENT_MOVABLE,
      assets: [{ code: 'USDC', issuer: USDC_ISSUER, amount: '31.0700000', needsTrustline: true }],
      // One trustline closes on the old account, releasing one base reserve.
      freedStroops: 5_000_000n,
    });
  });

  it('does not open a second trustline on an account that already trusts the asset', () => {
    const to: MoveAccount = { balances: [usdc('0.0000000'), native('3.0000000')], subentry_count: 1 };
    const plan = planMove({ from: INCIDENT, to, xlmStroops: INCIDENT_MOVABLE, hasDestinationKey: false });

    expect(plan).toMatchObject({ ok: true, createsAccount: false });
    expect(plan.ok && plan.assets[0]!.needsTrustline).toBe(false);
  });

  it('ignores a trustline with nothing in it', () => {
    const from: MoveAccount = { balances: [usdc('0.0000000'), native('7.8776763')], subentry_count: 3 };
    const plan = planMove({ from, to: null, xlmStroops: INCIDENT_MOVABLE, hasDestinationKey: true });
    expect(plan).toMatchObject({ ok: true, assets: [], freedStroops: 0n });
  });
});

describe('planMove — it moves everything or nothing', () => {
  const base = { to: null, xlmStroops: INCIDENT_MOVABLE, hasDestinationKey: true } as const;

  it('refuses when the new account could not hold what arrives', () => {
    // 1.4 XLM cannot cover an account (1.0) and a trustline (0.5).
    expect(planMove({ ...base, from: INCIDENT, xlmStroops: toStroops('1.4') })).toEqual({
      ok: false,
      reason: 'destination-reserve',
    });
  });

  it('refuses when an existing new account is too thin for another trustline', () => {
    const to: MoveAccount = { balances: [native('1.2000000')], subentry_count: 0 };
    expect(planMove({ from: INCIDENT, to, xlmStroops: 0n, hasDestinationKey: true })).toEqual({
      ok: false,
      reason: 'destination-reserve',
    });
  });

  it('refuses a trustline it cannot sign for', () => {
    expect(planMove({ ...base, from: INCIDENT, hasDestinationKey: false })).toEqual({
      ok: false,
      reason: 'no-destination-key',
    });
  });

  it('refuses an asset tied up in an open sell offer', () => {
    const from = { ...INCIDENT, balances: [usdc('31.0700000', { selling_liabilities: '5.0000000' }), native('7.8776763')] };
    expect(planMove({ ...base, from })).toEqual({ ok: false, reason: 'open-offers' });
  });

  it('refuses an asset the issuer has frozen', () => {
    const from = { ...INCIDENT, balances: [usdc('31.0700000', { is_authorized: false }), native('7.8776763')] };
    expect(planMove({ ...base, from })).toEqual({ ok: false, reason: 'frozen-asset' });
  });

  it('refuses liquidity pool shares, which a payment cannot carry', () => {
    const from = {
      ...INCIDENT,
      balances: [{ asset_type: 'liquidity_pool_shares', balance: '10.0000000' }, native('7.8776763')],
    };
    expect(planMove({ ...base, from })).toEqual({ ok: false, reason: 'pool-shares' });
  });

  it('refuses an account involved in sponsorship, where the reserve sums differ', () => {
    expect(planMove({ ...base, from: { ...INCIDENT, num_sponsored: 1 } })).toEqual({
      ok: false,
      reason: 'sponsorship',
    });
  });
});

describe('holdsOtherAssets', () => {
  it('is true only for a non-zero balance in something other than XLM', () => {
    expect(holdsOtherAssets(INCIDENT)).toBe(true);
    expect(holdsOtherAssets({ balances: [usdc('0.0000000'), native('7')] })).toBe(false);
    expect(holdsOtherAssets({ balances: [native('7')] })).toBe(false);
  });
});

// ── The transaction itself ───────────────────────────────────────────────────

const mockLoadAccount = jest.fn();
const mockSubmit = jest.fn();

jest.mock('@stellar/stellar-sdk', () => {
  const actual = jest.requireActual('@stellar/stellar-sdk');
  return {
    ...actual,
    Horizon: {
      ...actual.Horizon,
      Server: jest.fn(() => ({ loadAccount: mockLoadAccount, submitTransaction: mockSubmit })),
    },
  };
});

const FROM = Keypair.random();
const TO = Keypair.random();
const net = { horizonUrl: 'https://horizon.example', networkPassphrase: Networks.PUBLIC };

function horizonAccount(address: string, fields: MoveAccount) {
  return Object.assign(new Account(address, '100'), fields);
}
function notFound() {
  return Object.assign(new Error('Not Found'), { response: { status: 404 } });
}

describe('submitMove', () => {
  beforeEach(() => {
    mockLoadAccount.mockReset();
    mockSubmit.mockReset().mockResolvedValue({ hash: 'abc123' });
  });

  it('builds one transaction that moves the XLM, the USDC and the freed reserve', async () => {
    mockLoadAccount.mockImplementation(async (address: string) => {
      if (address === FROM.publicKey()) return horizonAccount(address, INCIDENT);
      throw notFound();
    });

    const hash = await submitMove({
      fromSecret: FROM.secret(),
      to: TO.publicKey(),
      toSecret: TO.secret(),
      xlmAmount: '5.2776763',
      net,
      fee: '100',
    });

    expect(hash).toBe('abc123');
    const tx = mockSubmit.mock.calls[0][0] as Transaction;
    expect(tx.source).toBe(FROM.publicKey());
    expect(tx.operations.map((op) => op.type)).toEqual([
      'createAccount',
      'changeTrust',
      'payment',
      'changeTrust',
      'payment',
    ]);

    const [create, openLine, payUsdc, closeLine, payFreed] = tx.operations as unknown as Array<
      Record<string, unknown> & { source?: string }
    >;
    expect(create).toMatchObject({ destination: TO.publicKey(), startingBalance: '5.2776763' });
    // The new account opens its own trustline, so the operation is sourced from it.
    expect(openLine!.source).toBe(TO.publicKey());
    expect(payUsdc).toMatchObject({ destination: TO.publicKey(), amount: '31.0700000' });
    expect((payUsdc!.asset as { code: string; issuer: string }).code).toBe('USDC');
    // The old account closes its trustline, so a later USDC payment bounces.
    expect(closeLine!.source).toBeUndefined();
    expect(closeLine).toMatchObject({ limit: '0.0000000' });
    expect(payFreed).toMatchObject({ destination: TO.publicKey(), amount: '0.5000000' });

    // Both keys sign: the old one for the payments, the new one for its trustline.
    expect(tx.signatures).toHaveLength(2);
  });

  it('sends nothing and throws when the plan refuses', async () => {
    mockLoadAccount.mockImplementation(async (address: string) => {
      if (address === FROM.publicKey()) {
        return horizonAccount(address, {
          ...INCIDENT,
          balances: [usdc('31.0700000', { is_authorized: false }), native('7.8776763')],
        });
      }
      throw notFound();
    });

    await expect(
      submitMove({ fromSecret: FROM.secret(), to: TO.publicKey(), toSecret: TO.secret(), xlmAmount: '5.2776763', net, fee: '100' }),
    ).rejects.toEqual(new MoveRefusedError('frozen-asset'));
    expect(mockSubmit).not.toHaveBeenCalled();
  });

  it('does not read a failed lookup as "this account does not exist"', async () => {
    // Treating a timeout as a missing account would build a createAccount for
    // an account that exists, and the whole transaction would fail.
    mockLoadAccount.mockImplementation(async (address: string) => {
      if (address === FROM.publicKey()) return horizonAccount(address, INCIDENT);
      throw new Error('network timeout');
    });

    await expect(
      submitMove({ fromSecret: FROM.secret(), to: TO.publicKey(), toSecret: TO.secret(), xlmAmount: '5.2776763', net, fee: '100' }),
    ).rejects.toThrow('network timeout');
    expect(mockSubmit).not.toHaveBeenCalled();
  });

  it('ignores a destination secret that belongs to some other account', async () => {
    mockLoadAccount.mockImplementation(async (address: string) => {
      if (address === FROM.publicKey()) return horizonAccount(address, INCIDENT);
      throw notFound();
    });

    await expect(
      submitMove({
        fromSecret: FROM.secret(),
        to: TO.publicKey(),
        toSecret: Keypair.random().secret(),
        xlmAmount: '5.2776763',
        net,
        fee: '100',
      }),
    ).rejects.toEqual(new MoveRefusedError('no-destination-key'));
    expect(mockSubmit).not.toHaveBeenCalled();
  });
});
