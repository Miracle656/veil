/**
 * Tests for useAccount hook
 */

import { renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { ReactNode } from 'react';
import { useAccount, type AccountData } from '../hooks/useAccount';

// Setup
const createWrapper = () => {
  const queryClient = new QueryClient({
    defaultOptions: {
      queries: {
        retry: false,
      },
    },
  });

  return ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
  );
};

describe('useAccount', () => {
  it('should return loading state initially', () => {
    const mockFetch = jest.fn<Promise<AccountData>, [string]>();
    const { result } = renderHook(
      () => useAccount('G123ABC', mockFetch),
      { wrapper: createWrapper() },
    );

    expect(result.current.isLoading).toBe(true);
    expect(result.current.data).toBeUndefined();
    expect(result.current.error).toBeNull();
  });

  it('should fetch and return account data on success', async () => {
    const mockAccountData: AccountData = {
      address: 'G123ABC',
      sequenceNumber: '0',
      isDeployed: true,
      signers: [
        {
          index: 0,
          publicKey: 'PublicKeyBytes0',
        },
      ],
      guardian: 'G999XYZ',
    };

    const mockFetch = jest
      .fn<Promise<AccountData>, [string]>()
      .mockResolvedValue(mockAccountData);

    const { result } = renderHook(
      () => useAccount('G123ABC', mockFetch),
      { wrapper: createWrapper() },
    );

    await waitFor(() => {
      expect(result.current.isLoading).toBe(false);
    });

    expect(result.current.data).toEqual(mockAccountData);
    expect(result.current.error).toBeNull();
    expect(mockFetch).toHaveBeenCalledWith('G123ABC');
  });

  it('should return error state when fetch fails', async () => {
    const mockError = new Error('Failed to fetch account');
    const mockFetch = jest
      .fn<Promise<AccountData>, [string]>()
      .mockRejectedValue(mockError);

    const { result } = renderHook(
      () => useAccount('G123ABC', mockFetch),
      { wrapper: createWrapper() },
    );

    await waitFor(() => {
      expect(result.current.isLoading).toBe(false);
    });

    expect(result.current.data).toBeUndefined();
    expect(result.current.error).toEqual(mockError);
    expect(mockFetch).toHaveBeenCalledWith('G123ABC');
  });

  it('should not fetch when address is null', () => {
    const mockFetch = jest.fn<Promise<AccountData>, [string]>();

    const { result } = renderHook(
      () => useAccount(null, mockFetch),
      { wrapper: createWrapper() },
    );

    expect(result.current.isLoading).toBe(false);
    expect(result.current.data).toBeUndefined();
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('should not fetch when address is undefined', () => {
    const mockFetch = jest.fn<Promise<AccountData>, [string]>();

    const { result } = renderHook(
      () => useAccount(undefined, mockFetch),
      { wrapper: createWrapper() },
    );

    expect(result.current.isLoading).toBe(false);
    expect(result.current.data).toBeUndefined();
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('should refetch when address changes', async () => {
    const mockFetch = jest
      .fn<Promise<AccountData>, [string]>()
      .mockImplementation(async (address: string) => ({
        address,
        sequenceNumber: '0',
        isDeployed: true,
      }));

    const { result, rerender } = renderHook(
      ({ address }) => useAccount(address, mockFetch),
      { wrapper: createWrapper(), initialProps: { address: 'G123ABC' } },
    );

    await waitFor(() => {
      expect(result.current.isLoading).toBe(false);
    });

    expect(result.current.data?.address).toBe('G123ABC');
    expect(mockFetch).toHaveBeenCalledWith('G123ABC');

    // Change address
    rerender({ address: 'G456DEF' });

    await waitFor(() => {
      expect(result.current.data?.address).toBe('G456DEF');
    });

    expect(mockFetch).toHaveBeenCalledWith('G456DEF');
    expect(mockFetch).toHaveBeenCalledTimes(2);
  });

  it('should return account not deployed', async () => {
    const mockAccountData: AccountData = {
      address: 'G123ABC',
      sequenceNumber: '0',
      isDeployed: false,
    };

    const mockFetch = jest
      .fn<Promise<AccountData>, [string]>()
      .mockResolvedValue(mockAccountData);

    const { result } = renderHook(
      () => useAccount('G123ABC', mockFetch),
      { wrapper: createWrapper() },
    );

    await waitFor(() => {
      expect(result.current.isLoading).toBe(false);
    });

    expect(result.current.data?.isDeployed).toBe(false);
  });

  it('should include multiple signers if present', async () => {
    const mockAccountData: AccountData = {
      address: 'G123ABC',
      sequenceNumber: '0',
      isDeployed: true,
      signers: [
        {
          index: 0,
          publicKey: 'Key0',
        },
        {
          index: 1,
          publicKey: 'Key1',
        },
        {
          index: 2,
          publicKey: 'Key2',
        },
      ],
    };

    const mockFetch = jest
      .fn<Promise<AccountData>, [string]>()
      .mockResolvedValue(mockAccountData);

    const { result } = renderHook(
      () => useAccount('G123ABC', mockFetch),
      { wrapper: createWrapper() },
    );

    await waitFor(() => {
      expect(result.current.isLoading).toBe(false);
    });

    expect(result.current.data?.signers).toHaveLength(3);
    expect(result.current.data?.signers?.[1].index).toBe(1);
    expect(result.current.data?.signers?.[1].publicKey).toBe('Key1');
  });

  it('should handle optional guardian field', async () => {
    const mockAccountDataWithGuardian: AccountData = {
      address: 'G123ABC',
      sequenceNumber: '0',
      isDeployed: true,
      guardian: 'G999XYZ',
    };

    const mockFetch = jest
      .fn<Promise<AccountData>, [string]>()
      .mockResolvedValue(mockAccountDataWithGuardian);

    const { result } = renderHook(
      () => useAccount('G123ABC', mockFetch),
      { wrapper: createWrapper() },
    );

    await waitFor(() => {
      expect(result.current.isLoading).toBe(false);
    });

    expect(result.current.data?.guardian).toBe('G999XYZ');
  });

  it('should handle missing optional fields', async () => {
    const mockAccountData: AccountData = {
      address: 'G123ABC',
      sequenceNumber: '100',
      isDeployed: true,
    };

    const mockFetch = jest
      .fn<Promise<AccountData>, [string]>()
      .mockResolvedValue(mockAccountData);

    const { result } = renderHook(
      () => useAccount('G123ABC', mockFetch),
      { wrapper: createWrapper() },
    );

    await waitFor(() => {
      expect(result.current.isLoading).toBe(false);
    });

    expect(result.current.data?.signers).toBeUndefined();
    expect(result.current.data?.guardian).toBeUndefined();
  });
});
