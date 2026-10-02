import {
  Asset,
  BASE_FEE,
  Horizon,
  Keypair,
  Memo,
  Networks,
  Operation,
  StrKey,
  TransactionBuilder,
} from '@stellar/stellar-sdk';
import { isValidDestination } from 'invisible-wallet-sdk';

export type SendFaucetPaymentOptions = {
  faucetSecretKey: string;
  destination: string;
  amountXlm: string;
  horizonUrl?: string;
  networkPassphrase?: string;
  memo?: string;
};

export type FaucetPaymentResult = {
  hash: string;
  explorerUrl: string;
};

function isClassicPaymentDestination(destination: string): boolean {
  return (
    StrKey.isValidEd25519PublicKey(destination) ||
    StrKey.isValidMed25519PublicKey(destination)
  );
}

function createExplorerUrl(hash: string, networkPassphrase: string): string {
  const network = networkPassphrase === Networks.PUBLIC ? 'public' : 'testnet';
  return `https://stellar.expert/explorer/${network}/tx/${hash}`;
}

function getHorizonMessage(error: unknown): string {
  if (error instanceof Error) {
    const response = (error as Error & { response?: { data?: unknown } }).response;
    if (response?.data && typeof response.data === 'object') {
      const extras = (response.data as { extras?: { result_codes?: unknown } }).extras;
      if (extras?.result_codes) {
        return `${error.message}: ${JSON.stringify(extras.result_codes)}`;
      }
    }

    return error.message;
  }

  return 'Unknown Horizon error';
}

export async function sendFaucetPayment(
  options: SendFaucetPaymentOptions,
): Promise<FaucetPaymentResult> {
  const destination = options.destination.trim();

  if (!isValidDestination(destination) || !isClassicPaymentDestination(destination)) {
    throw new Error('Enter a valid Stellar account or muxed account address.');
  }

  const sourceKeypair = Keypair.fromSecret(options.faucetSecretKey);
  const horizon = new Horizon.Server(options.horizonUrl ?? 'https://horizon-testnet.stellar.org');
  const networkPassphrase = options.networkPassphrase ?? Networks.TESTNET;

  try {
    const sourceAccount = await horizon.loadAccount(sourceKeypair.publicKey());
    const transaction = new TransactionBuilder(sourceAccount, {
      fee: BASE_FEE,
      networkPassphrase,
    })
      .addOperation(Operation.payment({
        destination,
        asset: Asset.native(),
        amount: options.amountXlm,
      }))
      .addMemo(Memo.text(options.memo ?? 'veil faucet'))
      .setTimeout(180)
      .build();

    transaction.sign(sourceKeypair);

    const response = await horizon.submitTransaction(transaction);
    return {
      hash: response.hash,
      explorerUrl: createExplorerUrl(response.hash, networkPassphrase),
    };
  } catch (error) {
    throw new Error(getHorizonMessage(error));
  }
}
