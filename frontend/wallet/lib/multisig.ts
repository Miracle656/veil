import { inclusionFee } from './fees'
import {
  Keypair,
  rpc as SorobanRpc,
  Contract,
  Account,
  TransactionBuilder,
  BASE_FEE,
  Asset,
  nativeToScVal,
  scValToNative,
  Networks,
  StrKey,
  Operation,
  Address,
  authorizeEntry,
  xdr,
  type Transaction,
} from '@stellar/stellar-sdk';
import { getNetwork } from './network';
import { getMultisigWasmHash } from './multisigConfig';
import { xlmToStroops } from './vault';
import { walletLocal, walletSession } from '@/lib/walletStorage'

const network = getNetwork();
const RPC_URL = network.rpcUrl;
const NETWORK_PASSPHRASE = network.networkPassphrase;

export interface ProposalDetails {
  id: number;
  to: string;
  amount: string;
  approvals: string[];
  executed: boolean;
}

export interface MultisigDetails {
  contractId: string;
  owners: string[];
  threshold: number;
  balanceXlm: string;
}

/**
 * Check a multisig configuration before anything is deployed or paid for, and
 * return the owners trimmed.
 *
 * The contract's own check is `owners.len() >= threshold`, which counts a
 * repeated owner twice, while approvals are de-duplicated. So `[A, A]` with a
 * threshold of 2 initialises and can then never execute, and `[A, A, B]` at 2
 * reads as "2 of 3" but needs both A and B. Repeats are refused here.
 */
export function validateMultisigConfig(owners: string[], threshold: number): string[] {
  const trimmed = owners.map((o) => o.trim());
  if (trimmed.length === 0) {
    throw new Error('A multisig needs at least one owner.');
  }
  for (const owner of trimmed) {
    try {
      Address.fromString(owner);
    } catch {
      throw new Error('Every owner must be a valid Stellar G... or C... address.');
    }
  }
  if (new Set(trimmed).size !== trimmed.length) {
    throw new Error('Each owner can be listed only once: a repeated owner still approves only once.');
  }
  if (!Number.isInteger(threshold) || threshold < 1) {
    throw new Error('The threshold must be a whole number of at least 1.');
  }
  if (threshold > trimmed.length) {
    throw new Error(`The threshold (${threshold}) cannot exceed the number of owners (${trimmed.length}).`);
  }
  return trimmed;
}

export interface ThresholdEvaluation {
  /** Approvals that count: distinct addresses that are current owners. */
  approvals: number;
  required: number;
  met: boolean;
  remaining: number;
}

/**
 * Count a proposal's approvals the way they must count: once per current
 * owner. A repeated address counts once, and an address that is not an owner
 * (or no longer is one) does not count at all.
 */
export function evaluateThreshold(approvals: string[], owners: string[], threshold: number): ThresholdEvaluation {
  if (!Number.isInteger(threshold) || threshold < 1) {
    // A threshold of 0 would be "met" with no approvals at all.
    throw new Error('Invalid multisig threshold.');
  }
  const ownerSet = new Set(owners);
  const counted = new Set(approvals.filter((a) => ownerSet.has(a))).size;
  return {
    approvals: counted,
    required: threshold,
    met: counted >= threshold,
    remaining: Math.max(0, threshold - counted),
  };
}

// Helper to get or fund a fee payer
export async function getOrFundFeePayer(explicitSecret?: string): Promise<Keypair> {
  if (explicitSecret) {
    return Keypair.fromSecret(explicitSecret);
  }
  const stored = typeof window !== 'undefined'
    ? (walletSession.getItem('veil_signer_secret') || walletLocal.getItem('veil_signer_secret'))
    : null;
  
  if (stored) {
    return Keypair.fromSecret(stored);
  }

  // Fallback: On testnet, generate a random key and fund it via Friendbot.
  // On mainnet, Friendbot does not exist so a funded fee-payer is required.
  const net = getNetwork();
  if (net.name !== 'testnet') {
    throw new Error('No fee-payer key found. On mainnet, a funded fee-payer key is required.');
  }

  const tempKp = Keypair.random();
  console.log("Funding temporary fee payer:", tempKp.publicKey());
  const resp = await fetch(`https://friendbot.stellar.org?addr=${tempKp.publicKey()}`);
  if (!resp.ok) {
    throw new Error("Friendbot funding failed for temporary fee payer");
  }
  return tempKp;
}

