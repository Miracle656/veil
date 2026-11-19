/**
 * Harness for the local-network end-to-end test: talk to a Stellar network,
 * deploy the real wallet contract, and invoke it.
 *
 * Everything here is configured by environment so the same code runs against
 * the standalone network CI starts (the defaults) and, for a developer without
 * Docker, any other network with a friendbot.
 */
import { readFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import path from 'node:path';
import {
  Address,
  Asset,
  BASE_FEE,
  Contract,
  Keypair,
  Operation,
  TransactionBuilder,
  hash,
  nativeToScVal,
  rpc,
  scValToNative,
  xdr,
  type Transaction,
} from '@stellar/stellar-sdk';

export const config = {
  rpcUrl: process.env.E2E_RPC_URL ?? 'http://localhost:8000/rpc',
  friendbotUrl: process.env.E2E_FRIENDBOT_URL ?? 'http://localhost:8000/friendbot',
  networkPassphrase: process.env.E2E_NETWORK_PASSPHRASE ?? 'Standalone Network ; February 2017',
  walletWasm:
    process.env.E2E_WALLET_WASM ??
    path.resolve(__dirname, '../../contracts/target/wasm32-unknown-unknown/release/invisible_wallet.wasm'),
};

export const server = new rpc.Server(config.rpcUrl, { allowHttp: true });

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** Retry `fn` until it succeeds or `timeoutMs` passes; the last error is the one thrown. */
async function until<T>(what: string, timeoutMs: number, fn: () => Promise<T>): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      return await fn();
    } catch (err) {
      if (Date.now() > deadline) {
        throw new Error(`Timed out waiting for ${what}: ${err instanceof Error ? err.message : String(err)}`);
      }
      await sleep(2_000);
    }
  }
}

/** Block until the RPC reports healthy. A quickstart container takes a while to get there. */
export async function waitForNetwork(timeoutMs = 240_000): Promise<void> {
  await until(`RPC at ${config.rpcUrl}`, timeoutMs, async () => {
    const health = await server.getHealth();
    if (health.status !== 'healthy') throw new Error(`status is ${health.status}`);
  });
}

/** Create and fund an account with friendbot, and wait until the RPC can see it. */
export async function fundedAccount(): Promise<Keypair> {
  const keypair = Keypair.random();
  await until('friendbot to fund an account', 120_000, async () => {
    const res = await fetch(`${config.friendbotUrl}?addr=${encodeURIComponent(keypair.publicKey())}`);
    if (!res.ok) throw new Error(`friendbot answered HTTP ${res.status}`);
  });
  await until('the funded account to appear', 60_000, () => server.getAccount(keypair.publicKey()));
  return keypair;
}

/**
 * Simulate and assemble a transaction, like `server.prepareTransaction`, but
 * keep what that throws away: when `__check_auth` fails, the top-level error is
 * a generic `Error(Auth, InvalidAction)` and the contract's own error code
 * (`Error(Contract, #2)`) is only in the diagnostic events.
 */
export async function prepare(tx: Transaction): Promise<Transaction> {
  const sim = await server.simulateTransaction(tx);
  if (rpc.Api.isSimulationError(sim)) {
    throw new Error(`${sim.error}\n${contractErrorsIn(sim.events).join('\n')}`);
  }
  return rpc.assembleTransaction(tx, sim).build();
}

/** Every `Error(Contract, #n)` carried by a set of diagnostic events. */
function contractErrorsIn(events: xdr.DiagnosticEvent[]): string[] {
  const found = new Set<string>();
  const visit = (value: xdr.ScVal) => {
    if (value.switch().name !== 'scvError') return;
    const err = value.error();
    if (err.switch().name === 'sceContract') found.add(`Error(Contract, #${err.contractCode()})`);
  };
  for (const diagnostic of events) {
    const body = diagnostic.event().body().v0();
    body.topics().forEach(visit);
    visit(body.data());
  }
  return [...found];
}

