import {
  FALLBACK_ROUTE,
  MAX_DEEP_LINK_LENGTH,
  resolveDeepLink,
  resolvePaymentAsset,
} from '../deepLinks';

const DESTINATION = 'GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF';
const ISSUER = 'GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5';
const UNKNOWN_ISSUER = 'GCZST3QOXDYMRM4BCYV3E4STXQZCVX6Z3DCLJ6222FXXZ55E4Y4WUKY3';

describe('wallet resolveDeepLink — custom scheme', () => {
  it('routes a bare screen link', () => {
    expect(resolveDeepLink('veil://receive')).toBe('/receive');
  });

  it('forwards known query parameters including asset_issuer and memo', () => {
    expect(
      resolveDeepLink(
        `veil://pay?to=${DESTINATION}&amount=10&asset=USDC&asset_issuer=${ISSUER}&memo=ref-1`,
      ),
    ).toBe(`/pay?to=${DESTINATION}&amount=10&asset=USDC&asset_issuer=${ISSUER}&memo=ref-1`);
  });

  it('forwards asset_issuer and memo on /send route', () => {
    expect(
      resolveDeepLink(
        `veil://send?to=${DESTINATION}&amount=5&asset=EURC&asset_issuer=${ISSUER}&memo=rent`,
      ),
    ).toBe(`/send?to=${DESTINATION}&amount=5&asset=EURC&asset_issuer=${ISSUER}&memo=rent`);
  });

  it('sends an unknown screen to the fallback route', () => {
    expect(resolveDeepLink('veil://settings/admin')).toBe(FALLBACK_ROUTE);
  });
});

describe('wallet resolveDeepLink — universal / app links', () => {
  it('routes an associated-domain link carrying asset_issuer', () => {
    expect(
      resolveDeepLink(
        `https://app.useveilapp.xyz/pay?to=${DESTINATION}&asset=USDC&asset_issuer=${ISSUER}`,
      ),
    ).toBe(`/pay?to=${DESTINATION}&asset=USDC&asset_issuer=${ISSUER}`);
  });

  it('rejects a foreign host', () => {
    expect(resolveDeepLink('https://evil.example/pay?to=ATTACKER')).toBe(FALLBACK_ROUTE);
  });
});

describe('wallet resolveDeepLink — SEP-7 payment requests', () => {
  it('maps SEP-7 fields including asset_issuer and memo onto pay route', () => {
    const uri = `web+stellar:pay?destination=${DESTINATION}&amount=12.5&asset_code=USDC&asset_issuer=${ISSUER}&memo=invoice-42`;
    const target = resolveDeepLink(uri);

    expect(target.startsWith('/pay?')).toBe(true);

    const query = new URLSearchParams(target.slice(target.indexOf('?') + 1));
    expect(query.get('to')).toBe(DESTINATION);
    expect(query.get('amount')).toBe('12.5');
    expect(query.get('asset')).toBe('USDC');
    expect(query.get('asset_issuer')).toBe(ISSUER);
    expect(query.get('memo')).toBe('invoice-42');
    expect(query.get('uri')).toBe(uri);
  });

  it('rejects a non-pay SEP-7 operation', () => {
    expect(resolveDeepLink('web+stellar:tx?xdr=AAAA')).toBe(FALLBACK_ROUTE);
  });
});

describe('wallet resolveDeepLink — hostile and malformed input', () => {
  it('drops parameters the target route does not accept', () => {
    expect(resolveDeepLink('veil://receive?amount=5&callback=https://evil.example')).toBe(
      '/receive?amount=5',
    );
  });

  it('rejects an over-long URL without parsing it', () => {
    const oversized = `veil://pay?to=${'G'.repeat(MAX_DEEP_LINK_LENGTH)}`;
    expect(resolveDeepLink(oversized)).toBe(FALLBACK_ROUTE);
  });
});

describe('wallet resolvePaymentAsset — code and issuer resolution', () => {
  const holdings = [
    { code: 'XLM', issuer: null, balance: '100', native: true },
    { code: 'USDC', issuer: ISSUER, balance: '500', name: 'USD Coin' },
  ];

  it('resolves a non-native asset when code and issuer match', () => {
    const result = resolvePaymentAsset(
      { asset: 'USDC', asset_issuer: ISSUER },
      holdings,
    );
    expect(result).toEqual({
      status: 'resolved',
      asset: holdings[1],
    });
  });

  it('is case-insensitive for asset code', () => {
    const result = resolvePaymentAsset(
      { asset: 'usdc', asset_issuer: ISSUER },
      holdings,
    );
    expect(result.status).toBe('resolved');
  });

  it('rejects an asset with unknown issuer (says so rather than picking one)', () => {
    const result = resolvePaymentAsset(
      { asset: 'USDC', asset_issuer: UNKNOWN_ISSUER },
      holdings,
    );
    expect(result.status).toBe('unresolved');
    if (result.status === 'unresolved') {
      expect(result.code).toBe('USDC');
      expect(result.issuer).toBe(UNKNOWN_ISSUER);
      expect(result.error).toContain('Unknown issuer');
      expect(result.error).toContain(UNKNOWN_ISSUER);
      expect(result.error).toContain('You do not hold this asset');
    }
  });

  it('rejects a non-native asset with missing issuer (says so rather than picking one)', () => {
    const result = resolvePaymentAsset(
      { asset: 'USDC' },
      holdings,
    );
    expect(result.status).toBe('unresolved');
    if (result.status === 'unresolved') {
      expect(result.code).toBe('USDC');
      expect(result.issuer).toBeUndefined();
      expect(result.error).toContain('cannot be resolved to a specific issuer');
      expect(result.error).toContain('Anyone can issue an asset called USDC');
    }
  });

  it('resolves native XLM without requiring issuer', () => {
    const result = resolvePaymentAsset(
      { asset: 'XLM' },
      holdings,
    );
    expect(result.status).toBe('resolved');
    if (result.status === 'resolved') {
      expect(result.asset.code).toBe('XLM');
    }
  });

  it('rejects XLM with an unknown non-native issuer', () => {
    const result = resolvePaymentAsset(
      { asset: 'XLM', asset_issuer: UNKNOWN_ISSUER },
      holdings,
    );
    expect(result.status).toBe('unresolved');
    if (result.status === 'unresolved') {
      expect(result.error).toContain('Unknown issuer');
    }
  });

  it('returns none when no asset is specified', () => {
    const result = resolvePaymentAsset({}, holdings);
    expect(result).toEqual({ status: 'none' });
  });
});
