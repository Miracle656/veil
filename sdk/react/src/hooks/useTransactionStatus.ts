import { useQuery, UseQueryResult } from '@tanstack/react-query';

/**
 * Transaction status types
 */
export type TransactionStatusType = 'PENDING' | 'SUCCESS' | 'FAILED' | 'NOT_FOUND';

/**
 * Response data from useTransactionStatus hook
 */
export interface TransactionStatusData {
  /** The transaction hash */
  hash: string;
  /** Current status of the transaction */
  status: TransactionStatusType;
  /** Optional error message if failed */
  errorMessage?: string;
  /** Block height or ledger sequence if applicable */
  ledger?: number;
}

/**
 * Hook to fetch the status of a transaction
 * @param transactionHash - The hash of the transaction to check
 * @param fetchFn - Function to fetch transaction status
 * @returns Query result with data, error, and isLoading state
 */
export function useTransactionStatus(
  transactionHash: string | null | undefined,
  fetchFn: (hash: string) => Promise<TransactionStatusData>,
): UseQueryResult<TransactionStatusData, Error> {
  return useQuery({
    queryKey: ['transactionStatus', transactionHash],
    queryFn: async () => {
      if (!transactionHash) {
        throw new Error('Transaction hash is required to fetch status');
      }
      return fetchFn(transactionHash);
    },
    enabled: !!transactionHash,
    staleTime: 5 * 1000, // 5 seconds
    gcTime: 10 * 60 * 1000, // 10 minutes
    // Poll with progressively increasing intervals until transaction is final
    refetchInterval: (query) => {
      const data = query?.state?.data;
      if (!data) return 5 * 1000; // 5 seconds
      if (data.status === 'PENDING') {
        return 2 * 1000; // 2 seconds for pending
      }
      return false; // Stop polling once final status is reached
    },
  });
}
