/**
 * Payment send flow for the mobile wallet — the native port of the web
 * wallet's send path (`frontend/wallet/app/send/page.tsx`, `lib/sorobanTx.ts`).
 *
 * Two destinations, mirroring the web:
 *   • a classic `G…` account → a plain Horizon native payment;
 *   • anything else (a `C…` contract) → a native-SAC `transfer` invoked over
 *     Soroban RPC: simulate → assemble → sign → submit → poll for the result.
 *
 * The wallet authorizes and pays for the transfer with a signer whose secret is
 * never persisted — on this wallet it is derived from the device passkey (see
 * `lib/backup.ts`). That signer is injected here as {@link WalletSigner} so this
 * module stays pure of the native passkey integration and fully testable; the
 * one missing native piece lives behind {@link requireSigner} in `lib/signer.ts`.
 */

import {
  Asset,
  BASE_FEE,
  Contract,
  Horizon,
  Operation,
  StrKey,
  TransactionBuilder,
  nativeToScVal,
  rpc as SorobanRpc,
  type Transaction,
} from '@stellar/stellar-sdk';

const HORIZON_URL =
  process.env['EXPO_PUBLIC_HORIZON_URL']?.trim() || 'https://horizon-testnet.stellar.org';
const RPC_URL =
  process.env['EXPO_PUBLIC_SOROBAN_RPC_URL']?.trim() || 'https://soroban-testnet.stellar.org';
const NETWORK_PASSPHRASE =
  process.env['EXPO_PUBLIC_NETWORK_PASSPHRASE']?.trim() || 'Test SDF Network ; September 2015';
const NATIVE_SAC = process.env['EXPO_PUBLIC_XLM_CONTRACT_ID']?.trim() || '';

const STROOPS_PER_XLM = 10_000_000;

/** Authorizes and pays for a transfer. A passkey-derived Ed25519 key fulfils this. */
export interface WalletSigner {
  /** The `G…` address that signs the envelope and funds the fee. */
  publicKey: string;
  /** Signs a built transaction in place. */
  sign(tx: Transaction): void;
}

export interface SendValidation {
  recipient?: string;
  amount?: string;
}

export interface SendResult {
  hash: string;
}

/** True for a classic `G…` account address (vs a `C…` contract). */
export function isClassicAddress(address: string): boolean {
  return StrKey.isValidEd25519PublicKey(address);
}

/** Converts a decimal XLM string to an i128 stroop amount. */
export function toStroops(amount: string): bigint {
  return BigInt(Math.round(parseFloat(amount) * STROOPS_PER_XLM));
}

/** Validates a recipient + amount. Returns an empty object when both are valid. */
export function validateSend(recipient: string, amount: string): SendValidation {
  const errors: SendValidation = {};

  const to = recipient.trim();
  if (!StrKey.isValidEd25519PublicKey(to) && !StrKey.isValidContract(to)) {
    errors.recipient = 'Enter a valid Stellar address (G…) or contract (C…).';
  }

  const value = parseFloat(amount);
  if (isNaN(value) || value <= 0) {
    errors.amount = 'Enter an amount greater than zero.';
  }

  return errors;
}

/** Minimal surface of `rpc.Server` the poller depends on (injectable for tests). */
export interface TransactionPoller {
  getTransaction(hash: string): Promise<{ status: string }>;
}

const TX_SUCCESS = 'SUCCESS';
const TX_NOT_FOUND = 'NOT_FOUND';

/**
 * Polls `getTransaction` until the network reports a terminal status: resolves
 * with the hash on success, throws on failure, and throws on timeout. The clock
 * is injectable so tests don't wait in real time.
 */
export async function pollForResult(
  server: TransactionPoller,
  hash: string,
  opts: { tries?: number; delayMs?: number; sleep?: (ms: number) => Promise<void> } = {},
): Promise<string> {
  const tries = opts.tries ?? 30;
  const delayMs = opts.delayMs ?? 1_000;
  const sleep = opts.sleep ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)));

  for (let i = 0; i < tries; i++) {
    const result = await server.getTransaction(hash);
    if (result.status !== TX_NOT_FOUND) {
      if (result.status !== TX_SUCCESS) throw new Error(`Transaction failed: ${result.status}`);
      return hash;
    }
    await sleep(delayMs);
  }
  throw new Error('Transaction timed out — check status manually.');
}

/**
 * Builds, signs, submits, and confirms a native XLM payment from `signer` to
 * `recipient`. Classic recipients go through Horizon; contract recipients go
 * through the native SAC over Soroban RPC and are polled to completion.
 */
export async function sendPayment(
  recipient: string,
  amount: string,
  signer: WalletSigner,
): Promise<SendResult> {
  const errors = validateSend(recipient, amount);
  if (errors.recipient) throw new Error(errors.recipient);
  if (errors.amount) throw new Error(errors.amount);

  const to = recipient.trim();

  if (isClassicAddress(to)) {
    const server = new Horizon.Server(HORIZON_URL);
    const account = await server.loadAccount(signer.publicKey);
    const tx = new TransactionBuilder(account, {
      fee: BASE_FEE,
      networkPassphrase: NETWORK_PASSPHRASE,
    })
      .addOperation(Operation.payment({ destination: to, asset: Asset.native(), amount: amount.trim() }))
      .setTimeout(30)
      .build();
    signer.sign(tx);
    const res = await server.submitTransaction(tx);
    return { hash: res.hash };
  }

  if (!NATIVE_SAC) {
    throw new Error('Native asset contract id is not configured (EXPO_PUBLIC_XLM_CONTRACT_ID).');
  }

  const server = new SorobanRpc.Server(RPC_URL);
  const account = await server.getAccount(signer.publicKey);
  const contract = new Contract(NATIVE_SAC);
  const tx = new TransactionBuilder(account, {
    fee: BASE_FEE,
    networkPassphrase: NETWORK_PASSPHRASE,
  })
    .addOperation(
      contract.call(
        'transfer',
        nativeToScVal(signer.publicKey, { type: 'address' }),
        nativeToScVal(to, { type: 'address' }),
        nativeToScVal(toStroops(amount), { type: 'i128' }),
      ),
    )
    .setTimeout(30)
    .build();

  const sim = await server.simulateTransaction(tx);
  if (SorobanRpc.Api.isSimulationError(sim)) {
    throw new Error(`Simulation failed: ${sim.error}`);
  }
  const assembled = SorobanRpc.assembleTransaction(tx, sim).build();
  signer.sign(assembled);

  const sendResult = await server.sendTransaction(assembled);
  if (sendResult.status === 'ERROR') {
    throw new Error(`Transaction rejected: ${sendResult.errorResult?.toXDR('base64') ?? 'unknown'}`);
  }

  return { hash: await pollForResult(server, sendResult.hash) };
}
