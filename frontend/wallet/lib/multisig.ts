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
  Operation
} from '@stellar/stellar-sdk';
import { getNetwork } from './network';

const network = getNetwork();
const RPC_URL = network.rpcUrl;
const NETWORK_PASSPHRASE = network.networkPassphrase;
const MULTISIG_WASM_HASH = '7eb63568a7a41c19f5d85c55b5ec88c6f95ef840bcf98d1797850ace2dd3cf24';

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

// Helper to get or fund a fee payer
export async function getOrFundFeePayer(explicitSecret?: string): Promise<Keypair> {
  if (explicitSecret) {
    return Keypair.fromSecret(explicitSecret);
  }
  const stored = typeof window !== 'undefined'
    ? (sessionStorage.getItem('veil_signer_secret') || localStorage.getItem('veil_signer_secret'))
    : null;
  
  if (stored) {
    return Keypair.fromSecret(stored);
  }

  // Fallback: Generate a random key and fund it via Friendbot
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

// 1. Deploy & initialize multisig
export async function deployAndInitMultisig(params: {
  owners: string[];
  threshold: number;
  feePayerSecret?: string;
}): Promise<string> {
  const server = new SorobanRpc.Server(RPC_URL);
  const feePayer = await getOrFundFeePayer(params.feePayerSecret);
  const account = await server.getAccount(feePayer.publicKey());

  const salt = crypto.getRandomValues(new Uint8Array(32));
  const createOp = Operation.createCustomContract({
    address: feePayer.publicKey() as any,
    wasmHash: Buffer.from(MULTISIG_WASM_HASH, 'hex'),
    salt: Buffer.from(salt),
  });

  const tx = new TransactionBuilder(account, { fee: BASE_FEE, networkPassphrase: NETWORK_PASSPHRASE })
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

  const ownersScVal = nativeToScVal(params.owners.map(addr => nativeToScVal(addr, { type: 'address' })), { type: 'vec' });

  const initTx = new TransactionBuilder(initAccount, { fee: BASE_FEE, networkPassphrase: NETWORK_PASSPHRASE })
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
  const ownersTx = new TransactionBuilder(dummyAcct, { fee: BASE_FEE, networkPassphrase: NETWORK_PASSPHRASE })
    .addOperation(contract.call('get_owners'))
    .setTimeout(30)
    .build();
  const ownersSim = await server.simulateTransaction(ownersTx);
  if (SorobanRpc.Api.isSimulationError(ownersSim)) throw new Error("Could not simulate get_owners");
  const owners = scValToNative((ownersSim as any).result.retval) as string[];

  // Query threshold
  const thresholdTx = new TransactionBuilder(dummyAcct, { fee: BASE_FEE, networkPassphrase: NETWORK_PASSPHRASE })
    .addOperation(contract.call('get_threshold'))
    .setTimeout(30)
    .build();
  const thresholdSim = await server.simulateTransaction(thresholdTx);
  if (SorobanRpc.Api.isSimulationError(thresholdSim)) throw new Error("Could not simulate get_threshold");
  const threshold = Number(scValToNative((thresholdSim as any).result.retval));

  // Query native balance
  const nativeTokenAddress = Asset.native().contractId(NETWORK_PASSPHRASE);
  const sac = new Contract(nativeTokenAddress);
  const balanceTx = new TransactionBuilder(dummyAcct, { fee: BASE_FEE, networkPassphrase: NETWORK_PASSPHRASE })
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
  feePayerSecret?: string;
}): Promise<void> {
  const server = new SorobanRpc.Server(RPC_URL);
  const feePayer = await getOrFundFeePayer(params.feePayerSecret);
  const account = await server.getAccount(feePayer.publicKey());
  const contract = new Contract(params.contractId);

  const amountStroops = BigInt(Math.round(parseFloat(params.amountXlm) * 10_000_000));

  const tx = new TransactionBuilder(account, { fee: BASE_FEE, networkPassphrase: NETWORK_PASSPHRASE })
    .addOperation(contract.call(
      'propose_transaction',
      nativeToScVal(params.to, { type: 'address' }),
      nativeToScVal(amountStroops, { type: 'i128' }),
    ))
    .setTimeout(60)
    .build();

  const prepared = await server.prepareTransaction(tx);
  prepared.sign(feePayer);
  const submitResult = await server.sendTransaction(prepared);

  if (submitResult.status === 'ERROR') {
    throw new Error(`Proposal failed: ${JSON.stringify(submitResult.errorResult)}`);
  }

  await waitForTx(server, submitResult.hash);
}

// 4. Sign transaction (as owner, and optionally using fee payer)
export async function signTransaction(params: {
  contractId: string;
  proposalId: number;
  signerSecret: string;
  feePayerSecret?: string;
}): Promise<void> {
  const server = new SorobanRpc.Server(RPC_URL);
  const signer = Keypair.fromSecret(params.signerSecret);
  const feePayer = await getOrFundFeePayer(params.feePayerSecret);
  const account = await server.getAccount(feePayer.publicKey());
  const contract = new Contract(params.contractId);

  const tx = new TransactionBuilder(account, { fee: BASE_FEE, networkPassphrase: NETWORK_PASSPHRASE })
    .addOperation(contract.call(
      'sign_transaction',
      nativeToScVal(params.proposalId, { type: 'u64' }),
      nativeToScVal(signer.publicKey(), { type: 'address' }),
    ))
    .setTimeout(60)
    .build();

  const prepared = await server.prepareTransaction(tx);
  prepared.sign(feePayer);
  if (signer.publicKey() !== feePayer.publicKey()) {
    prepared.sign(signer);
  }

  const submitResult = await server.sendTransaction(prepared);
  if (submitResult.status === 'ERROR') {
    throw new Error(`Signing failed: ${JSON.stringify(submitResult.errorResult)}`);
  }

  await waitForTx(server, submitResult.hash);
}

// 5. Fetch all proposals on-chain
export async function getProposalsOnChain(contractId: string): Promise<ProposalDetails[]> {
  const server = new SorobanRpc.Server(RPC_URL);
  const contract = new Contract(contractId);

  const dummyKp = Keypair.random();
  const dummyAcct = new Account(dummyKp.publicKey(), '0');

  // Query proposal count
  const countTx = new TransactionBuilder(dummyAcct, { fee: BASE_FEE, networkPassphrase: NETWORK_PASSPHRASE })
    .addOperation(contract.call('get_proposal_count'))
    .setTimeout(30)
    .build();

  const sim = await server.simulateTransaction(countTx);
  if (SorobanRpc.Api.isSimulationError(sim)) return [];
  const proposalCount = Number(scValToNative((sim as any).result.retval));

  const proposals: ProposalDetails[] = [];
  for (let id = 1; id <= proposalCount; id++) {
    const propTx = new TransactionBuilder(dummyAcct, { fee: BASE_FEE, networkPassphrase: NETWORK_PASSPHRASE })
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
