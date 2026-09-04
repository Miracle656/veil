/**
 * Tests for useSendPayment hook
 */

import { renderHook, act, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { ReactNode } from 'react';
import { useSendPayment, type SendPaymentInput, type SendPaymentData } from '../hooks/useSendPayment';
import { useVeilContext } from '../context';

// The hook reads the active wallet (incl. its sendPayment capability) from
// context, so stub useVeilContext with a wallet whose sendPayment is the mock.
jest.mock('../context', () => ({
  useVeilContext: jest.fn(),
}));

const mockUseVeilContext = useVeilContext as jest.MockedFunction<typeof useVeilContext>;

const FEE_PAYER = 'SFEEPAYERSECRET';

function setWallet(sendPayment: jest.Mock) {
  mockUseVeilContext.mockReturnValue({
    wallet: { address: 'GWALLETADDRESS', sendPayment },
  } as unknown as ReturnType<typeof useVeilContext>);
}

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
    setWallet(jest.fn());
    const { result } = renderHook(() => useSendPayment(), { wrapper: createWrapper() });

    expect(result.current.isPending).toBe(false);
    expect(result.current.data).toBeUndefined();
    expect(result.current.error).toBeNull();
  });

  it('should set loading state when mutation is called', async () => {
    const mockSend = jest
      .fn()
      .mockImplementation(() => new Promise((resolve) => setTimeout(resolve, 100)));
    setWallet(mockSend);

    const { result } = renderHook(() => useSendPayment(), { wrapper: createWrapper() });

    const input: SendPaymentInput = { feePayer: FEE_PAYER, to: 'G456DEF', amount: 500 };

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

    const mockSend = jest.fn().mockResolvedValue(mockPaymentData);
    setWallet(mockSend);

    const { result } = renderHook(() => useSendPayment(), { wrapper: createWrapper() });

    const input: SendPaymentInput = { feePayer: FEE_PAYER, to: 'G456DEF', amount: 500 };

    act(() => {
      result.current.mutate(input);
    });

    await waitFor(() => {
      expect(result.current.isPending).toBe(false);
    });

    expect(result.current.data).toEqual(mockPaymentData);
    expect(result.current.error).toBeNull();
    expect(mockSend).toHaveBeenCalledWith(FEE_PAYER, 'G456DEF', 500, undefined, undefined);
  });

  it('should handle payment submission errors', async () => {
    const mockError = new Error('Insufficient balance');
    const mockSend = jest.fn().mockRejectedValue(mockError);
    setWallet(mockSend);

    const { result } = renderHook(() => useSendPayment(), { wrapper: createWrapper() });

    const input: SendPaymentInput = { feePayer: FEE_PAYER, to: 'G456DEF', amount: 500 };

    act(() => {
      result.current.mutate(input);
    });

    await waitFor(() => {
      expect(result.current.isPending).toBe(false);
    });

    expect(result.current.data).toBeUndefined();
    expect(result.current.error).toEqual(mockError);
    expect(mockSend).toHaveBeenCalledWith(FEE_PAYER, 'G456DEF', 500, undefined, undefined);
  });

  it('should support all SendPaymentInput fields', async () => {
    const mockPaymentData: SendPaymentData = {
      transactionHash: 'abc123',
      status: 'SUCCESS',
    };

    const mockSend = jest.fn().mockResolvedValue(mockPaymentData);
    setWallet(mockSend);

    const { result } = renderHook(() => useSendPayment(), { wrapper: createWrapper() });

    const input: SendPaymentInput = {
      feePayer: FEE_PAYER,
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
    expect(mockSend).toHaveBeenCalledWith(FEE_PAYER, 'G456DEF', 1000, 'CUSDC', 'Payment for services');
  });

  it('should reset error when calling mutate again', async () => {
    let callCount = 0;
    const mockSend = jest.fn().mockImplementation(() => {
      callCount++;
      if (callCount === 1) {
        return Promise.reject(new Error('First call failed'));
      }
      return Promise.resolve({ transactionHash: 'success123', status: 'SUCCESS' });
    });
    setWallet(mockSend);

    const { result } = renderHook(() => useSendPayment(), { wrapper: createWrapper() });

    // First call - fails
    act(() => {
      result.current.mutate({ feePayer: FEE_PAYER, to: 'G456DEF', amount: 500 });
    });

    await waitFor(() => {
      expect(result.current.isPending).toBe(false);
    });

    expect(result.current.error).not.toBeNull();

    // Second call - succeeds
    act(() => {
      result.current.mutate({ feePayer: FEE_PAYER, to: 'G456DEF', amount: 500 });
    });

    await waitFor(() => {
      expect(result.current.isPending).toBe(false);
    });

    expect(result.current.error).toBeNull();
    expect(result.current.data?.status).toBe('SUCCESS');
  });
});
