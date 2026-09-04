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
  Memo,
  Operation,
  StrKey,
  TransactionBuilder,
  nativeToScVal,
  rpc as SorobanRpc,
  type Transaction,
} from '@stellar/stellar-sdk';

import { getNetwork } from './network';
import { inclusionFee } from './fees';

// All endpoints follow the ACTIVE network — module-level env consts froze
// these to testnet and sent mainnet payments at testnet Horizon.
function net() {
  return getNetwork();
}
/** Native XLM SAC id — deterministic per network; env var is an override only. */
function nativeSac(): string {
  return process.env['EXPO_PUBLIC_XLM_CONTRACT_ID']?.trim() || Asset.native().contractId(net().networkPassphrase);
}

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
  memo?: string,
  asset?: { code: string; issuer: string | null },
): Promise<SendResult> {
  const errors = validateSend(recipient, amount);
  if (errors.recipient) throw new Error(errors.recipient);
  if (errors.amount) throw new Error(errors.amount);

  const to = recipient.trim();
  const memoText = memo?.trim();

  // Native XLM unless a classic (issued) asset is supplied.
  const sendAsset =
    asset && asset.code.toUpperCase() !== 'XLM' && asset.issuer
      ? new Asset(asset.code, asset.issuer)
      : Asset.native();

  if (isClassicAddress(to)) {
    const server = new Horizon.Server(net().horizonUrl);

    // A payment op can't land on an account that doesn't exist yet — first
    // funding must be a create_account op (native only, >= the base reserve).
    let destinationExists = true;
    try {
      await server.loadAccount(to);
    } catch (err) {
      const status = (err as { response?: { status?: number } })?.response?.status;
      if (status === 404 || (err instanceof Error && err.name === 'NotFoundError')) {
        destinationExists = false;
      }
      // Other errors: assume it exists and let the submit surface the truth.
    }
    if (!destinationExists && !sendAsset.isNative()) {
      throw new Error('The recipient account is brand new — it must receive XLM first before it can hold other assets.');
    }
    if (!destinationExists && Number(amount) < 1) {
      throw new Error('The recipient account is brand new — the first payment must be at least 1 XLM to activate it.');
    }

    const account = await server.loadAccount(signer.publicKey);
    const builder = new TransactionBuilder(account, {
      fee: inclusionFee(),
      networkPassphrase: net().networkPassphrase,
    })
      .addOperation(
        destinationExists
          ? Operation.payment({ destination: to, asset: sendAsset, amount: amount.trim() })
          : Operation.createAccount({ destination: to, startingBalance: amount.trim() }),
      )
      .setTimeout(30);
    // Classic memos: only attach for text that fits the 28-byte limit.
    if (memoText && new TextEncoder().encode(memoText).length <= 28) {
      builder.addMemo(Memo.text(memoText));
    }
    const tx = builder.build();
    signer.sign(tx);
    try {
      const res = await server.submitTransaction(tx);
      return { hash: res.hash };
    } catch (err) {
      // Surface Horizon's real result codes instead of a bare axios "400".
      const extras = (err as { response?: { data?: { extras?: { result_codes?: unknown } } } })?.response?.data?.extras;
      if (extras?.result_codes) {
        throw new Error(`Payment rejected: ${JSON.stringify(extras.result_codes)}`);
      }
      throw err;
    }
  }

  // Contract (C…) recipient below. Only native XLM is wired over the SAC path.
  if (!sendAsset.isNative()) {
    throw new Error(
      `Sending ${sendAsset.getCode()} to a smart-contract wallet isn't supported yet — use a classic (G…) address.`,
    );
  }

  const server = new SorobanRpc.Server(net().rpcUrl);
  const account = await server.getAccount(signer.publicKey);
  const contract = new Contract(nativeSac());
  const tx = new TransactionBuilder(account, {
    fee: inclusionFee(),
    networkPassphrase: net().networkPassphrase,
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
