/**
 * Add a second passkey to the wallet — another phone, a tablet, a security key —
 * without touching the one this device is bound to.
 *
 * This is NOT the SDK's register(). register() writes the wallet address, the
 * credential id and the public key, which is the primary binding everything on
 * the device derives from; calling it here would repoint the device at a new,
 * empty wallet and a different fee payer. This flow:
 *
 *   1. creates a new credential under a fresh WebAuthn user handle, excluding
 *      every credential the wallet already knows (lib/passkey createSignerPasskey);
 *   2. records it as PENDING in its own store (lib/additionalSigners), before
 *      anything is submitted, so a key that may have landed is never lost;
 *   3. submits `add_signer(new_key)`, authorised by the PRIMARY passkey through
 *      the same ceremony every spend uses (signXdrPayload: five-element
 *      signature vector with the wallet nonce) and paid by the existing fee
 *      payer;
 *   4. reads the wallet's on-chain signer list and marks the key ACTIVE only
 *      when it is there.
 *
 * It imports no walletStore setter. A failure before the network accepts the
 * transaction forgets the pending record; a failure after leaves it pending so
 * {@link finishPendingSigner} can settle it against the chain.
 *
 * The wallet contract stores ONE WebAuthn origin (set when it was deployed), so
 * the new passkey signs only from the Veil app on the same platform as this
 * wallet — see lib/relyingParty.ts.
 */

import { Contract, TransactionBuilder, nativeToScVal, rpc as SorobanRpc } from '@stellar/stellar-sdk';
import { Buffer } from 'buffer';

import { getFeePayerAddress } from './activity';
import {
  forgetPendingSigner,
  listAdditionalSigners,
  recordAdditionalSigner,
  type AdditionalSigner,
} from './additionalSigners';
import { isWalletDeployed } from './contractSpend';
import { inclusionFee } from './fees';
import { getNetwork } from './network';
import { rejectionFromResult } from './networkErrors';
import { createSignerPasskey, registerPasskeySigner } from './passkey';
import { pollForResult } from './sendPayment';
import { readSigners } from './signers';
import { signXdrPayload } from './walletConnect';
import { getPasskeyId, getPasskeyPublicKey, getSignerSecret, getWalletAddress } from './walletStore';

export type AddSignerOutcome = {
  /** The wallet — the same address it was before. */
  walletAddress: string;
  signer: AdditionalSigner;
  /** Transaction hash, when this call submitted one. */
  hash?: string;
};

type PrimaryBinding = {
  address: string | null;
  credentialId: string | null;
  publicKey: string | null;
  feePayerSecret: string | null;
};

async function readPrimary(): Promise<PrimaryBinding> {
  const [address, credentialId, publicKey, feePayerSecret] = await Promise.all([
    getWalletAddress(),
    getPasskeyId(),
    getPasskeyPublicKey(),
    getSignerSecret(),
  ]);
  return { address, credentialId, publicKey, feePayerSecret };
}

/** Behind the storage guard, a cheap end-to-end check: the binding reads back identical. */
async function assertPrimaryUnchanged(before: PrimaryBinding): Promise<void> {
  const after = await readPrimary();
  if (
    after.address !== before.address ||
    after.credentialId !== before.credentialId ||
    after.publicKey !== before.publicKey ||
    after.feePayerSecret !== before.feePayerSecret
  ) {
    throw new Error('This device’s wallet binding changed while adding a passkey. Stop and check the wallet before spending.');
  }
}

/** Preconditions shared by both entry points; returns the binding to compare against. */
async function requireAddableWallet(): Promise<PrimaryBinding & { address: string }> {
  const primary = await readPrimary();
  if (!primary.address) throw new Error('No wallet on this device yet.');
  if (!primary.credentialId || !primary.publicKey) {
    throw new Error('This wallet has no passkey on this device, so it cannot approve a new one.');
  }
  if (!primary.feePayerSecret) throw new Error('No fee-payer key on this device.');
  // add_signer is a call the contract answers; a counterfactual wallet has no
  // contract to answer it yet.
  if (!(await isWalletDeployed(primary.address))) {
    throw new Error('This wallet is created on chain by its first payment. Make one payment, then add a passkey.');
  }
  return { ...primary, address: primary.address };
}

/**
 * Submit `add_signer(publicKey)` on the wallet, authorised by the primary passkey.
 * `onSubmitted` fires once the network has accepted the transaction.
 */
async function submitAddSigner(walletAddress: string, publicKey: Uint8Array, onSubmitted: () => void): Promise<string> {
  const network = getNetwork();
  const server = new SorobanRpc.Server(network.rpcUrl);
  const feePayer = await getFeePayerAddress();
  if (!feePayer) throw new Error('No fee-payer key on this device.');

  const unsigned = new TransactionBuilder(await server.getAccount(feePayer), {
    fee: inclusionFee(),
    networkPassphrase: network.networkPassphrase,
  })
    .addOperation(new Contract(walletAddress).call('add_signer', nativeToScVal(Buffer.from(publicKey), { type: 'bytes' })))
    .setTimeout(60)
    .build();

  const unregister = registerPasskeySigner();
  try {
    const signedXdr = await signXdrPayload(unsigned.toXDR());
    const signed = TransactionBuilder.fromXDR(signedXdr, network.networkPassphrase);
    const sent = await server.sendTransaction(signed);
    if (sent.status === 'ERROR') throw new Error(rejectionFromResult(sent.errorResult));
    onSubmitted();
    return await pollForResult(server, sent.hash);
  } finally {
    unregister();
  }
}

