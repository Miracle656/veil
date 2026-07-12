/**
 * Tests for useBalance hook
 */

import { renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { ReactNode } from 'react';
import { useBalance, type BalanceData } from '../hooks/useBalance';
import { useVeilContext } from '../context';

// The hook reads the active wallet's address + getBalance() from context, so
// stub useVeilContext with a wallet whose getBalance is the mock.
jest.mock('../context', () => ({
  useVeilContext: jest.fn(),
}));

const mockUseVeilContext = useVeilContext as jest.MockedFunction<typeof useVeilContext>;

function setWallet(address: string | null | undefined, getBalance: jest.Mock) {
  mockUseVeilContext.mockReturnValue({
    wallet: { address, getBalance },
  } as unknown as ReturnType<typeof useVeilContext>);
}

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
    setWallet('G123ABC', jest.fn());
    const { result } = renderHook(() => useBalance(), { wrapper: createWrapper() });

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

    const mockGetBalance = jest.fn().mockResolvedValue(mockBalanceData);
    setWallet('G123ABC', mockGetBalance);

    const { result } = renderHook(() => useBalance(), { wrapper: createWrapper() });

    await waitFor(() => {
      expect(result.current.isLoading).toBe(false);
    });

    expect(result.current.data).toEqual(mockBalanceData);
    expect(result.current.error).toBeNull();
    expect(mockGetBalance).toHaveBeenCalled();
  });

  it('should return error state when fetch fails', async () => {
    const mockError = new Error('Failed to fetch balance');
    const mockGetBalance = jest.fn().mockRejectedValue(mockError);
    setWallet('G123ABC', mockGetBalance);

    const { result } = renderHook(() => useBalance(), { wrapper: createWrapper() });

    await waitFor(() => {
      expect(result.current.isLoading).toBe(false);
    });

    expect(result.current.data).toBeUndefined();
    expect(result.current.error).toEqual(mockError);
    expect(mockGetBalance).toHaveBeenCalled();
  });

  it('should not fetch when address is null', () => {
    const mockGetBalance = jest.fn();
    setWallet(null, mockGetBalance);

    const { result } = renderHook(() => useBalance(), { wrapper: createWrapper() });

    expect(result.current.isLoading).toBe(false);
    expect(result.current.data).toBeUndefined();
    expect(mockGetBalance).not.toHaveBeenCalled();
  });

  it('should not fetch when address is undefined', () => {
    const mockGetBalance = jest.fn();
    setWallet(undefined, mockGetBalance);

    const { result } = renderHook(() => useBalance(), { wrapper: createWrapper() });

    expect(result.current.isLoading).toBe(false);
    expect(result.current.data).toBeUndefined();
    expect(mockGetBalance).not.toHaveBeenCalled();
  });

  it('should refetch when address changes', async () => {
    let currentAddress = 'G123ABC';
    const mockGetBalance = jest.fn().mockImplementation(async () => ({
      address: currentAddress,
      amount: BigInt(1000),
      assetCode: 'USDC',
    }));
    setWallet(currentAddress, mockGetBalance);

    const { result, rerender } = renderHook(() => useBalance(), { wrapper: createWrapper() });

    await waitFor(() => {
      expect(result.current.isLoading).toBe(false);
    });

    expect(result.current.data?.address).toBe('G123ABC');
    expect(mockGetBalance).toHaveBeenCalledTimes(1);

    // Change address — queryKey ['balance', address] changes and refetches
    currentAddress = 'G456DEF';
    setWallet(currentAddress, mockGetBalance);
    rerender();

    await waitFor(() => {
      expect(result.current.data?.address).toBe('G456DEF');
    });

    expect(mockGetBalance).toHaveBeenCalledTimes(2);
  });
});
