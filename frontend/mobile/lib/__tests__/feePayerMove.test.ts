/**
 * Moving every asset off a spending account in one transaction.
 *
 * Covers both the 2026-11-14 incident (7.8776763 XLM + 31.07 USDC) and the
 * build 29 case (2.66 XLM + empty USDC trustline + veil:pk1 + veil:pk2).
 */
import { Account, Keypair, Networks, type Transaction } from '@stellar/stellar-sdk';
import { Buffer } from 'buffer';

import {
  MoveRefusedError,
  fromStroops,
  holdsOtherAssets,
  planMove,
  submitMove,
  toStroops,
  type MoveAccount,
} from '../feePayerMove';
import { CRUMB_PK1, CRUMB_PK2, readBreadcrumbs } from '../walletBreadcrumbs';

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

// Deterministic 65-byte uncompressed P-256 public key for breadcrumb tests.
const SAMPLE_PK = new Uint8Array(65);
SAMPLE_PK[0] = 0x04;
for (let i = 1; i < 65; i++) SAMPLE_PK[i] = i;
const PK1_B64 = Buffer.from(SAMPLE_PK.subarray(1, 33)).toString('base64');
const PK2_B64 = Buffer.from(SAMPLE_PK.subarray(33, 65)).toString('base64');

/** The stranded account as Horizon reported it (without data_attr). */
const INCIDENT: MoveAccount = {
  balances: [usdc('31.0700000'), native('7.8776763')],
  subentry_count: 3,
  num_sponsoring: 0,
  num_sponsored: 0,
};
const INCIDENT_MOVABLE = toStroops('5.2776763');

/** Build 29 case: 2.66 XLM, 1 empty USDC trustline, and 2 recovery breadcrumbs. */
const BUILD_29: MoveAccount = {
  balances: [usdc('0.0000000'), native('2.6600000')],
  subentry_count: 3,
  num_sponsoring: 0,
  num_sponsored: 0,
  data_attr: {
    [CRUMB_PK1]: PK1_B64,
    [CRUMB_PK2]: PK2_B64,
  },
};

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

describe('planMove — assets, empty trustlines, breadcrumbs, and merge', () => {
  it('carries the USDC as well as the XLM, into an account that does not exist yet', () => {
    const plan = planMove({
      from: INCIDENT,
      to: null,
      xlmStroops: INCIDENT_MOVABLE,
      hasDestinationKey: true,
    });

    expect(plan).toMatchObject({
      ok: true,
      createsAccount: true,
      xlmStroops: INCIDENT_MOVABLE,
      assets: [{ code: 'USDC', issuer: USDC_ISSUER, amount: '31.0700000', needsTrustline: true }],
      emptyTrustlines: [],
      freedStroops: 5_000_000n,
    });
  });

  it('does not open a second trustline on an account that already trusts the asset', () => {
    const to: MoveAccount = { balances: [usdc('0.0000000'), native('3.0000000')], subentry_count: 1 };
    const plan = planMove({
      from: INCIDENT,
      to,
      xlmStroops: INCIDENT_MOVABLE,
      hasDestinationKey: false,
    });

    expect(plan).toMatchObject({ ok: true, createsAccount: false });
    expect(plan.ok && plan.assets[0]!.needsTrustline).toBe(false);
  });

  it('plans closing an empty trustline so its 0.5 XLM reserve is freed', () => {
    const from: MoveAccount = { balances: [usdc('0.0000000'), native('7.8776763')], subentry_count: 1 };
    const plan = planMove({
      from,
      to: null,
      xlmStroops: INCIDENT_MOVABLE,
      hasDestinationKey: true,
    });
    expect(plan).toMatchObject({
      ok: true,
      assets: [],
      emptyTrustlines: [{ code: 'USDC', issuer: USDC_ISSUER }],
      mergesAccount: true,
    });
  });

  it('allows the build 29 account (2.66 XLM, empty USDC, 2 breadcrumbs) to move with no top-up', () => {
    const plan = planMove({
      from: BUILD_29,
      to: null,
      xlmStroops: 0n,
      hasDestinationKey: true,
    });

    expect(plan).toEqual({
      ok: true,
      createsAccount: true,
      xlmStroops: 10_000_000n,
      assets: [],
      emptyTrustlines: [{ code: 'USDC', issuer: USDC_ISSUER }],
      breadcrumbsToWrite: [
        { name: CRUMB_PK1, valueBase64: PK1_B64 },
        { name: CRUMB_PK2, valueBase64: PK2_B64 },
      ],
      breadcrumbsToDelete: [CRUMB_PK1, CRUMB_PK2],
      writeBreadcrumbsBeforeDelete: false,
      mergesAccount: true,
      freedStroops: 0n,
    });
  });

  it('writes breadcrumbs before deleting them when the old account has enough free XLM', () => {
    const rich: MoveAccount = {
      ...BUILD_29,
      balances: [usdc('0.0000000'), native('6.0000000')],
    };
    const plan = planMove({ from: rich, to: null, xlmStroops: 0n, hasDestinationKey: true });

    expect(plan).toMatchObject({
      ok: true,
      writeBreadcrumbsBeforeDelete: true,
      mergesAccount: true,
    });
  });
});

