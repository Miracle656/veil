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
  xdr,
  type Transaction,
} from '@stellar/stellar-sdk';
import { signForSubmission } from '../core';
import { _resetSignerDeprecationWarnings, resolveSigner, signWith, type TransactionSigner } from '../signer';

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

  it('rejects a signature from a different key', async () => {
    const kp = Keypair.random();
    const other = Keypair.random();
    const tx = buildTx(kp.publicKey());
    const returned = TransactionBuilder.fromXDR(tx.toXDR(), PASSPHRASE) as Transaction;
    returned.sign(other);
    const signer: TransactionSigner = { publicKey: kp.publicKey(), signTransaction: async () => returned.toXDR() };
    await expect(signWith(tx, resolveSigner(signer), PASSPHRASE)).rejects.toThrow(/valid signature for its public key/);
  });

  it('rejects an arbitrary decorated signature', async () => {
    const kp = Keypair.random();
    const tx = buildTx(kp.publicKey());
    const returned = TransactionBuilder.fromXDR(tx.toXDR(), PASSPHRASE) as Transaction;
    returned.addDecoratedSignature(new xdr.DecoratedSignature({
      hint: Buffer.alloc(4),
      signature: Buffer.alloc(64),
    }));
    const signer: TransactionSigner = { publicKey: kp.publicKey(), signTransaction: async () => returned.toXDR() };
    await expect(signWith(tx, resolveSigner(signer), PASSPHRASE)).rejects.toThrow(/valid signature/);
  });

  it('rejects a valid signature with the wrong hint and mixed invalid additions', async () => {
    const kp = Keypair.random();
    const tx = buildTx(kp.publicKey());
    const wrongHint = TransactionBuilder.fromXDR(tx.toXDR(), PASSPHRASE) as Transaction;
    wrongHint.sign(kp);
    wrongHint.signatures.splice(0, wrongHint.signatures.length, new xdr.DecoratedSignature({
      hint: Buffer.alloc(4),
      signature: wrongHint.signatures[0].signature(),
    }));
    const wrongHintSigner: TransactionSigner = {
      publicKey: kp.publicKey(),
      signTransaction: async () => wrongHint.toXDR(),
    };
    await expect(signWith(tx, resolveSigner(wrongHintSigner), PASSPHRASE)).rejects.toThrow(/valid signature/);

    const mixed = TransactionBuilder.fromXDR(tx.toXDR(), PASSPHRASE) as Transaction;
    mixed.sign(kp);
    mixed.addDecoratedSignature(new xdr.DecoratedSignature({
      hint: Buffer.alloc(4),
      signature: Buffer.alloc(64),
    }));
    const mixedSigner: TransactionSigner = { publicKey: kp.publicKey(), signTransaction: async () => mixed.toXDR() };
    await expect(signWith(tx, resolveSigner(mixedSigner), PASSPHRASE)).rejects.toThrow(/valid signature/);
  });

  it('rejects a signer that changes an existing signature', async () => {
    const kp = Keypair.random();
    const tx = buildTx(kp.publicKey());
    tx.sign(kp);
    const signer: TransactionSigner = {
      publicKey: kp.publicKey(),
      signTransaction: async (xdrEnvelope) => {
        const changed = TransactionBuilder.fromXDR(xdrEnvelope, PASSPHRASE) as Transaction;
        changed.signatures.splice(0, changed.signatures.length, new xdr.DecoratedSignature({
          hint: Buffer.alloc(4),
          signature: Buffer.alloc(64),
        }));
        changed.sign(kp);
        return changed.toXDR();
      },
    };
    await expect(signWith(tx, resolveSigner(signer), PASSPHRASE)).rejects.toThrow(/changed a signature/);
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

describe('deprecated Keypair / secret inputs', () => {
  beforeEach(() => {
    _resetSignerDeprecationWarnings();
  });

  it('still sign, and warn once about the deprecation', async () => {
    const kp = Keypair.random();
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});

    const a = (await signForSubmission(buildTx(kp.publicKey()), kp, config())) as Transaction;
    const b = (await signForSubmission(buildTx(kp.publicKey()), kp, config())) as Transaction;
    const c = (await signForSubmission(buildTx(kp.publicKey()), kp.secret(), config())) as Transaction;

    expect(kp.verify(a.hash(), a.signatures[0].signature())).toBe(true);
    expect(b.signatures).toHaveLength(1);
    expect(c.signatures).toHaveLength(1);
    const messages = warn.mock.calls.map((c) => String(c[0]));
    expect(messages.filter((m) => m.includes('Keypair'))).toHaveLength(1); // once, not per call
    expect(messages.filter((m) => m.includes('secret string'))).toHaveLength(1);
    expect(messages[0]).toMatch(/deprecated/);
    warn.mockRestore();
  });
});
