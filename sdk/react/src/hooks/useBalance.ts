import { useQuery, UseQueryResult } from '@tanstack/react-query';

/**
 * Response data from useBalance hook
 */
export interface BalanceData {
  /** The account address */
  address: string;
  /** Balance amount as a bigint or number */
  amount: bigint | number;
  /** The token or asset identifier */
  assetCode?: string;
}

/**
 * Hook to fetch the balance of an account
 * @param address - The account address to fetch balance for
 * @param fetchFn - Function to fetch the balance from the wallet
 * @returns Query result with data, error, and isLoading state
 */
export function useBalance(
  address: string | null | undefined,
  fetchFn: (address: string) => Promise<BalanceData>,
): UseQueryResult<BalanceData, Error> {
  return useQuery({
    queryKey: ['balance', address],
    queryFn: async () => {
      if (!address) {
        throw new Error('Address is required to fetch balance');
      }
      return fetchFn(address);
    },
    enabled: !!address,
    staleTime: 10 * 1000, // 10 seconds
    gcTime: 5 * 60 * 1000, // 5 minutes
  });
}
