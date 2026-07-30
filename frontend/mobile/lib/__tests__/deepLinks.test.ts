import { FALLBACK_ROUTE, MAX_DEEP_LINK_LENGTH, resolveDeepLink } from '../deepLinks';

const DESTINATION = 'GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF';

describe('resolveDeepLink — veil:// custom scheme', () => {
  it('routes a bare screen link', () => {
    expect(resolveDeepLink('veil://receive')).toBe('/receive');
  });

  it('forwards known query parameters', () => {
    expect(resolveDeepLink(`veil://pay?to=${DESTINATION}&amount=10`)).toBe(
      `/pay?to=${DESTINATION}&amount=10`,
    );
  });

  it('accepts the host-less form', () => {
    expect(resolveDeepLink('veil:send')).toBe('/send');
  });

  it('tolerates a trailing slash and mixed case', () => {
    expect(resolveDeepLink('veil://Receive/')).toBe('/receive');
  });

  it('drops the fragment', () => {
    expect(resolveDeepLink('veil://send?amount=5#top')).toBe('/send?amount=5');
  });

  it('sends an unknown screen to the fallback route', () => {
    expect(resolveDeepLink('veil://settings/admin')).toBe(FALLBACK_ROUTE);
  });

  it('sends the scheme root to the fallback route', () => {
    expect(resolveDeepLink('veil://')).toBe(FALLBACK_ROUTE);
  });
});

describe('resolveDeepLink — universal / app links', () => {
  it('routes an associated-domain link', () => {
    expect(resolveDeepLink(`https://app.veil.xyz/pay?to=${DESTINATION}`)).toBe(
      `/pay?to=${DESTINATION}`,
    );
  });

  it('ignores the port', () => {
    expect(resolveDeepLink('https://app.veil.xyz:443/receive')).toBe('/receive');
  });

  it('matches the host case-insensitively', () => {
    expect(resolveDeepLink('https://APP.VEIL.XYZ/send')).toBe('/send');
  });

  it('rejects a foreign host', () => {
    expect(resolveDeepLink('https://evil.example/pay?to=ATTACKER')).toBe(FALLBACK_ROUTE);
  });

  it('rejects a look-alike subdomain', () => {
    expect(resolveDeepLink('https://app.veil.xyz.evil.example/pay')).toBe(FALLBACK_ROUTE);
  });

  it('rejects userinfo smuggling', () => {
    expect(resolveDeepLink('https://app.veil.xyz@evil.example/pay')).toBe(FALLBACK_ROUTE);
  });
});

describe('resolveDeepLink — SEP-7 payment requests', () => {
  it('maps SEP-7 fields onto the pay route and keeps the raw URI', () => {
    const uri = `web+stellar:pay?destination=${DESTINATION}&amount=12.5&asset_code=USDC`;
    const target = resolveDeepLink(uri);

    expect(target.startsWith('/pay?')).toBe(true);

    const query = new URLSearchParams(target.slice(target.indexOf('?') + 1));
    expect(query.get('to')).toBe(DESTINATION);
    expect(query.get('amount')).toBe('12.5');
    expect(query.get('asset')).toBe('USDC');
    expect(query.get('uri')).toBe(uri);
  });

  it('forwards the raw URI even when no fields map', () => {
    expect(resolveDeepLink('web+stellar:pay')).toBe(
      `/pay?uri=${encodeURIComponent('web+stellar:pay')}`,
    );
  });

  it('rejects a non-pay SEP-7 operation', () => {
    expect(resolveDeepLink('web+stellar:tx?xdr=AAAA')).toBe(FALLBACK_ROUTE);
  });
});

describe('resolveDeepLink — paths handed over by expo-router', () => {
  it('accepts an already-stripped path', () => {
    expect(resolveDeepLink('/send?amount=3')).toBe('/send?amount=3');
  });

  it('resolves an alias', () => {
    expect(resolveDeepLink('/request?amount=3')).toBe('/receive?amount=3');
  });
});

describe('resolveDeepLink — hostile and malformed input', () => {
  it.each([
    ['empty string', ''],
    ['whitespace', '   '],
    ['no scheme', 'pay?to=GABC'],
    ['unknown scheme', 'javascript:alert(1)'],
    ['file scheme', 'file:///etc/passwd'],
  ])('sends %s to the fallback route', (_label, input) => {
    expect(resolveDeepLink(input)).toBe(FALLBACK_ROUTE);
  });

  it('rejects an over-long URL without parsing it', () => {
    const oversized = `veil://pay?to=${'G'.repeat(MAX_DEEP_LINK_LENGTH)}`;
    expect(resolveDeepLink(oversized)).toBe(FALLBACK_ROUTE);
  });

  it('drops parameters the target route does not accept', () => {
    expect(resolveDeepLink('veil://receive?amount=5&callback=https://evil.example')).toBe(
      '/receive?amount=5',
    );
  });

  it('keeps the first value of a repeated parameter', () => {
    expect(resolveDeepLink('veil://send?amount=1&amount=999')).toBe('/send?amount=1');
  });

  it('survives a malformed percent-escape', () => {
    expect(resolveDeepLink('veil://%E0%A4%A')).toBe(FALLBACK_ROUTE);
  });

  it('ignores a non-string input', () => {
    expect(resolveDeepLink(undefined as unknown as string)).toBe(FALLBACK_ROUTE);
  });
});

describe('resolveDeepLink — cold start vs warm resume', () => {
  const links = [
    'veil://pay?to=' + DESTINATION,
    'https://app.veil.xyz/receive',
    'web+stellar:pay?destination=' + DESTINATION,
    'veil://create-wallet',
  ];

  it.each(links)('resolves %s identically on both launch paths', (link) => {
    expect(resolveDeepLink(link, { initial: true })).toBe(
      resolveDeepLink(link, { initial: false }),
    );
  });
});
