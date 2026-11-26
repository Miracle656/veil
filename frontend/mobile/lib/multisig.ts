/**
 * Multisig coordination against the `multisig-wallet` Soroban contract.
 *
 * The contract (`contracts/multisig-wallet/src/lib.rs`) models an M-of-N wallet:
 * an owner proposes a transfer, owners approve it one at a time, and the
 * approval that reaches the threshold performs the transfer in the same
 * invocation. There is no separate `execute` entry point, and deliberately so —
 * execution is atomic with the deciding approval, which is what stops a
 * fully-approved proposal from sitting around waiting for someone to push a
 * button. The UI reflects that by naming the deciding approval for what it is.
 *
 * Ported from the web wallet's `lib/multisig.ts` with three corrections that a
 * phone forces or a bug required:
 *
 *   - `propose_transaction` takes `caller` as its first argument and calls
 *     `caller.require_auth()`. The web port omits it, so every proposal it
 *     builds is rejected by the contract. It is passed here.
 *   - The web version signs with a separate fee payer and falls back to minting
 *     a throwaway keypair from Friendbot. The owner is the source account here:
 *     they must authorise the call regardless, and a source-account invoker
 *     needs no second signature.
 *   - Amounts are converted through integer string arithmetic rather than
 *     `parseFloat(x) * 10_000_000`, which silently misrounds ordinary values
 *     (`0.1 + 0.2` arithmetic) at stroop precision.
 */

import {
  Account,
  Address,
  Asset,
  BASE_FEE,
  Contract,
  Keypair,
  Networks,
  StrKey,
  TransactionBuilder,
  nativeToScVal,
  rpc as SorobanRpc,
  scValToNative,
} from '@stellar/stellar-sdk';

import { getNetwork } from './network';

// ── Network ─────────────────────────────────────────────────────────────────────

// Read per call rather than captured at module load, so a runtime testnet /
// mainnet switch (lib/network.ts, #526) is honoured instead of the app having
// to restart to pick it up.
function networkPassphrase(): string {
  return getNetwork().networkPassphrase;
}

function rpcUrl(): string {
  return getNetwork().rpcUrl;
}

/** AsyncStorage key holding the active multisig contract. Shared with the web wallet. */
export const MULTISIG_CONTRACT_STORAGE_KEY = 'veil_multisig_contract';

/** Stroops in one XLM. The contract stores amounts in stroops. */
export const STROOPS_PER_XLM = 10_000_000n;

/** Failures a caller can show verbatim. */
export class MultisigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'MultisigError';
  }
}

// ── Types ───────────────────────────────────────────────────────────────────────

export type Proposal = {
  id: number;
  /** Recipient of the transfer. */
  to: string;
  /** Amount in stroops, as the contract stores it. */
  amount: bigint;
  /** Owner addresses that have approved, in approval order. */
  approvals: string[];
  /** True once the transfer has been made. */
  executed: boolean;
};

export type MultisigDetails = {
  contractId: string;
  owners: string[];
  /** Approvals required before a proposal executes. */
  threshold: number;
  /** The contract's native balance, in stroops. */
  balance: bigint;
};

/** Where a proposal stands, for display. */
export type ProposalStatus = 'executed' | 'ready' | 'pending';

// ── Amounts ─────────────────────────────────────────────────────────────────────

/**
 * Convert an XLM amount to stroops.
 *
 * Done as integer arithmetic on the decimal string: at stroop precision, going
 * via a float loses value on inputs as ordinary as `0.7`, and this is money.
 *
 * @throws {MultisigError} If the input is not a positive amount with at most
 *   seven decimal places.
 */
export function parseXlmToStroops(value: string): bigint {
  const trimmed = value.trim();
  if (!/^\d*\.?\d*$/.test(trimmed) || trimmed === '' || trimmed === '.') {
    throw new MultisigError('Enter an amount in XLM, for example 12.5');
  }

  const [whole = '', fraction = ''] = trimmed.split('.');
  if (fraction.length > 7) {
    throw new MultisigError('XLM amounts cannot be finer than 7 decimal places.');
  }

  const stroops = BigInt(`${whole || '0'}${fraction.padEnd(7, '0')}`);
  if (stroops <= 0n) {
    throw new MultisigError('Amount must be greater than zero.');
  }
  return stroops;
}

/** Render stroops as an XLM string, trimmed of trailing zeros. */
export function formatStroopsAsXlm(stroops: bigint): string {
  const negative = stroops < 0n;
  const absolute = negative ? -stroops : stroops;
  const whole = absolute / STROOPS_PER_XLM;
  const fraction = (absolute % STROOPS_PER_XLM).toString().padStart(7, '0').replace(/0+$/, '');
  return `${negative ? '-' : ''}${whole}${fraction ? `.${fraction}` : ''}`;
}

// ── Address helpers ─────────────────────────────────────────────────────────────