// Poll transaction helper
async function waitForTx(server: SorobanRpc.Server, hash: string): Promise<SorobanRpc.Api.GetTransactionResponse> {
  for (let i = 0; i < 30; i++) {
    const result = await server.getTransaction(hash);
    if (result.status !== SorobanRpc.Api.GetTransactionStatus.NOT_FOUND) {
      return result;
    }
    await new Promise(r => setTimeout(r, 1000));
  }
  throw new Error(`Transaction ${hash} not confirmed`);
}

/** Simulate a read-only contract call and return its native value. */
async function readContract(server: SorobanRpc.Server, contract: Contract, method: string, ...args: xdr.ScVal[]): Promise<any> {
  const source = new Account(Keypair.random().publicKey(), '0');
  const tx = new TransactionBuilder(source, { fee: inclusionFee(), networkPassphrase: NETWORK_PASSPHRASE })
    .addOperation(contract.call(method, ...args))
    .setTimeout(30)
    .build();
  const sim = await server.simulateTransaction(tx);
  if (SorobanRpc.Api.isSimulationError(sim)) throw new Error(`Could not read ${method} from the multisig.`);
  return scValToNative((sim as any).result.retval);
}

/**
 * Refuse any auth entry that is not exactly `contractId.method(...)` with no
 * nested calls. The entries come back from simulation, i.e. from the RPC; an
 * entry for something else (a token transfer out of the signer, say) would be
 * signed along with it.
 */
function assertAuthIsOnly(tx: Transaction, contractId: string, method: string): xdr.SorobanAuthorizationEntry[] {
  const op = tx.operations[0] as Operation.InvokeHostFunction;
  const entries = op.auth ?? [];
  for (const entry of entries) {
    const fn = entry.rootInvocation().function();
    const isCall = fn.switch() === xdr.SorobanAuthorizedFunctionType.sorobanAuthorizedFunctionTypeContractFn();
    if (
      !isCall
      || Address.fromScAddress(fn.contractFn().contractAddress()).toString() !== contractId
      || fn.contractFn().functionName().toString() !== method
      || entry.rootInvocation().subInvocations().length > 0
    ) {
      throw new Error(`Refusing to sign: the network asked for authorisation beyond ${method}.`);
    }
  }
  return entries;
}

/**
 * Prepare, authorise, sign and submit one multisig call, and wait for it.
 *
 * `authSigner` is the owner the contract calls `require_auth()` on. When it is
 * the fee payer, the envelope signature covers it. When it is not, Soroban needs
 * a signed auth entry: an envelope signature from the owner authorises nothing,
 * so the call used to fail on chain for every owner but the fee payer.
 */
async function submitInvocation(
  server: SorobanRpc.Server,
  feePayer: Keypair,
  contractId: string,
  method: string,
  args: xdr.ScVal[],
  authSigner: Keypair,
  label: string,
): Promise<string> {
  const account = await server.getAccount(feePayer.publicKey());
  const sequence = account.sequenceNumber();
  const operation = new Contract(contractId).call(method, ...args);
  const build = (op: xdr.Operation) =>
    new TransactionBuilder(new Account(feePayer.publicKey(), sequence), { fee: inclusionFee(), networkPassphrase: NETWORK_PASSPHRASE })
      .addOperation(op)
      .setTimeout(60)
      .build();

  let prepared = await server.prepareTransaction(build(operation));
  const entries = assertAuthIsOnly(prepared, contractId, method);

  const needsEntrySignature = entries.some(
    (e) => e.credentials().switch() === xdr.SorobanCredentialsType.sorobanCredentialsAddress(),
  );
  if (needsEntrySignature) {
    const { sequence: latest } = await server.getLatestLedger();
    const signed = await Promise.all(entries.map((entry) => {
      if (entry.credentials().switch() !== xdr.SorobanCredentialsType.sorobanCredentialsAddress()) return entry;
      const who = Address.fromScAddress(entry.credentials().address().address()).toString();
      if (who !== authSigner.publicKey()) {
        throw new Error(`Refusing to sign: ${method} needs authorisation from an address this wallet does not hold.`);
      }
      return authorizeEntry(entry, authSigner, latest + 60, NETWORK_PASSPHRASE);
    }));
    const invoke = (prepared.operations[0] as Operation.InvokeHostFunction).func;
    // Re-simulate with the signed entries so the resource fee includes
    // verifying them; assembleTransaction keeps auth that is already present.
    prepared = await server.prepareTransaction(build(Operation.invokeHostFunction({ func: invoke, auth: signed })));
    assertAuthIsOnly(prepared, contractId, method);
  }

  prepared.sign(feePayer);
  const submitResult = await server.sendTransaction(prepared);
  if (submitResult.status === 'ERROR') {
    throw new Error(`${label} failed: ${JSON.stringify(submitResult.errorResult)}`);
  }

  const result = await waitForTx(server, submitResult.hash);
  if (result.status !== 'SUCCESS') {
    // A failed transaction used to return as if it had gone through.
    throw new Error(`${label} failed on-chain with status: ${result.status}`);
  }
  return submitResult.hash;
}

