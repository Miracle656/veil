/**
 * Escrow (Stellar claimable balance) helpers for mobile.
 *
 * The web wallet re-exports this whole surface from `sdk/src/claimableBalance.ts`
 * (`frontend/wallet/lib/escrow.ts` is a one-line `export * from '../../../sdk/src/claimableBalance'`).
 * The same relative path resolves from `frontend/mobile/lib` too, but that file
 * imports `@stellar/stellar-sdk`, and the mobile TypeScript program only
 * resolves modules from `frontend/mobile/node_modules` — there is no hoisted
 * root `node_modules`, so `tsc` cannot find `@stellar/stellar-sdk` when the
 * sdk file is pulled in via a blind `export *`. Mobile already depends on
 * `@stellar/stellar-sdk` directly, so this file mirrors the sdk implementation
 * locally instead of reaching outside the mobile package.
 */
import {
  Asset,
  BASE_FEE,
  Claimant,
  Horizon,
  Keypair,
  Operation,
  TransactionBuilder,
} from '@stellar/stellar-sdk';

export type EscrowConfig = {
  /** Stellar Horizon REST API base URL (e.g. "https://horizon-testnet.stellar.org").
   *  Must be a Horizon URL — NOT a Soroban RPC endpoint. */
  horizonUrl: string;
  networkPassphrase: string;
};

export type CreateEscrowOptions = {
  senderKeypair: Keypair;
  recipientAddress: string;
  amount: string;
  asset: Asset;
  /** Duration in seconds from now before the sender can reclaim the balance. */
  claimDeadlineSeconds: number;
  config: EscrowConfig;
};

export type EscrowResult = {
  balanceId: string;
  claimLink: string;
  expiresAt: number;
};

export type ClaimOptions = {
  claimantKeypair: Keypair;
  balanceId: string;
  config: EscrowConfig;
};

export type ReclaimOptions = {
  senderKeypair: Keypair;
  balanceId: string;
  config: EscrowConfig;
};

export function buildClaimLink(balanceId: string): string {
  return `https://app.veil.xyz/claim/${balanceId}`;
}

/**
 * Build the two Stellar Claimant entries for an escrow balance:
 *  - recipient: may claim unconditionally at any time.
 *  - sender: may reclaim ONLY after `deadlineUnix` (unix timestamp).
 *
 * A Stellar claimable balance is consumed by the first successful claim.
 * Once either party claims, the balance is gone — the other party's subsequent
 * claim will be rejected by the Stellar network. Design UIs accordingly.
 */
export function buildEscrowClaimants(
  recipientAddress: string,
  senderAddress: string,
  deadlineUnix: number,
): Claimant[] {
  const recipientClaimant = new Claimant(recipientAddress, Claimant.predicateUnconditional());
  const senderClaimant = new Claimant(
    senderAddress,
    Claimant.predicateNot(Claimant.predicateBeforeAbsoluteTime(deadlineUnix.toString())),
  );
  return [recipientClaimant, senderClaimant];
}

/**
 * Create a Stellar claimable balance escrow.
 *
 * The recipient may claim immediately (unconditional predicate).
 * The sender may reclaim after `claimDeadlineSeconds` has elapsed.
 * Claim and reclaim are mutually exclusive — the first successful claim
 * consumes the balance.
 *
 * @throws If Horizon does not return a balance_id in its response.
 */
export async function createEscrow(options: CreateEscrowOptions): Promise<EscrowResult> {
  const { senderKeypair, recipientAddress, amount, asset, claimDeadlineSeconds, config } = options;
  const server = new Horizon.Server(config.horizonUrl);

  const account = await server.loadAccount(senderKeypair.publicKey());
  const expiresAt = Math.floor(Date.now() / 1000) + claimDeadlineSeconds;

  const claimants = buildEscrowClaimants(recipientAddress, senderKeypair.publicKey(), expiresAt);

  const tx = new TransactionBuilder(account, {
    fee: BASE_FEE,
    networkPassphrase: config.networkPassphrase,
  })
    .addOperation(
      Operation.createClaimableBalance({
        asset,
        amount,
        claimants,
      }),
    )
    .setTimeout(180)
    .build();

  tx.sign(senderKeypair);

  const result = await server.submitTransaction(tx);
  const balanceId = (result as unknown as { balance_id?: string }).balance_id;
  if (!balanceId) {
    throw new Error('create_claimable_balance: missing balance_id in Horizon response');
  }

  return {
    balanceId,
    claimLink: buildClaimLink(balanceId),
    expiresAt,
  };
}

/**
 * Claim a claimable balance as the recipient.
 *
 * Once claimed the balance is consumed. A subsequent reclaimEscrow() call
 * by the sender will be rejected by the Stellar network.
 */
export async function claimEscrow(options: ClaimOptions): Promise<{ txHash: string }> {
  const { claimantKeypair, balanceId, config } = options;
  const server = new Horizon.Server(config.horizonUrl);

  const account = await server.loadAccount(claimantKeypair.publicKey());

  const tx = new TransactionBuilder(account, {
    fee: BASE_FEE,
    networkPassphrase: config.networkPassphrase,
  })
    .addOperation(Operation.claimClaimableBalance({ balanceId }))
    .setTimeout(180)
    .build();

  tx.sign(claimantKeypair);

  const result = await server.submitTransaction(tx);
  return { txHash: result.hash };
}

/**
 * Reclaim a claimable balance as the sender after the deadline has passed.
 *
 * Will be rejected by the Stellar network if called before `expiresAt` or
 * if the recipient has already claimed the balance.
 */
export async function reclaimEscrow(options: ReclaimOptions): Promise<{ txHash: string }> {
  const { senderKeypair, balanceId, config } = options;
  const server = new Horizon.Server(config.horizonUrl);

  const account = await server.loadAccount(senderKeypair.publicKey());

  const tx = new TransactionBuilder(account, {
    fee: BASE_FEE,
    networkPassphrase: config.networkPassphrase,
  })
    .addOperation(Operation.claimClaimableBalance({ balanceId }))
    .setTimeout(180)
    .build();

  tx.sign(senderKeypair);

  const result = await server.submitTransaction(tx);
  return { txHash: result.hash };
}
