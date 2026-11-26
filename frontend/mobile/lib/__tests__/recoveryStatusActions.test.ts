import { beforeEach, describe, expect, it, jest } from '@jest/globals';
import { retryRecoveryBinding } from '../passkeyWallet';
import { checkPasskeyRecovery } from '../recoveryStatusActions';

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
});
