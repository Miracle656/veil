import { calculateAccountReserve } from '../accountReserve';

describe('calculateAccountReserve', () => {
  it.each([
    [0, 1],
    [1, 1.5],
    [4, 3],
  ])('derives the locked reserve from %d subentries', (subentries, expected) => {
    expect(calculateAccountReserve(10, subentries).reservedXlm).toBe(expected);
  });

  it('never reports negative spendable balance', () => {
    expect(calculateAccountReserve(1, 4)).toMatchObject({
      reservedXlm: 3,
      spendableXlm: 0,
    });
  });
});
