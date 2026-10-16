/**
 * #791 — a payment link resolves to an exact code:issuer, or is refused with a
 * reason. Mirrors `frontend/wallet/lib/__tests__/requestedAsset.test.ts`.
 */

import { resolveDeepLink } from '../deepLinks';
import { USDT0_MAINNET_ISSUER } from '../assets';
import { resolveRequestedAsset } from '../requestedAsset';

const DEST = 'GCSWM5I2FRYFIDSVJDGLWDH4TMQZY6IVT4JDF2SCFW6PPJ56TSBH23NO';
const IMPOSTOR = 'GADUBOKGYG4E2BZUVXAZBBILGPIYIPOXAXWIIG6DJ4JDXWOQR67HUSDT';

describe('resolveRequestedAsset', () => {
  it('refusal case 1: refuses USDT0 with no issuer', () => {
    const r = resolveRequestedAsset('USDT0', undefined, 'mainnet');
    expect(r).toEqual({ ok: false, reason: expect.stringContaining('does not say who issued it') });
  });

  it('refusal case 2: refuses an unregistered USDT0 issuer and names it', () => {
    const r = resolveRequestedAsset('USDT0', IMPOSTOR, 'mainnet', [{ code: 'USDT0', issuer: IMPOSTOR }]);
    expect(r).toEqual({ ok: false, reason: expect.stringContaining(`Unregistered issuer ${IMPOSTOR}`) });
  });

  it('refusal case 3: refuses an issuer with no asset code', () => {
    expect(resolveRequestedAsset(undefined, USDT0_MAINNET_ISSUER, 'mainnet').ok).toBe(false);
  });

  it('accepts the genuine USDT0 on mainnet only', () => {
    expect(resolveRequestedAsset('USDT0', USDT0_MAINNET_ISSUER, 'mainnet')).toEqual({
      ok: true,
      asset: { code: 'USDT0', issuer: USDT0_MAINNET_ISSUER },
    });
    expect(resolveRequestedAsset('USDT0', USDT0_MAINNET_ISSUER, 'testnet').ok).toBe(false);
  });

  it('accepts an unregistered code only when that exact asset is held', () => {
    expect(resolveRequestedAsset('FOO', IMPOSTOR, 'mainnet').ok).toBe(false);
    expect(resolveRequestedAsset('FOO', IMPOSTOR, 'mainnet', [{ code: 'FOO', issuer: IMPOSTOR }]).ok).toBe(true);
  });
});

describe('deep link → send screen keeps the issuer', () => {
  it('delivers code and issuer from a SEP-7 link to /pay, which resolves to the real asset', () => {
    const target = resolveDeepLink(
      `web+stellar:pay?destination=${DEST}&amount=5&asset_code=USDT0&asset_issuer=${USDT0_MAINNET_ISSUER}`,
    );
    const q = new URLSearchParams(target.slice(target.indexOf('?') + 1));
    expect(resolveRequestedAsset(q.get('asset') ?? undefined, q.get('issuer') ?? undefined, 'mainnet')).toEqual({
      ok: true,
      asset: { code: 'USDT0', issuer: USDT0_MAINNET_ISSUER },
    });
  });

  it('a SEP-7 link naming only USDT0 arrives with no issuer, and is refused', () => {
    const target = resolveDeepLink(`web+stellar:pay?destination=${DEST}&asset_code=USDT0`);
    const q = new URLSearchParams(target.slice(target.indexOf('?') + 1));
    expect(q.get('issuer')).toBeNull();
    expect(resolveRequestedAsset(q.get('asset') ?? undefined, undefined, 'mainnet').ok).toBe(false);
  });
});