/** Simulate, sign, submit and wait for a single operation sourced from `signer`. */
export async function submit(signer: Keypair, operation: xdr.Operation): Promise<rpc.Api.GetSuccessfulTransactionResponse> {
  const account = await server.getAccount(signer.publicKey());
  const tx = new TransactionBuilder(account, { fee: BASE_FEE, networkPassphrase: config.networkPassphrase })
    .addOperation(operation)
    .setTimeout(120)
    .build();
  const prepared = await prepare(tx);
  prepared.sign(signer);
  return send(prepared);
}

/** Submit an already-prepared, already-signed transaction and require it to succeed. */
export async function send(tx: Transaction): Promise<rpc.Api.GetSuccessfulTransactionResponse> {
  const sent = await server.sendTransaction(tx);
  if (sent.status !== 'PENDING') {
    throw new Error(`Transaction was not accepted: ${sent.status} ${sent.errorResult?.toXDR('base64') ?? ''}`);
  }
  const result = await server.pollTransaction(sent.hash, { attempts: 60 });
  if (result.status !== rpc.Api.GetTransactionStatus.SUCCESS) {
    throw new Error(`Transaction ${sent.hash} ended as ${result.status}`);
  }
  return result;
}

/** Call a read-only contract function by simulating it. */
export async function read(contractId: string, method: string, ...args: xdr.ScVal[]): Promise<unknown> {
  // Any funded account will do as a source; the sequence number is never used.
  const source = await readerAccount();
  const tx = new TransactionBuilder(source, { fee: BASE_FEE, networkPassphrase: config.networkPassphrase })
    .addOperation(new Contract(contractId).call(method, ...args))
    .setTimeout(60)
    .build();
  const sim = await server.simulateTransaction(tx);
  if (!rpc.Api.isSimulationSuccess(sim) || !sim.result) {
    throw new Error(`Reading ${method} failed: ${'error' in sim ? sim.error : 'no result'}`);
  }
  return scValToNative(sim.result.retval);
}

let reader: Keypair | undefined;
async function readerAccount() {
  reader ??= await fundedAccount();
  return server.getAccount(reader.publicKey());
}

/** Upload the wallet wasm, instantiate it, and register `publicKey` as its only signer. */
export async function deployWallet(
  deployer: Keypair,
  publicKey: Uint8Array,
  rpId: string,
  origin: string,
): Promise<string> {
  const wasm = readFileSync(config.walletWasm);

  await submit(deployer, Operation.uploadContractWasm({ wasm }));

  const created = await submit(
    deployer,
    Operation.createCustomContract({
      address: new Address(deployer.publicKey()),
      wasmHash: hash(wasm),
      salt: randomBytes(32),
    }),
  );
  const walletId = Address.fromScVal(created.returnValue!).toString();

  await submit(
    deployer,
    new Contract(walletId).call(
      'init',
      nativeToScVal(Buffer.from(publicKey), { type: 'bytes' }),
      nativeToScVal(Buffer.from(rpId), { type: 'bytes' }),
      nativeToScVal(Buffer.from(origin), { type: 'bytes' }),
    ),
  );
  return walletId;
}

/** The native asset's contract, which the wallet will spend from. */
export const nativeAssetId = () => Asset.native().contractId(config.networkPassphrase);

/** Move `stroops` of the native asset from `from` to `to`, sourced and signed by `from`. */
export async function transferNative(from: Keypair, to: string, stroops: bigint): Promise<void> {
  await submit(
    from,
    new Contract(nativeAssetId()).call(
      'transfer',
      new Address(from.publicKey()).toScVal(),
      new Address(to).toScVal(),
      nativeToScVal(stroops, { type: 'i128' }),
    ),
  );
}

export const nativeBalance = async (holder: string): Promise<bigint> =>
  BigInt((await read(nativeAssetId(), 'balance', new Address(holder).toScVal())) as bigint);

export const walletNonce = async (walletId: string): Promise<bigint> =>
  BigInt((await read(walletId, 'get_nonce')) as bigint);
