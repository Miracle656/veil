import { beforeEach, describe, expect, it, jest } from '@jest/globals';
import { retryRecoveryBinding } from '../passkeyWallet';
import { checkPasskeyRecovery, checkPasskeyRecoveryDetails } from '../recoveryStatusActions';

jest.mock('../passkeyWallet', () => ({ retryRecoveryBinding: jest.fn() }));

const mockRetryRecoveryBinding = retryRecoveryBinding as jest.MockedFunction<
  typeof retryRecoveryBinding
>;

describe('checkPasskeyRecovery', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it.each(['unsupported', 'cancelled', 'failed'] as const)(
    'preserves the %s PRF outcome instead of flattening it to missing',
    async (issue) => {
      mockRetryRecoveryBinding.mockResolvedValue({ bound: false, issue });

      await expect(checkPasskeyRecovery()).resolves.toBe(issue);
    }
  );

  it('preserves the funded safety refusal', async () => {
    mockRetryRecoveryBinding.mockResolvedValue({ bound: false, issue: 'funded' });

    await expect(checkPasskeyRecovery()).resolves.toBe('funded');
  });

  it('reports ready when recovery binding succeeds', async () => {
    mockRetryRecoveryBinding.mockResolvedValue({ bound: true });

    await expect(checkPasskeyRecovery()).resolves.toBe('ready');
  });

  it('preserves move refusal issue such as destination-reserve', async () => {
    mockRetryRecoveryBinding.mockResolvedValue({
      bound: false,
      issue: 'destination-reserve',
      shortfallXlm: 2,
    });

    await expect(checkPasskeyRecovery()).resolves.toBe('destination-reserve');
  });
});

describe('checkPasskeyRecoveryDetails', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('returns ready when recovery binding succeeds', async () => {
    mockRetryRecoveryBinding.mockResolvedValue({ bound: true });

    await expect(checkPasskeyRecoveryDetails()).resolves.toEqual({ state: 'ready' });
  });

  it('returns issue and shortfall when destination-reserve is returned', async () => {
    mockRetryRecoveryBinding.mockResolvedValue({
      bound: false,
      issue: 'destination-reserve',
      shortfallXlm: 3,
    });

    await expect(checkPasskeyRecoveryDetails()).resolves.toEqual({
      state: 'destination-reserve',
      shortfallXlm: 3,
    });
  });
});