/** The owner key used to propose: an explicit secret, else the wallet's signer. */
function resolveOwnerKey(secret?: string): Keypair {
  const stored = typeof window !== 'undefined'
    ? (walletSession.getItem('veil_signer_secret') || walletLocal.getItem('veil_signer_secret'))
    : null;
  const resolved = secret?.trim() || stored;
  if (!resolved) {
    throw new Error('An owner key is required to propose. Unlock the wallet again.');
  }
  return Keypair.fromSecret(resolved);
}

function validateProposalId(id: number): bigint {
  if (!Number.isSafeInteger(id) || id < 1) {
    throw new Error('Invalid proposal id.');
  }
  return BigInt(id);
}

// 1. Deploy & initialize multisig
export async function deployAndInitMultisig(params: {
  owners: string[];
  threshold: number;
  feePayerSecret?: string;
}): Promise<string> {
  // Resolved before anything is funded or signed: on a network where the
  // multisig WASM is not installed this throws with the network named, rather
  // than building a transaction that can only fail at the signature (#672).
  const multisigWasmHash = getMultisigWasmHash();
  // Also before anything is paid for: the contract would refuse a bad
  // threshold only at initialize, after the deploy, leaving an uninitialised
  // contract whose initialize anyone can call.
  const owners = validateMultisigConfig(params.owners, params.threshold);

  const server = new SorobanRpc.Server(RPC_URL);
  const feePayer = await getOrFundFeePayer(params.feePayerSecret);
  const account = await server.getAccount(feePayer.publicKey());

  const salt = crypto.getRandomValues(new Uint8Array(32));
  const createOp = Operation.createCustomContract({
    // An Address, not the G... string: the SDK calls toScAddress() on it, and
    // the string made every deploy throw before anything was built.
    address: new Address(feePayer.publicKey()),
    wasmHash: Buffer.from(multisigWasmHash, 'hex'),
    salt: Buffer.from(salt),
  });

  const tx = new TransactionBuilder(account, { fee: inclusionFee(), networkPassphrase: NETWORK_PASSPHRASE })
    .addOperation(createOp)
    .setTimeout(60)
    .build();

  const prepared = await server.prepareTransaction(tx);
  prepared.sign(feePayer);
  const submitResult = await server.sendTransaction(prepared);

  if (submitResult.status === 'ERROR') {
    throw new Error(`Deploy failed: ${JSON.stringify(submitResult.errorResult)}`);
  }

  const txResp = await waitForTx(server, submitResult.hash);
  if (txResp.status !== 'SUCCESS') {
    throw new Error(`Deploy transaction failed with status: ${txResp.status}`);
  }

  const meta = txResp.resultMetaXdr as any;
  let sorobanMeta: any = null;
  const sw = meta.switch().name;
  if (sw === 'transactionMetaV3') {
    sorobanMeta = meta.v3().sorobanMeta();
  } else if (sw === 'transactionMetaV4') {
    sorobanMeta = meta.v4().sorobanMeta();
  } else {
    sorobanMeta = meta.v3()?.sorobanMeta() || meta.v4()?.sorobanMeta();
  }
  const val = sorobanMeta.returnValue();
  const contractId = StrKey.encodeContract(val.address().contractId() as any);

  console.log("Deployed Multisig contract:", contractId);

  // Now initialize it with owners, threshold, and the native token contract ID (as the token address)
  const nativeTokenAddress = Asset.native().contractId(NETWORK_PASSPHRASE);
  const multisigContract = new Contract(contractId);
  const initAccount = await server.getAccount(feePayer.publicKey());

  const ownersScVal = nativeToScVal(owners.map(addr => nativeToScVal(addr, { type: 'address' })), { type: 'vec' });

  const initTx = new TransactionBuilder(initAccount, { fee: inclusionFee(), networkPassphrase: NETWORK_PASSPHRASE })
    .addOperation(multisigContract.call(
      'initialize',
      ownersScVal,
      nativeToScVal(params.threshold, { type: 'u32' }),
      nativeToScVal(nativeTokenAddress, { type: 'address' }),
    ))
    .setTimeout(60)
    .build();

  const preparedInit = await server.prepareTransaction(initTx);
  preparedInit.sign(feePayer);
  const initSubmit = await server.sendTransaction(preparedInit);

  if (initSubmit.status === 'ERROR') {
    throw new Error(`Initialize failed: ${JSON.stringify(initSubmit.errorResult)}`);
  }

  const initResp = await waitForTx(server, initSubmit.hash);
  if (initResp.status !== 'SUCCESS') {
    throw new Error(`Initialization failed on-chain with status: ${initResp.status}`);
  }

  return contractId;
}

