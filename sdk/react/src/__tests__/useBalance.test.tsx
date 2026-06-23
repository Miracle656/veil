/**
 * Tests for useBalance hook
 */

import { renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { ReactNode } from 'react';
import { useBalance, type BalanceData } from '../hooks/useBalance';

// Setup
const createWrapper = () => {
  const queryClient = new QueryClient({
    defaultOptions: {
      queries: {
        retry: false, // Disable retries for tests
      },
    },
  });

  return ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
  );
};

describe('useBalance', () => {
  it('should return loading state initially', () => {
    const mockFetch = jest.fn<Promise<BalanceData>, [string]>();
    const { result } = renderHook(
      () => useBalance('G123ABC', mockFetch),
      { wrapper: createWrapper() },
    );

    expect(result.current.isLoading).toBe(true);
    expect(result.current.data).toBeUndefined();
    expect(result.current.error).toBeNull();
  });

  it('should fetch and return balance data on success', async () => {
    const mockBalanceData: BalanceData = {
      address: 'G123ABC',
      amount: BigInt(1000),
      assetCode: 'USDC',
    };

    const mockFetch = jest.fn<Promise<BalanceData>, [string]>().mockResolvedValue(mockBalanceData);

    const { result } = renderHook(
      () => useBalance('G123ABC', mockFetch),
      { wrapper: createWrapper() },
    );

    await waitFor(() => {
      expect(result.current.isLoading).toBe(false);
    });

    expect(result.current.data).toEqual(mockBalanceData);
    expect(result.current.error).toBeNull();
    expect(mockFetch).toHaveBeenCalledWith('G123ABC');
  });

  it('should return error state when fetch fails', async () => {
    const mockError = new Error('Failed to fetch balance');
    const mockFetch = jest.fn<Promise<BalanceData>, [string]>().mockRejectedValue(mockError);

    const { result } = renderHook(
      () => useBalance('G123ABC', mockFetch),
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
    const mockFetch = jest.fn<Promise<BalanceData>, [string]>();

    const { result } = renderHook(
      () => useBalance(null, mockFetch),
      { wrapper: createWrapper() },
    );

    expect(result.current.isLoading).toBe(false);
    expect(result.current.data).toBeUndefined();
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('should not fetch when address is undefined', () => {
    const mockFetch = jest.fn<Promise<BalanceData>, [string]>();

    const { result } = renderHook(
      () => useBalance(undefined, mockFetch),
      { wrapper: createWrapper() },
    );

    expect(result.current.isLoading).toBe(false);
    expect(result.current.data).toBeUndefined();
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('should refetch when address changes', async () => {
    const mockFetch = jest
      .fn<Promise<BalanceData>, [string]>()
      .mockImplementation(async (address: string) => ({
        address,
        amount: BigInt(1000),
        assetCode: 'USDC',
      }));

    const { result, rerender } = renderHook(
      ({ address }) => useBalance(address, mockFetch),
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
});