/** Whether an address can receive the transfer — a classic account or a contract. */
export function isValidRecipient(address: string): boolean {
  const trimmed = address.trim();
  return StrKey.isValidEd25519PublicKey(trimmed) || StrKey.isValidContract(trimmed);
}

/**
 * The public key for a secret, or null if the secret is unusable.
 *
 * Returns null rather than throwing because the common caller is a text field
 * being typed into, where "not a key yet" is the normal state.
 */
export function publicKeyFromSecret(secret: string): string | null {
  try {
    return Keypair.fromSecret(secret.trim()).publicKey();
  } catch {
    return null;
  }
}

// ── Proposal state ──────────────────────────────────────────────────────────────

/** Whether `address` has already approved `proposal`. */
export function hasApproved(proposal: Proposal, address: string | null): boolean {
  return address !== null && proposal.approvals.includes(address);
}

/** How many more approvals a proposal needs. Zero once the threshold is met. */
export function remainingApprovals(proposal: Proposal, threshold: number): number {
  return Math.max(0, threshold - proposal.approvals.length);
}

/**
 * Whether approving now is the one that executes.
 *
 * The contract transfers the funds inside the invocation that reaches the
 * threshold, so this approval is not "one more signature" — it moves the money,
 * and the button says so.
 */
export function willExecuteOnApproval(proposal: Proposal, threshold: number): boolean {
  return !proposal.executed && remainingApprovals(proposal, threshold) <= 1;
}

/** Where a proposal stands. `ready` means the threshold is met but the chain has not caught up. */
export function proposalStatus(proposal: Proposal, threshold: number): ProposalStatus {
  if (proposal.executed) return 'executed';
  return remainingApprovals(proposal, threshold) === 0 ? 'ready' : 'pending';
}

/**
 * Why the signer cannot approve this proposal, or null if they can.
 *
 * Checked locally so the reason is immediate and specific, rather than arriving
 * as a contract panic after a round trip and a fee.
 */
export function approvalBlocker(
  proposal: Proposal,
  details: MultisigDetails,
  signerAddress: string | null
): string | null {
  if (proposal.executed) return 'This proposal has already been executed.';
  if (!signerAddress) return 'Enter an owner secret key to approve.';
  if (!details.owners.includes(signerAddress)) {
    return 'That key is not one of this wallet’s owners.';
  }
  if (hasApproved(proposal, signerAddress)) return 'You have already approved this proposal.';
  if (willExecuteOnApproval(proposal, details.threshold) && details.balance < proposal.amount) {
    return 'The wallet does not hold enough XLM to execute this transfer.';
  }
  return null;
}

// ── Chain access ────────────────────────────────────────────────────────────────

function server(): SorobanRpc.Server {
  const url = rpcUrl();
  if (!url) {
    throw new MultisigError('No Soroban RPC URL is configured for this network.');
  }
  return new SorobanRpc.Server(url);
}

/**
 * Read a contract value without submitting anything.
 *
 * Simulation needs a source account but never charges it, so a throwaway
 * address is used rather than requiring the reader to hold a funded key just to
 * look at the queue.
 */
async function simulateRead(contract: Contract, method: string, ...args: unknown[]): Promise<unknown> {
  const rpcServer = server();
  const reader = new Account(Keypair.random().publicKey(), '0');

  const tx = new TransactionBuilder(reader, {
    fee: BASE_FEE,
    networkPassphrase: networkPassphrase(),
  })
    .addOperation(contract.call(method, ...(args as never[])))
    .setTimeout(30)
    .build();

  const simulation = await rpcServer.simulateTransaction(tx);
  if (SorobanRpc.Api.isSimulationError(simulation)) {
    throw new MultisigError(`Could not read ${method} from the contract: ${simulation.error}`);
  }
  return simulation.result?.retval === undefined
    ? undefined
    : scValToNative(simulation.result.retval);
}

