import { useQuery, UseQueryResult } from '@tanstack/react-query';
import { useVeilContext } from '../context';

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
 * Hook to fetch the balance of the current wallet
 * @returns Query result with data, error, and isLoading state
 */
export function useBalance(): UseQueryResult<BalanceData, Error> {
  const { wallet } = useVeilContext();

  return useQuery({
    queryKey: ['balance', wallet.address],
    queryFn: async () => {
      if (!wallet.address) {
        throw new Error('Address is required to fetch balance');
      }
      return wallet.getBalance();
    },
    enabled: !!wallet.address,
    staleTime: 10 * 1000,
    gcTime: 5 * 60 * 1000,
  });
}
