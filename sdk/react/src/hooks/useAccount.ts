import { useQuery, UseQueryResult } from '@tanstack/react-query';

/**
 * Account information returned by useAccount hook
 */
export interface AccountData {
  /** The account address */
  address: string;
  /** Account sequence number */
  sequenceNumber: string;
  /** Whether the account is deployed on-chain */
  isDeployed: boolean;
  /** Optional list of signers */
  signers?: Array<{
    index: number;
    publicKey: string;
  }>;
  /** Optional guardian address if set */
  guardian?: string;
}

/**
 * Hook to fetch account information
 * @param address - The account address to fetch information for
 * @param fetchFn - Function to fetch account data
 * @returns Query result with data, error, and isLoading state
 */
export function useAccount(
  address: string | null | undefined,
  fetchFn: (address: string) => Promise<AccountData>,
): UseQueryResult<AccountData, Error> {
  return useQuery({
    queryKey: ['account', address],
    queryFn: async () => {
      if (!address) {
        throw new Error('Address is required to fetch account information');
      }
      return fetchFn(address);
    },
    enabled: !!address,
    staleTime: 30 * 1000, // 30 seconds
    gcTime: 10 * 60 * 1000, // 10 minutes
  });
}
