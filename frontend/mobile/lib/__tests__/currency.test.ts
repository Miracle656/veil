import {
  CURRENCIES,
  convertUsd,
  formatFiat,
  getRate,
  isCurrencyCode,
} from '../currency';

describe('convertUsd', () => {
  it('multiplies a USD amount by the rate', () => {
    expect(convertUsd(10, 1600)).toBe(16000);
    expect(convertUsd(2.5, 1)).toBe(2.5);
  });

  it('returns null when either input is null', () => {
    expect(convertUsd(null, 1600)).toBeNull();
    expect(convertUsd(10, null)).toBeNull();
  });

  it('returns null for non-finite inputs rather than NaN/Infinity', () => {
    expect(convertUsd(Infinity, 1600)).toBeNull();
    expect(convertUsd(10, NaN)).toBeNull();
  });
});

describe('formatFiat', () => {
  it('formats USD with two decimals and a dollar sign', () => {
    expect(formatFiat(1234.5, 'USD', 1)).toBe('$1,234.50');
  });

  it('drops the cents for high-denomination currencies (e.g. naira)', () => {
    expect(formatFiat(1000, 'NGN', 1600)).toBe('₦1,600,000');
    expect(formatFiat(0.5, 'NGN', 1600)).toBe('₦800');
  });

  it('keeps the cents for currencies configured with decimals', () => {
    expect(formatFiat(1, 'GHS', 15)).toBe('₵15.00');
    expect(formatFiat(1234.5, 'GBP', 1)).toBe('£1,234.50');
  });

  it('falls back to the bundled rate when no live rate is given', () => {
    const expected = `₦${(1 * CURRENCIES.NGN.fallbackRate).toLocaleString('en-US', {
      minimumFractionDigits: 0,
      maximumFractionDigits: 0,
    })}`;
    expect(formatFiat(1, 'NGN', null)).toBe(expected);
  });

  it('returns an em dash for an unpriced value, never $0.00', () => {
    expect(formatFiat(null, 'USD', 1)).toBe('—');
    expect(formatFiat(Infinity, 'USD', 1)).toBe('—');
  });
});

describe('isCurrencyCode', () => {
  it('accepts known codes and rejects everything else', () => {
    expect(isCurrencyCode('NGN')).toBe(true);
    expect(isCurrencyCode('USD')).toBe(true);
    expect(isCurrencyCode('XYZ')).toBe(false);
    expect(isCurrencyCode(null)).toBe(false);
    expect(isCurrencyCode(42)).toBe(false);
  });
});

describe('getRate', () => {
  it('returns the bundled fallback when no live rate is cached', () => {
    // No FX fetch has succeeded in the test environment, so every code resolves
    // to its fallback.
    expect(getRate('USD')).toBe(CURRENCIES.USD.fallbackRate);
    expect(getRate('NGN')).toBe(CURRENCIES.NGN.fallbackRate);
  });
});
