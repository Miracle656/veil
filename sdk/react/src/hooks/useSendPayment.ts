import { useMutation, UseMutationResult } from '@tanstack/react-query';

/**
 * Input parameters for sending a payment
 */
export interface SendPaymentInput {
  /** Recipient address */
  to: string;
  /** Amount to send */
  amount: number | bigint;
  /** Optional token address */
  token?: string;
  /** Optional memo */
  memo?: string;
}

/**
 * Response data from a successful payment
 */
export interface SendPaymentData {
  /** Transaction hash of the submitted payment */
  transactionHash: string;
  /** Status of the transaction */
  status: 'PENDING' | 'SUCCESS' | 'FAILED';
}

/**
 * Hook to send a payment
 * @param sendFn - Function to execute the payment
 * @returns Mutation result with data, error, isLoading, and mutate function
 */
export function useSendPayment(
  sendFn: (input: SendPaymentInput) => Promise<SendPaymentData>,
): UseMutationResult<SendPaymentData, Error, SendPaymentInput> {
  return useMutation({
    mutationFn: async (input: SendPaymentInput) => {
      return sendFn(input);
    },
  });
}
