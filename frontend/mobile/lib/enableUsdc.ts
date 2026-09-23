/**
 * Add a USDC trustline to the wallet's classic account, so it can be paid.
 *
 * Stellar will not deliver a non-native asset to an account that does not
 * already trust it. A payer gets `op_no_trust` and the payment fails, which is
 * how a wallet that "works" ends up rejecting somebody's salary.
 *
 * This is deliberately the user's own operation, signed with the user's own
 * key on their own device. The alternative — a sponsored trustline posted by
 * Veil — needs both the sponsor's signature and the user's in one transaction,
 * which means a co-signing service. That is the right long-term design and it
 * is not a thing to build the week of a payout.
 *
 * The 0.5 XLM this locks is a refundable reserve, not a fee: removing the
 * trustline later returns it.
 */

import {
  Asset,
  BASE_FEE,
  Horizon,
  Operation,
  TransactionBuilder,
  Keypair,
} from '@stellar/stellar-sdk';

import { getNetwork, getNetworkName } from './network';
import { getSignerSecret } from './walletStore';
import { usdcIssuerFor } from './receiveReadiness';

/** Reserve for one trustline (0.5 XLM) plus room for the fee. */
export const MIN_XLM_FOR_TRUSTLINE = 0.6;

export class NotEnoughXlm extends Error {
  constructor(readonly have: number) {
    super(
      `This account holds ${have} XLM. Adding a USDC trustline needs about ${MIN_XLM_FOR_TRUSTLINE} XLM of refundable reserve.`,
    );
    this.name = 'NotEnoughXlm';
  }
}

export class AccountNotFunded extends Error {
  constructor() {
    super('This account does not exist on the network yet, so it cannot add a trustline.');
    this.name = 'AccountNotFunded';
  }
}

/**
 * Add the canonical USDC trustline to the wallet's classic account.
 *
 * Resolves with the transaction hash, or with `null` when the trustline is
 * already there — an existing trustline is success, not an error, and the
 * caller should not have to tell those apart.
 */
export async function enableUsdc(): Promise<string | null> {
  const secret = await getSignerSecret();
  if (!secret) throw new Error('This device has no signing key for the classic account.');

  const network = getNetwork();
  const kp = Keypair.fromSecret(secret);
  const usdc = new Asset('USDC', usdcIssuerFor(getNetworkName()));
  const server = new Horizon.Server(network.horizonUrl);

  let account: Awaited<ReturnType<typeof server.loadAccount>>;
  try {
    account = await server.loadAccount(kp.publicKey());
  } catch (err) {
    // Horizon 404s an account that has never been funded. That is a distinct
    // problem with a distinct fix (somebody has to create it), so it gets its
    // own error rather than a generic failure.
    const status = (err as { response?: { status?: number } })?.response?.status;
    if (status === 404) throw new AccountNotFunded();
    throw err;
  }

  const balances = account.balances as Array<{
    asset_type: string;
    asset_code?: string;
    asset_issuer?: string;
    balance: string;
  }>;

  const already = balances.some(
    (b) => b.asset_code === 'USDC' && b.asset_issuer === usdc.issuer,
  );
  if (already) return null;

  const native = balances.find((b) => b.asset_type === 'native');
  const xlm = Number(native?.balance ?? '0');
  if (!(xlm >= MIN_XLM_FOR_TRUSTLINE)) throw new NotEnoughXlm(xlm);

  const tx = new TransactionBuilder(account, {
    fee: BASE_FEE,
    networkPassphrase: network.networkPassphrase,
  })
    .addOperation(Operation.changeTrust({ asset: usdc }))
    .setTimeout(60)
    .build();

  tx.sign(kp);
  const res = await server.submitTransaction(tx);
  return res.hash;
}
