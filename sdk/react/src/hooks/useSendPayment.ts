import { useMutation, useQueryClient, UseMutationResult } from '@tanstack/react-query';
import type { SignerInput } from '../../../src/signer';
import { useVeilContext } from '../context';

/**
 * Input parameters for sending a payment
 */
export interface SendPaymentInput {
  /**
   * Signer for the account that pays transaction fees: a `TransactionSigner`
   * whose `signTransaction` runs where the key lives. A secret string or
   * Keypair is still accepted but deprecated.
   */
  feePayer: SignerInput;
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
 * Hook to send a payment using the current wallet from context
 * @returns Mutation result with data, error, isLoading, and mutate function
 */
export function useSendPayment(): UseMutationResult<SendPaymentData, Error, SendPaymentInput> {
  const { wallet } = useVeilContext();
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async (input: SendPaymentInput) => {
      if (!wallet.address) {
        throw new Error('Wallet address is required to send payment');
      }
      if (!wallet.sendPayment) {
        throw new Error('Wallet send capability is not available');
      }
      if (!input.feePayer) {
        throw new Error('A fee payer signer is required to send payment');
      }

      return wallet.sendPayment(
        input.feePayer,
        input.to,
        input.amount,
        input.token,
        input.memo,
      );
    },
    onSuccess: async () => {
      if (wallet.address) {
        await queryClient.invalidateQueries({ queryKey: ['balance', wallet.address] });
      }
    },
  });
}