/** Poll until the transaction is confirmed, or give up rather than hang the screen. */
async function waitForTx(
  rpcServer: SorobanRpc.Server,
  hash: string
): Promise<SorobanRpc.Api.GetTransactionResponse> {
  for (let attempt = 0; attempt < 30; attempt++) {
    const result = await rpcServer.getTransaction(hash);
    if (result.status !== SorobanRpc.Api.GetTransactionStatus.NOT_FOUND) return result;
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
  throw new MultisigError(`Transaction ${hash} was not confirmed in time.`);
}

/**
 * Invoke a contract method as `signerSecret`, and wait for it to land.
 *
 * The signer is the source account as well as the authorising address, so
 * `prepareTransaction` resolves the contract's `require_auth` against the
 * source account and the envelope signature is the only one needed.
 */
async function invokeAsOwner(params: {
  contractId: string;
  signerSecret: string;
  method: string;
  args: unknown[];
}): Promise<string> {
  const rpcServer = server();

  let signer: Keypair;
  try {
    signer = Keypair.fromSecret(params.signerSecret.trim());
  } catch {
    throw new MultisigError('That is not a valid Stellar secret key (it starts with S).');
  }

  let source: Account;
  try {
    source = await rpcServer.getAccount(signer.publicKey());
  } catch {
    throw new MultisigError(
      'That owner account does not exist on this network yet, so it cannot pay the fee.'
    );
  }

  const contract = new Contract(params.contractId);
  const tx = new TransactionBuilder(source, {
    fee: BASE_FEE,
    networkPassphrase: networkPassphrase(),
  })
    .addOperation(contract.call(params.method, ...(params.args as never[])))
    .setTimeout(60)
    .build();

  const prepared = await rpcServer.prepareTransaction(tx);
  prepared.sign(signer);

  const submitted = await rpcServer.sendTransaction(prepared);
  if (submitted.status === 'ERROR') {
    throw new MultisigError(`The network rejected the transaction: ${submitted.status}`);
  }

  const confirmed = await waitForTx(rpcServer, submitted.hash);
  if (confirmed.status !== SorobanRpc.Api.GetTransactionStatus.SUCCESS) {
    throw new MultisigError(`The transaction failed on-chain (${confirmed.status}).`);
  }
  return submitted.hash;
}

/** Read the wallet's owners, threshold, and native balance. */
export async function fetchMultisigDetails(contractId: string): Promise<MultisigDetails> {
  if (!StrKey.isValidContract(contractId)) {
    throw new MultisigError('That is not a valid multisig contract address (it starts with C).');
  }

  const contract = new Contract(contractId);
  const owners = (await simulateRead(contract, 'get_owners')) as string[];
  const threshold = Number(await simulateRead(contract, 'get_threshold'));

  // Balance is read from the native SAC, not the multisig — the contract holds
  // its funds there. A failure here should not hide the rest of the wallet.
  let balance = 0n;
  try {
    const sac = new Contract(Asset.native().contractId(networkPassphrase()));
    balance = BigInt(
      (await simulateRead(sac, 'balance', nativeToScVal(contractId, { type: 'address' }))) as bigint
    );
  } catch {
    balance = 0n;
  }

  return { contractId, owners, threshold, balance };
}

/** Read every proposal, newest first. */
export async function fetchProposals(contractId: string): Promise<Proposal[]> {
  const contract = new Contract(contractId);
  const count = Number(await simulateRead(contract, 'get_proposal_count'));

  const proposals: Proposal[] = [];
  for (let id = 1; id <= count; id++) {
    const raw = (await simulateRead(
      contract,
      'get_proposal',
      nativeToScVal(id, { type: 'u64' })
    )) as { id: bigint; to: string; amount: bigint; approvals: string[]; executed: boolean };

    proposals.push({
      id: Number(raw.id),
      to: raw.to,
      amount: BigInt(raw.amount),
      approvals: raw.approvals,
      executed: raw.executed,
    });
  }

  return proposals.sort((a, b) => b.id - a.id);
}

/**
 * Propose a transfer out of the multisig.
 *
 * The proposer must be an owner: the contract authorises `caller` and rejects
 * anyone else, so a proposal cannot be raised by a stranger holding the
 * contract address.
 */
export async function proposeTransfer(params: {
  contractId: string;
  proposerSecret: string;
  to: string;
  amountXlm: string;
}): Promise<string> {
  const to = params.to.trim();
  if (!isValidRecipient(to)) {
    throw new MultisigError('Enter a valid destination address (G… account or C… contract).');
  }
  const amount = parseXlmToStroops(params.amountXlm);

  const proposer = publicKeyFromSecret(params.proposerSecret);
  if (!proposer) {
    throw new MultisigError('That is not a valid Stellar secret key (it starts with S).');
  }

  return invokeAsOwner({
    contractId: params.contractId,
    signerSecret: params.proposerSecret,
    method: 'propose_transaction',
    args: [
      // `caller` — the contract requires the proposer's own authorisation.
      new Address(proposer).toScVal(),
      new Address(to).toScVal(),
      nativeToScVal(amount, { type: 'i128' }),
    ],
  });
}

/**
 * Approve a proposal as an owner.
 *
 * When this approval reaches the threshold the contract executes the transfer
 * within the same invocation — so a success here can mean "signed" or "signed
 * and paid". {@link willExecuteOnApproval} is how a caller tells the user which
 * one they are about to do.
 */
export async function approveProposal(params: {
  contractId: string;
  proposalId: number;
  signerSecret: string;
}): Promise<string> {
  const signer = publicKeyFromSecret(params.signerSecret);
  if (!signer) {
    throw new MultisigError('That is not a valid Stellar secret key (it starts with S).');
  }

  return invokeAsOwner({
    contractId: params.contractId,
    signerSecret: params.signerSecret,
    method: 'sign_transaction',
    args: [
      nativeToScVal(params.proposalId, { type: 'u64' }),
      new Address(signer).toScVal(),
    ],
  });
}
