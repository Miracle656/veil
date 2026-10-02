import { AMOUNT_MASK, maskAmount } from '../hiddenAmounts';

describe('maskAmount', () => {
  it('returns the real value when not hidden', () => {
    expect(maskAmount(false, '₦1,600,000')).toBe('₦1,600,000');
  });

  it('returns the mask when hidden', () => {
    expect(maskAmount(true, '₦1,600,000')).toBe(AMOUNT_MASK);
  });

  it('honours a custom mask', () => {
    expect(maskAmount(true, '$12.34', '***')).toBe('***');
  });
});
