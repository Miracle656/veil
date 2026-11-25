/** @jest-environment @stryker-mutator/jest-runner/jest-env/node */
/**
 * The SDK signs through a TransactionSigner callback so no secret key has to
 * live in a client bundle. These tests use the real Stellar SDK (no network):
 * the "application" side of each test plays the backend that owns the key.
 */
import {
  Account,
  Asset,
  BASE_FEE,
  Keypair,
  Networks,
  Operation,
  TransactionBuilder,
  type Transaction,
} from '@stellar/stellar-sdk';
import { signForSubmission } from '../core';
import { createKeypairSigner, _resetSignerDeprecationWarnings, type TransactionSigner } from '../signer';

const PASSPHRASE = Networks.TESTNET;
const config = (extra: object = {}) =>
  ({ factoryAddress: 'C', rpcUrl: 'http://x', networkPassphrase: PASSPHRASE, ...extra }) as any;

function buildTx(source: string, amount = '1'): Transaction {
  return new TransactionBuilder(new Account(source, '0'), { fee: BASE_FEE, networkPassphrase: PASSPHRASE })
    .addOperation(Operation.payment({ destination: Keypair.random().publicKey(), asset: Asset.native(), amount }))
    .setTimeout(30)
    .build();
}

/** A backend signer that holds the key; the SDK only ever sees this object. */
function backendSigner(kp: Keypair, onCall?: (xdr: string, passphrase: string) => void): TransactionSigner {
  return {
    publicKey: kp.publicKey(),
    signTransaction: async (xdr, { networkPassphrase }) => {
      onCall?.(xdr, networkPassphrase);
      const tx = TransactionBuilder.fromXDR(xdr, networkPassphrase);
      tx.sign(kp);
      return tx.toXDR();
    },
  };
}

describe('TransactionSigner callback path', () => {
  beforeEach(() => {
    _resetSignerDeprecationWarnings();
  });

  it('hands the signer the XDR and network, and returns a validly signed transaction', async () => {
    const kp = Keypair.random();
    const seen: Array<[string, string]> = [];
    const tx = buildTx(kp.publicKey());
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});

    const signed = (await signForSubmission(tx, backendSigner(kp, (x, p) => seen.push([x, p])), config())) as Transaction;

    expect(seen).toEqual([[tx.toXDR(), PASSPHRASE]]);
    expect(signed.signatures).toHaveLength(1);
    expect(kp.verify(signed.hash(), signed.signatures[0].signature())).toBe(true);
    expect(warn).not.toHaveBeenCalled(); // the callback path is not deprecated
    warn.mockRestore();
  });

  it('a signer that refuses makes the operation fail and nothing is signed', async () => {
    const kp = Keypair.random();
    const refusing: TransactionSigner = {
      publicKey: kp.publicKey(),
      signTransaction: async () => {
        throw new Error('policy: amount too large');
      },
    };
    await expect(signForSubmission(buildTx(kp.publicKey()), refusing, config())).rejects.toThrow('policy: amount too large');
  });

  it('rejects a signer that returns a different transaction', async () => {
    const kp = Keypair.random();
    const other = buildTx(kp.publicKey(), '999');
    other.sign(kp);
    const swapping: TransactionSigner = { publicKey: kp.publicKey(), signTransaction: async () => other.toXDR() };
    await expect(signForSubmission(buildTx(kp.publicKey(), '1'), swapping, config())).rejects.toThrow(/different transaction/);
  });

  it('rejects an unsigned echo and garbage from the signer', async () => {
    const kp = Keypair.random();
    const echo: TransactionSigner = { publicKey: kp.publicKey(), signTransaction: async (x) => x };
    await expect(signForSubmission(buildTx(kp.publicKey()), echo, config())).rejects.toThrow(/without adding a signature/);
    const garbage: TransactionSigner = { publicKey: kp.publicKey(), signTransaction: async () => 'not xdr' };
    await expect(signForSubmission(buildTx(kp.publicKey()), garbage, config())).rejects.toThrow(/not a transaction envelope/);
  });

  it('wraps in a fee bump signed by a sponsorSigner callback', async () => {
    const kp = Keypair.random();
    const sponsor = Keypair.random();
    const out = await signForSubmission(
      buildTx(kp.publicKey()),
      backendSigner(kp),
      config({ sponsorSigner: backendSigner(sponsor) }),
    );
    expect(out.toXDR()).toBeTruthy();
    expect((out as any).feeSource).toBe(sponsor.publicKey());
    expect(sponsor.verify(out.hash(), out.signatures[0].signature())).toBe(true);
  });
});

  it('createKeypairSigner wraps a Keypair in a valid TransactionSigner', async () => {
    const kp = Keypair.random();
    const signer = createKeypairSigner(kp);
    expect(signer.publicKey).toBe(kp.publicKey());
    const tx = buildTx(kp.publicKey());
    const signed = (await signForSubmission(tx, signer, config())) as Transaction;
    expect(signed.signatures).toHaveLength(1);
    expect(kp.verify(signed.hash(), signed.signatures[0].signature())).toBe(true);
  });
});

describe('retired Keypair / secret inputs', () => {
  it('rejects raw Keypair and secret strings with a descriptive error', async () => {
    const kp = Keypair.random();
    const tx = buildTx(kp.publicKey());

    await expect(signForSubmission(tx, kp as any, config())).rejects.toThrow(
      /Expected a TransactionSigner/,
    );
    await expect(signForSubmission(tx, kp.secret() as any, config())).rejects.toThrow(
      /Expected a TransactionSigner/,
    );
  });
});
