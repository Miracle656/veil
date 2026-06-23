/**
 * Tests for useTransactionStatus hook
 */

import { renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { ReactNode } from 'react';
import { useTransactionStatus, type TransactionStatusData } from '../hooks/useTransactionStatus';

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

describe('useTransactionStatus', () => {
  it('should return loading state initially', () => {
    const mockFetch = jest.fn<Promise<TransactionStatusData>, [string]>();
    const { result } = renderHook(
      () => useTransactionStatus('tx123', mockFetch),
      { wrapper: createWrapper() },
    );

    expect(result.current.isLoading).toBe(true);
    expect(result.current.data).toBeUndefined();
    expect(result.current.error).toBeNull();
  });

  it('should fetch and return transaction status on success', async () => {
    const mockStatusData: TransactionStatusData = {
      hash: 'tx123',
      status: 'SUCCESS',
      ledger: 1000,
    };

    const mockFetch = jest
      .fn<Promise<TransactionStatusData>, [string]>()
      .mockResolvedValue(mockStatusData);

    const { result } = renderHook(
      () => useTransactionStatus('tx123', mockFetch),
      { wrapper: createWrapper() },
    );

    await waitFor(() => {
      expect(result.current.isLoading).toBe(false);
    });

    expect(result.current.data).toEqual(mockStatusData);
    expect(result.current.error).toBeNull();
    expect(mockFetch).toHaveBeenCalledWith('tx123');
  });

  it('should return error state when fetch fails', async () => {
    const mockError = new Error('Failed to fetch transaction status');
    const mockFetch = jest
      .fn<Promise<TransactionStatusData>, [string]>()
      .mockRejectedValue(mockError);

    const { result } = renderHook(
      () => useTransactionStatus('tx123', mockFetch),
      { wrapper: createWrapper() },
    );

    await waitFor(() => {
      expect(result.current.isLoading).toBe(false);
    });

    expect(result.current.data).toBeUndefined();
    expect(result.current.error).toEqual(mockError);
    expect(mockFetch).toHaveBeenCalledWith('tx123');
  });

  it('should not fetch when hash is null', () => {
    const mockFetch = jest.fn<Promise<TransactionStatusData>, [string]>();

    const { result } = renderHook(
      () => useTransactionStatus(null, mockFetch),
      { wrapper: createWrapper() },
    );

    expect(result.current.isLoading).toBe(false);
    expect(result.current.data).toBeUndefined();
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('should not fetch when hash is undefined', () => {
    const mockFetch = jest.fn<Promise<TransactionStatusData>, [string]>();

    const { result } = renderHook(
      () => useTransactionStatus(undefined, mockFetch),
      { wrapper: createWrapper() },
    );

    expect(result.current.isLoading).toBe(false);
    expect(result.current.data).toBeUndefined();
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('should refetch when hash changes', async () => {
    const mockFetch = jest
      .fn<Promise<TransactionStatusData>, [string]>()
      .mockImplementation(async (hash: string) => ({
        hash,
        status: 'SUCCESS',
        ledger: 1000,
      }));

    const { result, rerender } = renderHook(
      ({ hash }) => useTransactionStatus(hash, mockFetch),
      { wrapper: createWrapper(), initialProps: { hash: 'tx123' } },
    );

    await waitFor(() => {
      expect(result.current.isLoading).toBe(false);
    });

    expect(result.current.data?.hash).toBe('tx123');
    expect(mockFetch).toHaveBeenCalledWith('tx123');

    // Change hash
    rerender({ hash: 'tx456' });

    await waitFor(() => {
      expect(result.current.data?.hash).toBe('tx456');
    });

    expect(mockFetch).toHaveBeenCalledWith('tx456');
    expect(mockFetch).toHaveBeenCalledTimes(2);
  });

  it('should include error message for failed transactions', async () => {
    const mockStatusData: TransactionStatusData = {
      hash: 'tx123',
      status: 'FAILED',
      errorMessage: 'Insufficient balance',
      ledger: 1000,
    };

    const mockFetch = jest
      .fn<Promise<TransactionStatusData>, [string]>()
      .mockResolvedValue(mockStatusData);

    const { result } = renderHook(
      () => useTransactionStatus('tx123', mockFetch),
      { wrapper: createWrapper() },
    );

    await waitFor(() => {
      expect(result.current.isLoading).toBe(false);
    });

    expect(result.current.data?.status).toBe('FAILED');
    expect(result.current.data?.errorMessage).toBe('Insufficient balance');
  });

  it('should handle pending transaction status', async () => {
    const mockStatusData: TransactionStatusData = {
      hash: 'tx123',
      status: 'PENDING',
    };

    const mockFetch = jest
      .fn<Promise<TransactionStatusData>, [string]>()
      .mockResolvedValue(mockStatusData);

    const { result } = renderHook(
      () => useTransactionStatus('tx123', mockFetch),
      { wrapper: createWrapper() },
    );

    await waitFor(() => {
      expect(result.current.isLoading).toBe(false);
    });

    expect(result.current.data?.status).toBe('PENDING');
  });

  it('should handle not found transaction status', async () => {
    const mockStatusData: TransactionStatusData = {
      hash: 'tx123',
      status: 'NOT_FOUND',
    };

    const mockFetch = jest
      .fn<Promise<TransactionStatusData>, [string]>()
      .mockResolvedValue(mockStatusData);

    const { result } = renderHook(
      () => useTransactionStatus('tx123', mockFetch),
      { wrapper: createWrapper() },
    );

    await waitFor(() => {
      expect(result.current.isLoading).toBe(false);
    });

    expect(result.current.data?.status).toBe('NOT_FOUND');
  });
});