// 2. Fetch multisig details
export async function fetchMultisigDetails(contractId: string): Promise<MultisigDetails> {
  const server = new SorobanRpc.Server(RPC_URL);
  const contract = new Contract(contractId);

  const dummyKp = Keypair.random();
  const dummyAcct = new Account(dummyKp.publicKey(), '0');

  // Query owners
  const ownersTx = new TransactionBuilder(dummyAcct, { fee: inclusionFee(), networkPassphrase: NETWORK_PASSPHRASE })
    .addOperation(contract.call('get_owners'))
    .setTimeout(30)
    .build();
  const ownersSim = await server.simulateTransaction(ownersTx);
  if (SorobanRpc.Api.isSimulationError(ownersSim)) throw new Error("Could not simulate get_owners");
  const owners = scValToNative((ownersSim as any).result.retval) as string[];

  // Query threshold
  const thresholdTx = new TransactionBuilder(dummyAcct, { fee: inclusionFee(), networkPassphrase: NETWORK_PASSPHRASE })
    .addOperation(contract.call('get_threshold'))
    .setTimeout(30)
    .build();
  const thresholdSim = await server.simulateTransaction(thresholdTx);
  if (SorobanRpc.Api.isSimulationError(thresholdSim)) throw new Error("Could not simulate get_threshold");
  const threshold = Number(scValToNative((thresholdSim as any).result.retval));

  // Query native balance
  const nativeTokenAddress = Asset.native().contractId(NETWORK_PASSPHRASE);
  const sac = new Contract(nativeTokenAddress);
  const balanceTx = new TransactionBuilder(dummyAcct, { fee: inclusionFee(), networkPassphrase: NETWORK_PASSPHRASE })
    .addOperation(sac.call('balance', nativeToScVal(contractId, { type: 'address' })))
    .setTimeout(30)
    .build();
  const balanceSim = await server.simulateTransaction(balanceTx);
  let balanceXlm = "0.0000000";
  if (!SorobanRpc.Api.isSimulationError(balanceSim)) {
    const balanceStroops = scValToNative((balanceSim as any).result.retval) as bigint;
    balanceXlm = (Number(balanceStroops) / 10_000_000).toFixed(7);
  }

  return {
    contractId,
    owners,
    threshold,
    balanceXlm,
  };
}

// 3. Propose transaction
export async function proposeTransaction(params: {
  contractId: string;
  to: string;
  amountXlm: string;
  /** The proposing owner. Defaults to the wallet's signer. */
  proposerSecret?: string;
  feePayerSecret?: string;
}): Promise<void> {
  // Everything checkable is checked before a fee payer is funded or anything
  // is signed. The amount used to go through parseFloat, which accepted '1e3'
  // and '-5' and silently rounded an eighth decimal away.
  const amountStroops = xlmToStroops(params.amountXlm);
  const to = params.to.trim();
  try {
    Address.fromString(to);
  } catch {
    throw new Error('Enter a valid Stellar G... or C... address.');
  }
  const proposer = resolveOwnerKey(params.proposerSecret);

  const server = new SorobanRpc.Server(RPC_URL);
  const contract = new Contract(params.contractId);
  const owners = (await readContract(server, contract, 'get_owners')) as string[];
  if (!owners.includes(proposer.publicKey())) {
    throw new Error('Only an owner of this multisig can propose a payment from it.');
  }

  const feePayer = await getOrFundFeePayer(params.feePayerSecret);
  // The contract is propose_transaction(caller, to, amount) and requires the
  // caller's auth. The caller was never sent, so every proposal failed.
  await submitInvocation(
    server,
    feePayer,
    params.contractId,
    'propose_transaction',
    [
      nativeToScVal(proposer.publicKey(), { type: 'address' }),
      nativeToScVal(to, { type: 'address' }),
      nativeToScVal(amountStroops, { type: 'i128' }),
    ],
    proposer,
    'Proposal',
  );
}

