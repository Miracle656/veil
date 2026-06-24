/**
 * Tests for useSendPayment hook
 */

import { renderHook, act, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { ReactNode } from 'react';
import { useSendPayment, type SendPaymentInput, type SendPaymentData } from '../hooks/useSendPayment';

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

describe('useSendPayment', () => {
  it('should return initial state with idle status', () => {
    const mockSend = jest.fn<Promise<SendPaymentData>, [SendPaymentInput]>();
    const { result } = renderHook(
      () => useSendPayment(mockSend),
      { wrapper: createWrapper() },
    );

    expect(result.current.isPending).toBe(false);
    expect(result.current.data).toBeUndefined();
    expect(result.current.error).toBeNull();
  });

  it('should set loading state when mutation is called', async () => {
    const mockSend = jest
      .fn<Promise<SendPaymentData>, [SendPaymentInput]>()
      .mockImplementation(() => new Promise((resolve) => setTimeout(resolve, 100)));

    const { result } = renderHook(
      () => useSendPayment(mockSend),
      { wrapper: createWrapper() },
    );

    const input: SendPaymentInput = { to: 'G456DEF', amount: 500 };

    act(() => {
      result.current.mutate(input);
    });

    await waitFor(() => {
      expect(result.current.isPending).toBe(true);
    });

    await waitFor(() => {
      expect(result.current.isPending).toBe(false);
    });
  });

  it('should handle successful payment submission', async () => {
    const mockPaymentData: SendPaymentData = {
      transactionHash: 'abc123def456',
      status: 'PENDING',
    };

    const mockSend = jest
      .fn<Promise<SendPaymentData>, [SendPaymentInput]>()
      .mockResolvedValue(mockPaymentData);

    const { result } = renderHook(
      () => useSendPayment(mockSend),
      { wrapper: createWrapper() },
    );

    const input: SendPaymentInput = { to: 'G456DEF', amount: 500 };

    act(() => {
      result.current.mutate(input);
    });

    await waitFor(() => {
      expect(result.current.isPending).toBe(false);
    });

    expect(result.current.data).toEqual(mockPaymentData);
    expect(result.current.error).toBeNull();
    expect(mockSend).toHaveBeenCalledWith(input);
  });

  it('should handle payment submission errors', async () => {
    const mockError = new Error('Insufficient balance');
    const mockSend = jest
      .fn<Promise<SendPaymentData>, [SendPaymentInput]>()
      .mockRejectedValue(mockError);

    const { result } = renderHook(
      () => useSendPayment(mockSend),
      { wrapper: createWrapper() },
    );

    const input: SendPaymentInput = { to: 'G456DEF', amount: 500 };

    act(() => {
      result.current.mutate(input);
    });

    await waitFor(() => {
      expect(result.current.isPending).toBe(false);
    });

    expect(result.current.data).toBeUndefined();
    expect(result.current.error).toEqual(mockError);
    expect(mockSend).toHaveBeenCalledWith(input);
  });

  it('should support all SendPaymentInput fields', async () => {
    const mockPaymentData: SendPaymentData = {
      transactionHash: 'abc123',
      status: 'SUCCESS',
    };

    const mockSend = jest
      .fn<Promise<SendPaymentData>, [SendPaymentInput]>()
      .mockResolvedValue(mockPaymentData);

    const { result } = renderHook(
      () => useSendPayment(mockSend),
      { wrapper: createWrapper() },
    );

    const input: SendPaymentInput = {
      to: 'G456DEF',
      amount: 1000,
      token: 'CUSDC',
      memo: 'Payment for services',
    };

    act(() => {
      result.current.mutate(input);
    });

    await waitFor(() => {
      expect(result.current.isPending).toBe(false);
    });

    expect(result.current.data).toEqual(mockPaymentData);
    expect(mockSend).toHaveBeenCalledWith(input);
  });

  it('should reset error when calling mutate again', async () => {
    let callCount = 0;
    const mockSend = jest.fn<Promise<SendPaymentData>, [SendPaymentInput]>().mockImplementation(() => {
      callCount++;
      if (callCount === 1) {
        return Promise.reject(new Error('First call failed'));
      }
      return Promise.resolve({ transactionHash: 'success123', status: 'SUCCESS' });
    });

    const { result } = renderHook(
      () => useSendPayment(mockSend),
      { wrapper: createWrapper() },
    );

    // First call - fails
    act(() => {
      result.current.mutate({ to: 'G456DEF', amount: 500 });
    });

    await waitFor(() => {
      expect(result.current.isPending).toBe(false);
    });

    expect(result.current.error).not.toBeNull();

    // Second call - succeeds
    act(() => {
      result.current.mutate({ to: 'G456DEF', amount: 500 });
    });

    await waitFor(() => {
      expect(result.current.isPending).toBe(false);
    });

    expect(result.current.error).toBeNull();
    expect(result.current.data?.status).toBe('SUCCESS');
  });
});