describe('planMove — it moves everything or nothing', () => {
  const base = { to: null, xlmStroops: INCIDENT_MOVABLE, hasDestinationKey: true } as const;

  it('refuses when the total XLM cannot cover the new account reserve (even after merge)', () => {
    // 1.80 XLM total cannot cover 1.0 base + 2 * 0.5 breadcrumbs = 2.0 XLM on the new account.
    const thin: MoveAccount = {
      ...BUILD_29,
      balances: [usdc('0.0000000'), native('1.8000000')],
    };
    expect(planMove({ from: thin, to: null, xlmStroops: 0n, hasDestinationKey: true })).toEqual({
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

  it('refuses a trustline or breadcrumb write it cannot sign for', () => {
    expect(planMove({ ...base, from: INCIDENT, hasDestinationKey: false })).toEqual({
      ok: false,
      reason: 'no-destination-key',
    });
    expect(planMove({ from: BUILD_29, to: null, xlmStroops: 0n, hasDestinationKey: false })).toEqual({
      ok: false,
      reason: 'no-destination-key',
    });
  });

  it('refuses an asset tied up in an open sell offer', () => {
    const from = {
      ...INCIDENT,
      balances: [usdc('31.0700000', { selling_liabilities: '5.0000000' }), native('7.8776763')],
    };
    expect(planMove({ ...base, from })).toEqual({ ok: false, reason: 'open-offers' });
  });

  it('refuses an asset the issuer has frozen', () => {
    const from = {
      ...INCIDENT,
      balances: [usdc('31.0700000', { is_authorized: false }), native('7.8776763')],
    };
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

  it('builds one transaction that closes empty trustlines, carries breadcrumbs, and merges the build 29 account', async () => {
    mockLoadAccount.mockImplementation(async (address: string) => {
      if (address === FROM.publicKey()) return horizonAccount(address, BUILD_29);
      throw notFound();
    });

    const hash = await submitMove({
      fromSecret: FROM.secret(),
      to: TO.publicKey(),
      toSecret: TO.secret(),
      xlmAmount: '0',
      net,
      fee: '100',
    });

    expect(hash).toBe('abc123');
    const tx = mockSubmit.mock.calls[0][0] as Transaction;
    expect(tx.source).toBe(FROM.publicKey());
    expect(tx.operations.map((op) => op.type)).toEqual([
      'changeTrust', // close empty USDC on from
      'manageData', // delete pk1 on from
      'manageData', // delete pk2 on from
      'createAccount', // create to with 1.0 XLM
      'accountMerge', // merge from -> to (sends remaining ~1.66 XLM)
      'manageData', // write pk1 on to
      'manageData', // write pk2 on to
    ]);

    const [closeEmpty, delPk1, delPk2, create, merge, writePk1, writePk2] =
      tx.operations as unknown as Array<Record<string, unknown> & { source?: string }>;
    expect(closeEmpty).toMatchObject({ limit: '0.0000000' });
    expect(delPk1).toMatchObject({ name: CRUMB_PK1, value: null });
    expect(delPk2).toMatchObject({ name: CRUMB_PK2, value: null });
    expect(create).toMatchObject({ destination: TO.publicKey(), startingBalance: '1.0000000' });
    expect(merge).toMatchObject({ destination: TO.publicKey() });
    expect(writePk1).toMatchObject({ name: CRUMB_PK1, source: TO.publicKey() });
    expect(writePk2).toMatchObject({ name: CRUMB_PK2, source: TO.publicKey() });

    // Both keys sign.
    expect(tx.signatures).toHaveLength(2);

    // Verify a second device reading breadcrumbs from `to` reconstructs the exact public key & wallet.
    const writtenData: Record<string, string> = {
      [CRUMB_PK1]: Buffer.from(writePk1!.value as Buffer).toString('base64'),
      [CRUMB_PK2]: Buffer.from(writePk2!.value as Buffer).toString('base64'),
    };
    mockLoadAccount.mockImplementationOnce(async () => ({ data_attr: writtenData }));
    const crumbs = await readBreadcrumbs(TO.publicKey());
    expect(crumbs?.publicKeyBytes).toEqual(SAMPLE_PK);
    expect(crumbs?.walletAddress).toMatch(/^C[A-Z2-7]{55}$/);
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
    expect(openLine!.source).toBe(TO.publicKey());
    expect(payUsdc).toMatchObject({ destination: TO.publicKey(), amount: '31.0700000' });
    expect((payUsdc!.asset as { code: string; issuer: string }).code).toBe('USDC');
    expect(closeLine!.source).toBeUndefined();
    expect(closeLine).toMatchObject({ limit: '0.0000000' });
    expect(payFreed).toMatchObject({ destination: TO.publicKey(), amount: '0.5000000' });
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
      submitMove({
        fromSecret: FROM.secret(),
        to: TO.publicKey(),
        toSecret: TO.secret(),
        xlmAmount: '5.2776763',
        net,
        fee: '100',
      }),
    ).rejects.toEqual(new MoveRefusedError('frozen-asset'));
    expect(mockSubmit).not.toHaveBeenCalled();
  });

  it('does not read a failed lookup as "this account does not exist"', async () => {
    mockLoadAccount.mockImplementation(async (address: string) => {
      if (address === FROM.publicKey()) return horizonAccount(address, INCIDENT);
      throw new Error('network timeout');
    });

    await expect(
      submitMove({
        fromSecret: FROM.secret(),
        to: TO.publicKey(),
        toSecret: TO.secret(),
        xlmAmount: '5.2776763',
        net,
        fee: '100',
      }),
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
