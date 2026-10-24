import {
  NIGERIAN_BANKS,
  POPULAR_BANKS,
  bankInitials,
  bankLogoUrl,
  bankName,
  bankSlug,
  highlight,
} from '../nigerianBanks';

/**
 * The payout picker.
 *
 * Everything here is display, with one exception that is not: the logo slug
 * must never be confused with the payout code. nigerianbanks.xyz numbers banks
 * on its own scheme, and for several of ours the two disagree, so a lookup that
 * went through a slug would quietly pay the wrong institution.
 */

describe('bank identity', () => {
  it('keeps the payout code and the logo slug apart', () => {
    const opay = NIGERIAN_BANKS.find((b) => b.name === 'OPay')!;
    // Linq's code. nigerianbanks.xyz calls the same bank 999992.
    expect(opay.code).toBe('100004');
    expect(opay.slug).toBe('paycom');
    expect(opay.slug).not.toBe(opay.code);
  });

  it('points FCMB at the commercial bank, not the microfinance arm', () => {
    // Searching that API for "FCMB" returns `fcmb-mfb`, a different institution
    // with a different code. The slug was resolved by hand for this reason.
    expect(bankSlug('214')).toBe('first-city-monument-bank');
    expect(bankSlug('214')).not.toBe('fcmb-mfb');
  });

  it('gives every bank a logo URL built from its own slug', () => {
    for (const b of NIGERIAN_BANKS) {
      expect(b.slug).toBeTruthy();
      expect(bankLogoUrl(b.slug)).toBe(`https://nigerianbanks.xyz/logo/${b.slug}.png`);
    }
  });

  it('has no logo URL when there is no slug', () => {
    expect(bankLogoUrl(undefined)).toBeNull();
  });

  it('resolves a name from a payout code', () => {
    expect(bankName('058')).toBe('GTBank');
    // An unknown code shows itself rather than an empty row.
    expect(bankName('999999')).toBe('999999');
  });
});

describe('bankInitials', () => {
  it('takes the first letters of the first two words', () => {
    expect(bankInitials({ name: 'First Bank of Nigeria' })).toBe('FB');
    expect(bankInitials({ name: 'First City Monument Bank' })).toBe('FC');
  });

  it('takes one letter from a single-word name', () => {
    expect(bankInitials({ name: 'Kuda' })).toBe('K');
    expect(bankInitials({ name: 'PalmPay' })).toBe('P');
  });

  it('prefers the short name, so a chip matches its label', () => {
    // Without this, "Access Bank" badges as AB beside a chip reading "Access".
    expect(bankInitials({ name: 'Access Bank', short: 'Access' })).toBe('A');
  });

  it('honours an explicit badge', () => {
    expect(bankInitials({ name: 'GTBank', short: 'GTBank', badge: 'GT' })).toBe('GT');
  });

  it('never returns empty', () => {
    expect(bankInitials({ name: '   ' })).toBe('?');
  });
});

describe('popular chips', () => {
  it('offers six, the ones most people actually bank with', () => {
    expect(POPULAR_BANKS).toHaveLength(6);
  });

  it('gives every chip a short label that fits', () => {
    for (const b of POPULAR_BANKS) {
      expect(b.short).toBeTruthy();
      // "Kuda Microfinance Bank" in a third of a row's width is an ellipsis.
      expect(b.short!.length).toBeLessThanOrEqual(10);
    }
  });
});

describe('highlight', () => {
  it('splits around the match', () => {
    expect(highlight('First Bank of Nigeria', 'fir')).toEqual([
      { text: 'Fir', hit: true },
      { text: 'st Bank of Nigeria', hit: false },
    ]);
  });

  it("keeps the bank's own casing, not the query's", () => {
    // Slicing the lowercased copy would render "fir" over the real name.
    const parts = highlight('First Bank of Nigeria', 'FIRST');
    expect(parts[0]).toEqual({ text: 'First', hit: true });
  });

  it('matches in the middle of a name', () => {
    expect(highlight('Zenith Bank', 'bank')).toEqual([
      { text: 'Zenith ', hit: false },
      { text: 'Bank', hit: true },
    ]);
  });

  it('returns the whole name when nothing matches', () => {
    expect(highlight('Kuda Microfinance Bank', 'zzz')).toEqual([
      { text: 'Kuda Microfinance Bank', hit: false },
    ]);
  });

  it('returns the whole name for an empty query', () => {
    expect(highlight('Kuda Microfinance Bank', '')).toEqual([
      { text: 'Kuda Microfinance Bank', hit: false },
    ]);
  });
});
