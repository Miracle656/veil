import {
  DAPP_ALLOWLIST,
  allowedOriginOf,
  filterDapps,
  getDappForUrl,
  isAllowedDappUrl,
  normalizeOrigin,
} from '../dappAllowlist';

describe('DAPP_ALLOWLIST — integrity', () => {
  it('is non-empty and every entry is fully described', () => {
    expect(DAPP_ALLOWLIST.length).toBeGreaterThan(0);
    for (const entry of DAPP_ALLOWLIST) {
      expect(entry.id).toBeTruthy();
      expect(entry.name).toBeTruthy();
      expect(entry.description).toBeTruthy();
      expect(entry.icon.startsWith('https://')).toBe(true);
      expect(entry.category).toBeTruthy();
    }
  });

  it('stores canonical HTTPS origins that normalise to themselves', () => {
    for (const entry of DAPP_ALLOWLIST) {
      expect(entry.origin.startsWith('https://')).toBe(true);
      expect(normalizeOrigin(entry.origin)).toBe(entry.origin);
    }
  });

  it('has no duplicate ids or origins', () => {
    expect(new Set(DAPP_ALLOWLIST.map((e) => e.id)).size).toBe(DAPP_ALLOWLIST.length);
    expect(new Set(DAPP_ALLOWLIST.map((e) => e.origin)).size).toBe(DAPP_ALLOWLIST.length);
  });
});

describe('normalizeOrigin', () => {
  it('reduces a URL with a path, query and fragment to its origin', () => {
    expect(normalizeOrigin('https://app.soroswap.finance/swap?asset=XLM#top')).toBe(
      'https://app.soroswap.finance',
    );
  });

  it('drops the default HTTPS port but keeps a custom one', () => {
    expect(normalizeOrigin('https://stellarterm.com:443/trade')).toBe('https://stellarterm.com');
    expect(normalizeOrigin('https://stellarterm.com:8443/trade')).toBe(
      'https://stellarterm.com:8443',
    );
  });

  it('lower-cases the host', () => {
    expect(normalizeOrigin('https://WWW.StellarX.com')).toBe('https://www.stellarx.com');
  });

  it('refuses plaintext http, even for an allow-listed host', () => {
    expect(normalizeOrigin('http://app.soroswap.finance')).toBeNull();
    expect(allowedOriginOf('http://app.soroswap.finance')).toBeNull();
    expect(isAllowedDappUrl('http://app.soroswap.finance')).toBe(false);
  });

  it('refuses credentials in the authority', () => {
    expect(normalizeOrigin('https://evil.example@app.soroswap.finance')).toBeNull();
  });

  it('refuses malformed and non-http input', () => {
    for (const bad of ['', '   ', 'not a url', 'javascript:alert(1)', 'ftp://x.example', 'https://']) {
      expect(normalizeOrigin(bad)).toBeNull();
    }
  });
});

describe('allowedOriginOf / isAllowedDappUrl', () => {
  it('returns the canonical origin for an allow-listed dApp', () => {
    expect(allowedOriginOf('https://stellarterm.com/trade/XLM')).toBe('https://stellarterm.com');
    expect(isAllowedDappUrl('https://stellarterm.com')).toBe(true);
  });

  it('refuses an origin that is not on the list', () => {
    expect(allowedOriginOf('https://evil.example')).toBeNull();
    expect(isAllowedDappUrl('https://evil.example')).toBe(false);
  });

  it('refuses a look-alike subdomain', () => {
    expect(allowedOriginOf('https://stellarterm.com.evil.example')).toBeNull();
  });
});

describe('getDappForUrl', () => {
  it('finds the entry for an allow-listed origin', () => {
    expect(getDappForUrl('https://aqua.network')?.id).toBe('aqua');
  });

  it('ignores a path on an allow-listed origin', () => {
    expect(getDappForUrl('https://aqua.network/pools?filter=all')?.id).toBe('aqua');
  });

  it('returns undefined for anything not on the list', () => {
    expect(getDappForUrl('https://evil.example')).toBeUndefined();
    expect(getDappForUrl('http://aqua.network')).toBeUndefined();
  });
});

describe('filterDapps — directory search and empty state', () => {
  it('returns the whole list for a blank query', () => {
    // The same module backs the allow-list and the directory: a blank query
    // yields exactly the allow-list, so the two cannot drift.
    expect(filterDapps('')).toEqual([...DAPP_ALLOWLIST]);
    expect(filterDapps('   ')).toEqual([...DAPP_ALLOWLIST]);
  });

  it('matches on name, case-insensitively', () => {
    const results = filterDapps('SOROSWAP');
    expect(results.map((e) => e.id)).toEqual(['soroswap']);
  });

  it('matches on category', () => {
    const trade = filterDapps('trade');
    expect(trade.length).toBeGreaterThan(0);
    expect(trade.every((e) => e.category.toLowerCase().includes('trade'))).toBe(true);
  });

  it('trims the query before matching', () => {
    expect(filterDapps('  learn  ').map((e) => e.id)).toEqual(['stellar-quest']);
  });

  it('shows an empty state on no match', () => {
    const results = filterDapps('no-such-dapp-zzz');
    expect(results).toEqual([]);
    // This is exactly the condition the screen renders as its empty state.
    expect(results.length === 0).toBe(true);
  });
});
