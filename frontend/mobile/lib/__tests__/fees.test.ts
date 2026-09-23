let mockNetworkName = 'mainnet';

jest.mock('../network', () => ({
  getNetwork: () => ({ name: mockNetworkName }),
}));

import { feeBidXlm, inclusionFee, MAINNET_FEE_BID } from '../fees';

describe('inclusionFee', () => {
  it('bids 0.01 XLM on mainnet: above the market, but affordable', () => {
    mockNetworkName = 'mainnet';
    expect(inclusionFee()).toBe(MAINNET_FEE_BID);
    expect(feeBidXlm()).toBe(0.01);
  });

  it('never bids 0.1 XLM again, which demanded 0.1 XLM spare in every account', () => {
    mockNetworkName = 'mainnet';
    expect(Number(inclusionFee())).toBeLessThan(1_000_000);
  });

  it('keeps the minimum on testnet', () => {
    mockNetworkName = 'testnet';
    expect(inclusionFee()).toBe('100');
  });
});
