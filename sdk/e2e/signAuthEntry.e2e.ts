/**
 * The SDK signs; the real contract, on a real network, decides.
 *
 * SDK unit tests mock the RPC and so assert what the SDK sends, and the Rust
 * tests assert the contract against fixtures. Neither checks the two against
 * each other, which is how the signature vector drifted before. This test
 * closes that: `signSorobanAuthEntry` signs a real auth entry for a deployed
 * `invisible_wallet`, and the wallet's own `__check_auth` has to accept it.
 *
 * It must go red if an element is dropped from the vector. The controls below
 * show the contract really does reject a vector with any one element removed,
 * so a green positive test cannot be a test that would also pass when broken.
 *
 * Run with `npm run test:e2e:local` (see e2e/README.md).
 */
import {
  Address,
  BASE_FEE,
  Contract,
  Keypair,
  Operation,
  TransactionBuilder,
  nativeToScVal,
  rpc,
  xdr,
} from '@stellar/stellar-sdk';
import { signSorobanAuthEntry } from '../src/sep43';
import {
  config,
  deployWallet,
  fundedAccount,
  nativeAssetId,
  nativeBalance,
  prepare,
  server,
  transferNative,
  send,
  waitForNetwork,
  walletNonce,
} from './network';
import { SoftPasskey } from './softPasskey';

const RP_ID = 'e2e.veil.test';
const ORIGIN = 'https://e2e.veil.test';

const WALLET_FUNDING = 100n * 10_000_000n; // 100 XLM
const SPEND = 10n * 10_000_000n; // 10 XLM

// `WalletError` discriminants in contracts/invisible_wallet/src/lib.rs.
const INVALID_SIGNATURE_FORMAT = 2;
const NONCE_MISMATCH = 16;

const contractError = (code: number) => new RegExp(`Error\\(Contract, #${code}\\)`);

let deployer: Keypair;
let recipient: Keypair;
let passkey: SoftPasskey;
let walletId: string;

beforeAll(async () => {
  await waitForNetwork();
  deployer = await fundedAccount();
  recipient = await fundedAccount();
  passkey = new SoftPasskey(RP_ID, ORIGIN);
  walletId = await deployWallet(deployer, passkey.publicKey, RP_ID, ORIGIN);
  await transferNative(deployer, walletId, WALLET_FUNDING);
}, 600_000);

/** Mutates the signed signature vector before it is attached to the transaction. */
type VectorMutation = (elements: xdr.ScVal[]) => xdr.ScVal[];

/**
 * Have the wallet spend `SPEND` to the recipient, authorised by a passkey
 * signature built by the real `signSorobanAuthEntry`.
 */
async function spendFromWallet(options: {
  mutate?: VectorMutation;
  getNonce?: (contractAddress: string) => Promise<bigint>;
} = {}) {
  const transfer = new Contract(nativeAssetId()).call(
    'transfer',
    new Address(walletId).toScVal(),
    new Address(recipient.publicKey()).toScVal(),
    nativeToScVal(SPEND, { type: 'i128' }),
  );

  // Recording simulation: the network tells us which entries need a signature.
  const draftAccount = await server.getAccount(deployer.publicKey());
  const draft = new TransactionBuilder(draftAccount, { fee: BASE_FEE, networkPassphrase: config.networkPassphrase })
    .addOperation(transfer)
    .setTimeout(120)
    .build();
  const recorded = await server.simulateTransaction(draft);
  if (!rpc.Api.isSimulationSuccess(recorded) || !recorded.result) {
    throw new Error(`Recording simulation failed: ${'error' in recorded ? recorded.error : 'no result'}`);
  }

  // Taken from the simulation itself: it is as current as the entries it returned.
  const latestLedger = recorded.latestLedger;
  const auth: xdr.SorobanAuthorizationEntry[] = [];
  for (const entry of recorded.result.auth) {
    const isWalletEntry =
      entry.credentials().switch().value === xdr.SorobanCredentialsType.sorobanCredentialsAddress().value;
    if (!isWalletEntry) {
      auth.push(entry);
      continue;
    }

    let signed = await signSorobanAuthEntry(entry.toXDR('base64'), {
      signerAddress: walletId,
      networkPassphrase: config.networkPassphrase,
      signPayload: (payloadHash) => passkey.assert(payloadHash),
      validUntilLedger: latestLedger + 100,
      getNonce: options.getNonce ?? walletNonce.bind(null, walletId),
    });

    if (options.mutate) signed = withVector(signed, options.mutate);
    auth.push(xdr.SorobanAuthorizationEntry.fromXDR(signed, 'base64'));
  }

  // Rebuild with the signed entries. A fresh account: building the draft
  // already consumed a sequence number on the first one.
  const draftOp = draft.operations[0] as Operation.InvokeHostFunction;
  const account = await server.getAccount(deployer.publicKey());
  const tx = new TransactionBuilder(account, { fee: BASE_FEE, networkPassphrase: config.networkPassphrase })
    .addOperation(Operation.invokeHostFunction({ func: draftOp.func, auth }))
    .setTimeout(120)
    .build();

  // This simulation runs the wallet's `__check_auth` against the signed entry;
  // a vector the contract refuses fails here with the contract's own error.
  const prepared = await prepare(tx);
  prepared.sign(deployer);
  return send(prepared);
}

/** Replace the signature vector inside a signed entry. */
function withVector(signedEntryXdr: string, mutate: VectorMutation): string {
  const entry = xdr.SorobanAuthorizationEntry.fromXDR(signedEntryXdr, 'base64');
  const credentials = entry.credentials().address();
  credentials.signature(xdr.ScVal.scvVec(mutate(credentials.signature().vec()!)));
  return entry.toXDR('base64');
}

describe('signSorobanAuthEntry against the deployed wallet contract', () => {
  it('produces a signature the contract accepts, and spends from the wallet', async () => {
    const [walletBefore, recipientBefore, nonceBefore] = await Promise.all([
      nativeBalance(walletId),
      nativeBalance(recipient.publicKey()),
      walletNonce(walletId),
    ]);

    await spendFromWallet();

    expect(await nativeBalance(walletId)).toBe(walletBefore - SPEND);
    expect(await nativeBalance(recipient.publicKey())).toBe(recipientBefore + SPEND);
    // `__check_auth` advances the nonce only after every check has passed, so
    // this proves it ran to the end rather than being skipped.
    expect(await walletNonce(walletId)).toBe(nonceBefore + 1n);
  }, 300_000);

  describe('controls: the contract rejects a vector with any element missing', () => {
    const elements = ['public key', 'authenticatorData', 'clientDataJSON', 'signature', 'nonce'];

    it.each(elements.map((name, index) => [name, index] as const))(
      'refuses a vector without element [%#] (%s)',
      async (_name, index) => {
        const before = await walletNonce(walletId);

        await expect(
          spendFromWallet({ mutate: (vec) => vec.filter((_, i) => i !== index) }),
        ).rejects.toThrow(contractError(INVALID_SIGNATURE_FORMAT));

        expect(await walletNonce(walletId)).toBe(before);
      },
      300_000,
    );

    it('refuses a nonce that is not the wallet\'s current one', async () => {
      await expect(
        spendFromWallet({ getNonce: async (address) => (await walletNonce(address)) + 1n }),
      ).rejects.toThrow(contractError(NONCE_MISMATCH));
    }, 300_000);
  });
});
