/**
 * #1062 — the mobile liquidity gate, and its parity with the wallet's.
 *
 * The buy path is shared by web and mobile, so the gate must answer identically
 * on both. `frontend/mobile/lib/liquidity.ts` is a hand-maintained copy of
 * `frontend/wallet/lib/liquidity.ts`; if this fails, edit both together.
 */

import * as mobile from '../liquidity';
import * as wallet from '../../../wallet/lib/liquidity';
import { ASSET_REGISTRY } from '../assets';

const USDC_ISSUER = 'GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN';

const HEALTHY = {
  bids: [{ amount: '100' }, { amount: '5' }],
  asks: [{ amount: '100' }, { amount: '5' }],
};
const ONE_SIDED = { bids: [{ amount: '100' }], asks: [] as Array<{ amount: string }> };
const EMPTY = { bids: [] as Array<{ amount: string }>, asks: [] as Array<{ amount: string }> };
const THIN = { bids: [{ amount: '1' }], asks: [{ amount: '100' }] };
const CASES: Array<[string, unknown]> = [
  ['healthy', HEALTHY],
  ['one-sided', ONE_SIDED],
  ['empty', EMPTY],
  ['thin', THIN],
  ['unreadable', null],
];

describe('mobile and wallet liquidity gates agree (#1062)', () => {
  it('share the threshold and refusal wording', () => {
    expect(mobile.MIN_BOND_BOOK_DEPTH).toBe(wallet.MIN_BOND_BOOK_DEPTH);
    expect(mobile.ILLIQUID_REASON).toBe(wallet.ILLIQUID_REASON);
    expect(mobile.LIQUIDITY_UNAVAILABLE_REASON).toBe(wallet.LIQUIDITY_UNAVAILABLE_REASON);
  });

  it.each(CASES)('agree on a %s book', (_name, book) => {
    expect(mobile.assessBondLiquidity(book as never)).toEqual(wallet.assessBondLiquidity(book as never));
  });
});

describe('mobile liquidity gate behaviour', () => {
  it('passes a healthy book and refuses one-sided, empty, thin and unreadable books', () => {
    expect(mobile.assessBondLiquidity(HEALTHY).ok).toBe(true);
    expect(mobile.assessBondLiquidity(ONE_SIDED)).toMatchObject({ ok: false, reason: mobile.ILLIQUID_REASON });
    expect(mobile.assessBondLiquidity(EMPTY)).toMatchObject({ ok: false, reason: mobile.ILLIQUID_REASON });
    expect(mobile.assessBondLiquidity(THIN).ok).toBe(false);
    expect(mobile.assessBondLiquidity(null)).toMatchObject({ ok: false, reason: mobile.LIQUIDITY_UNAVAILABLE_REASON });
  });

  it('queries the long bond code as credit_alphanum12', async () => {
    const fetchImpl = jest.fn(async () => ({ ok: true, json: async () => HEALTHY })) as unknown as typeof fetch;
    const verdict = await mobile.fetchBondLiquidity(ASSET_REGISTRY.CETES, {
      horizonUrl: 'https://horizon.example',
      quoteIssuer: USDC_ISSUER,
      fetchImpl,
    });
    expect(verdict.ok).toBe(true);
    const url = String((fetchImpl as unknown as jest.Mock).mock.calls[0][0]);
    expect(url).toContain('selling_asset_type=credit_alphanum12');
  });

  it('refuses the buy when the book cannot be read', async () => {
    const fetchImpl = jest.fn(async () => {
      throw new Error('offline');
    }) as unknown as typeof fetch;
    const verdict = await mobile.fetchBondLiquidity(ASSET_REGISTRY.KTB, {
      horizonUrl: 'https://horizon.example',
      quoteIssuer: USDC_ISSUER,
      fetchImpl,
    });
    expect(verdict).toMatchObject({ ok: false, reason: mobile.LIQUIDITY_UNAVAILABLE_REASON });
  });
});