/** The wallet's on-chain signer public keys, lowercased hex. */
async function onChainSignerKeys(walletAddress: string): Promise<string[]> {
  return (await readSigners(walletAddress)).map((s) => s.publicKey.toLowerCase());
}

/**
 * Refuse to report success if adding a signer *removed* one.
 *
 * `assertPrimaryUnchanged` compares this device's stored binding, which is a
 * local read — it cannot see the contract's signer map at all. This is the
 * on-chain half.
 *
 * It exists because of a defect in already-deployed wallets. `add_signer` used
 * to allocate its index as `next_index = len()`, so after a middle
 * `remove_signer` the next add wrote over a live slot and silently replaced
 * another key. #1176 fixed that in the contract source on 2026-10-22 (#1233) by
 * allocating from a monotonic counter — but wallets are not upgradeable, so
 * every wallet deployed before that still has the old code and always will.
 *
 * Neither app exposes `remove_signer` today, so reaching the sparse-index state
 * takes a deliberate SDK call; this is cheap insurance rather than a likely
 * path. The cost of missing it is a passkey that silently stops being a signer
 * while the screen says the new one was added.
 */
export class SignerLostError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SignerLostError';
  }
}

function assertNoSignerLost(before: readonly string[], after: readonly string[]): void {
  const survived = new Set(after);
  const lost = before.filter((key) => !survived.has(key));
  if (lost.length === 0) return;
  throw new SignerLostError(
    'Adding this passkey removed an existing signer from the wallet, which means this wallet ' +
      'predates the fix for that contract bug. Do not rely on the passkey that disappeared — ' +
      'check Settings → Passkeys against the chain before spending.',
  );
}

/**
 * Settling is best effort: the signer is already added, so a flaky RPC read
 * must not be reported as a failed add. A lost signer is the one exception —
 * that is a correctness warning the user has to see.
 */
function rethrowIfSignerLost(fallback: AdditionalSigner) {
  return (error: unknown): AdditionalSigner => {
    if (error instanceof SignerLostError) throw error;
    return fallback;
  };
}

/** Mark `signer` active if the chain lists its key; otherwise return it unchanged. */
async function settleAgainstChain(
  walletAddress: string,
  signer: AdditionalSigner,
  keysBefore?: readonly string[],
): Promise<AdditionalSigner> {
  const onChain = await readSigners(walletAddress);
  if (keysBefore) {
    assertNoSignerLost(keysBefore, onChain.map((s) => s.publicKey.toLowerCase()));
  }
  const match = onChain.find((s) => s.publicKey.toLowerCase() === signer.publicKey);
  if (!match) return signer;
  const active: AdditionalSigner = { ...signer, status: 'active', signerIndex: match.index };
  await recordAdditionalSigner(active);
  return active;
}

/** Create a new passkey and add it to this wallet as an extra signer. */
export async function addPasskeySigner(): Promise<AddSignerOutcome> {
  const primary = await requireAddableWallet();
  const known = await listAdditionalSigners();

  const created = await createSignerPasskey([
    { id: primary.credentialId! },
    ...known.map((s) => ({ id: s.credentialId, transports: s.transports })),
  ]);

  const pending: AdditionalSigner = {
    credentialId: created.credentialId,
    publicKey: Buffer.from(created.publicKey).toString('hex'),
    status: 'pending',
    ...(created.transports?.length ? { transports: created.transports } : {}),
    addedAt: new Date().toISOString(),
  };
  await recordAdditionalSigner(pending);

  // Snapshot the signer set before the write so the settle below can tell an
  // addition from a replacement. A failure to read it must not block adding a
  // passkey, so an unreachable chain simply means no comparison is made.
  const keysBefore = await onChainSignerKeys(primary.address).catch(() => undefined);

  let submitted = false;
  let hash: string;
  try {
    hash = await submitAddSigner(primary.address, created.publicKey, () => {
      submitted = true;
    });
  } catch (error) {
    // Never reached the network, so it definitely did not happen: keeping the
    // record would describe a key that is not a signer.
    if (!submitted) await forgetPendingSigner(created.credentialId).catch(() => undefined);
    throw error;
  }

  await assertPrimaryUnchanged(primary);
  const signer = await settleAgainstChain(primary.address, pending, keysBefore).catch(rethrowIfSignerLost(pending));
  return { walletAddress: primary.address, signer, hash };
}

/**
 * Settle a pending signer: if the chain already lists its key, mark it active;
 * otherwise submit add_signer for it again. Never a duplicate — the contract
 * refuses a key it already holds (SignerAlreadyExists), and the chain is read
 * first.
 */
export async function finishPendingSigner(credentialId: string): Promise<AddSignerOutcome> {
  const primary = await requireAddableWallet();
  const pending = (await listAdditionalSigners()).find((s) => s.credentialId === credentialId);
  if (!pending) throw new Error('That passkey is no longer saved on this device.');

  const settled = await settleAgainstChain(primary.address, pending);
  if (settled.status === 'active') return { walletAddress: primary.address, signer: settled };

  const keysBefore = await onChainSignerKeys(primary.address).catch(() => undefined);
  const hash = await submitAddSigner(primary.address, Buffer.from(pending.publicKey, 'hex'), () => undefined);
  await assertPrimaryUnchanged(primary);
  const signer = await settleAgainstChain(primary.address, pending, keysBefore).catch(rethrowIfSignerLost(pending));
  return { walletAddress: primary.address, signer, hash };
}
