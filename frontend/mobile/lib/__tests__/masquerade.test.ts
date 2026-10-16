import {
  getMasqueradeFigureForOrder,
  MASQUERADE_FIGURES,
  MASQUERADE_TOTAL_SUPPLY,
} from '../masquerade';

describe('masquerade (Mobile Parity / Issue #1078 & #1079)', () => {
  test('total supply is exactly 20 figures', () => {
    expect(MASQUERADE_TOTAL_SUPPLY).toBe(20);
    expect(MASQUERADE_FIGURES.length).toBe(20);
  });

  test('maps claim orders 1..20 to their respective figures in sequence', () => {
    const fig1 = getMasqueradeFigureForOrder(1);
    expect(fig1.hasFigure).toBe(true);
    expect(fig1.figure?.id).toBe(1);
    expect(fig1.figure?.name).toBe('Veil Masquerade #01');

    const fig20 = getMasqueradeFigureForOrder(20);
    expect(fig20.hasFigure).toBe(true);
    expect(fig20.figure?.id).toBe(20);
    expect(fig20.figure?.name).toBe('Veil Masquerade #20');
  });

  test('figure #09 is the closed mask with aperture None and assigned to 9th claimant', () => {
    const fig9 = getMasqueradeFigureForOrder(9);
    expect(fig9.hasFigure).toBe(true);
    expect(fig9.figure?.id).toBe(9);
    expect(fig9.figure?.isClosedMask).toBe(true);
    expect(fig9.figure?.aperture).toBe('None');
    expect(fig9.note).toContain('ninth claimant');
  });

  test('claimant 21+ receives hasFigure: false and explicit warning before paying', () => {
    const fig21 = getMasqueradeFigureForOrder(21);
    expect(fig21.hasFigure).toBe(false);
    expect(fig21.figure).toBeNull();
    expect(fig21.warning).toContain('All 20 Veil Masquerade figures have been allocated');

    const fig100 = getMasqueradeFigureForOrder(100);
    expect(fig100.hasFigure).toBe(false);
    expect(fig100.figure).toBeNull();
    expect(fig100.warning).toContain('All 20 Veil Masquerade figures have been allocated');
  });
});