// 4. Sign transaction (as owner, and optionally using fee payer)
/**
 * Approve a proposal as one owner. Returns the threshold evaluation including
 * this approval: `met` is true when this signature is the one that executes
 * the payment.
 */
export async function signTransaction(params: {
  contractId: string;
  proposalId: number;
  signerSecret: string;
  feePayerSecret?: string;
}): Promise<ThresholdEvaluation> {
  const proposalId = validateProposalId(params.proposalId);
  const signer = Keypair.fromSecret(params.signerSecret.trim());
  const server = new SorobanRpc.Server(RPC_URL);
  const contract = new Contract(params.contractId);

  const owners = (await readContract(server, contract, 'get_owners')) as string[];
  const threshold = Number(await readContract(server, contract, 'get_threshold'));
  const proposal = await readContract(server, contract, 'get_proposal', nativeToScVal(proposalId, { type: 'u64' }));
  const approvals = (proposal.approvals ?? []) as string[];

  if (!owners.includes(signer.publicKey())) {
    throw new Error('This key is not an owner of the multisig, so its signature cannot count.');
  }
  if (proposal.executed) {
    throw new Error('This proposal has already been executed.');
  }
  if (approvals.includes(signer.publicKey())) {
    // The contract would ignore it; refusing here saves the fee and says why.
    throw new Error('This owner has already approved. A second signature from the same owner does not count.');
  }

  const feePayer = await getOrFundFeePayer(params.feePayerSecret);
  await submitInvocation(
    server,
    feePayer,
    params.contractId,
    'sign_transaction',
    [
      nativeToScVal(proposalId, { type: 'u64' }),
      nativeToScVal(signer.publicKey(), { type: 'address' }),
    ],
    signer,
    'Signing',
  );

  return evaluateThreshold([...approvals, signer.publicKey()], owners, threshold);
}

// 5. Fetch all proposals on-chain
export async function getProposalsOnChain(contractId: string): Promise<ProposalDetails[]> {
  const server = new SorobanRpc.Server(RPC_URL);
  const contract = new Contract(contractId);

  const dummyKp = Keypair.random();
  const dummyAcct = new Account(dummyKp.publicKey(), '0');

  // Query proposal count
  const countTx = new TransactionBuilder(dummyAcct, { fee: inclusionFee(), networkPassphrase: NETWORK_PASSPHRASE })
    .addOperation(contract.call('get_proposal_count'))
    .setTimeout(30)
    .build();

  const sim = await server.simulateTransaction(countTx);
  if (SorobanRpc.Api.isSimulationError(sim)) return [];
  const proposalCount = Number(scValToNative((sim as any).result.retval));

  const proposals: ProposalDetails[] = [];
  for (let id = 1; id <= proposalCount; id++) {
    const propTx = new TransactionBuilder(dummyAcct, { fee: inclusionFee(), networkPassphrase: NETWORK_PASSPHRASE })
      .addOperation(contract.call('get_proposal', nativeToScVal(id, { type: 'u64' })))
      .setTimeout(30)
      .build();

    const propSim = await server.simulateTransaction(propTx);
    if (!SorobanRpc.Api.isSimulationError(propSim)) {
      const retval = (propSim as any).result.retval;
      if (retval) {
        const raw = scValToNative(retval);
        // raw structure matches rust Proposal struct: { id, to, amount, approvals, executed }
        proposals.push({
          id: Number(raw.id),
          to: raw.to,
          amount: (Number(raw.amount) / 10_000_000).toFixed(7),
          approvals: raw.approvals,
          executed: raw.executed,
        });
      }
    }
  }

  return proposals.sort((a, b) => b.id - a.id); // Newest first
}
