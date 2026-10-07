/**
 * #829 — how the fee-payer was derived (lib/feePayerSource.ts), and that the
 * wallet-creation path records it for both derivation states: passkey PRF and
 * the random fallback.
 */

const store: {
  signerSecret: string | null;
  walletAddress: string | null;
  passkeyId: string | null;
} = { signerSecret: null, walletAddress: null, passkeyId: null };

const mockEvaluatePrf = jest.fn();
const mockRegister = jest.fn();

jest.mock('../walletStore', () => ({
  getSignerSecret: jest.fn(async () => store.signerSecret),
  getWalletAddress: jest.fn(async () => store.walletAddress),
  getPasskeyId: jest.fn(async () => store.passkeyId),
  getPasskeyPublicKey: jest.fn(async () => null),
  setSignerSecret: jest.fn(async (s: string) => {
    store.signerSecret = s;
  }),
  setWalletAddress: jest.fn(async (a: string) => {
    store.walletAddress = a;
  }),
  setPasskeyId: jest.fn(async (id: string) => {
    store.passkeyId = id;
  }),
  setPasskeyCredential: jest.fn(async (id: string) => {
    store.passkeyId = id;
  }),
}));
jest.mock('../passkey', () => ({
  evaluatePrf: (...a: unknown[]) => mockEvaluatePrf(...a),
}));
jest.mock('../testnetWallet', () => ({ fundWithFriendbot: jest.fn(async () => false) }));
jest.mock('../walletBreadcrumbs', () => ({ writeBreadcrumbs: jest.fn(async () => undefined) }));

import AsyncStorage from '@react-native-async-storage/async-storage';
import { Keypair, StrKey } from '@stellar/stellar-sdk';

import { deriveFeePayerKeypair } from '../deriveFeePayer';
import {
  describeFeePayerSource,
  getFeePayerInfo,
  recordFeePayerSource,
  verifyFeePayerWithPasskey,
} from '../feePayerSource';
import { createPasskeyWallet } from '../passkeyWallet';

const WALLET = StrKey.encodeContract(Buffer.alloc(32, 3));
const KEY_ID = 'Y3JlZGVudGlhbC1pZA';
const PRF_OUTPUT = new Uint8Array(32).fill(5);
const PRF_ADDRESS = Keypair.fromRawEd25519Seed(Buffer.from(PRF_OUTPUT)).publicKey();

beforeEach(async () => {
  store.signerSecret = null;
  store.walletAddress = null;
  store.passkeyId = null;
  mockEvaluatePrf.mockReset();
  mockRegister.mockReset().mockResolvedValue({ walletAddress: WALLET });
  await AsyncStorage.clear();
  await AsyncStorage.setItem('invisible_wallet_key_id', KEY_ID);
});

describe('both derivation states, recorded at wallet creation', () => {
  it('records a PRF-derived fee-payer as prf', async () => {
    mockEvaluatePrf.mockResolvedValue({ outcome: 'ok', output: PRF_OUTPUT });
    await createPasskeyWallet({ register: mockRegister });

    const info = await getFeePayerInfo();
    expect(info).toEqual({ address: PRF_ADDRESS, source: 'prf' });
  });

  it('identifies a random-fallback fee-payer as random', async () => {
    mockEvaluatePrf.mockResolvedValue({ outcome: 'unsupported', output: null });
      // The commit is deferred when PRF is unavailable, so this returns
      // { status: 'unsupported', commit } rather than a wallet. Commit it to
      // get the wallet this assertion is about.
      const result = await createPasskeyWallet({ register: mockRegister });
      expect(result.status).toBe('unsupported');
      const created = result.status === 'unsupported' ? await result.commit() : result.wallet;
      expect(created.recoverable).toBe(false);

    const info = await getFeePayerInfo();
    expect(info?.source).toBe('random');
    expect(info?.address).toBe(Keypair.fromSecret(store.signerSecret!).publicKey());
    // The fee-payer, never the smart wallet.
    expect(info?.address).not.toBe(WALLET);
    expect(describeFeePayerSource('random').label).toBe('Random fallback');
  });
});

describe('getFeePayerInfo', () => {
  it('is null when this network has no wallet', async () => {
    expect(await getFeePayerInfo()).toBeNull();
  });

  it('ignores a record that names a different fee-payer', async () => {
    const current = Keypair.random();
    store.signerSecret = current.secret();
    store.walletAddress = WALLET;
    await recordFeePayerSource(Keypair.random().publicKey(), 'prf');

    expect((await getFeePayerInfo())?.source).toBe('unknown');
  });

  it('recognises a keypair-mode wallet, whose fee-payer is the wallet itself', async () => {
    const kp = Keypair.random();
    store.signerSecret = kp.secret();
    store.walletAddress = kp.publicKey();
    expect(await getFeePayerInfo()).toEqual({ address: kp.publicKey(), source: 'keypair' });
  });

  it('recognises the legacy credential-id derivation without a prompt', async () => {
    const legacy = deriveFeePayerKeypair(KEY_ID);
    store.signerSecret = legacy.secret();
    store.walletAddress = WALLET;
    store.passkeyId = KEY_ID;
    expect((await getFeePayerInfo())?.source).toBe('credential-id');
    expect(mockEvaluatePrf).not.toHaveBeenCalled();
  });
});

describe('verifyFeePayerWithPasskey', () => {
  beforeEach(() => {
    store.walletAddress = WALLET;
    store.passkeyId = KEY_ID;
  });

  it('settles an unrecorded PRF fee-payer as prf and remembers it', async () => {
    store.signerSecret = Keypair.fromRawEd25519Seed(Buffer.from(PRF_OUTPUT)).secret();
    mockEvaluatePrf.mockResolvedValue({ outcome: 'ok', output: PRF_OUTPUT });

    expect(await verifyFeePayerWithPasskey()).toEqual({ ok: true, source: 'prf' });
    expect((await getFeePayerInfo())?.source).toBe('prf');
  });

  it('settles a fee-payer the passkey does not derive as random', async () => {
    store.signerSecret = Keypair.random().secret();
    mockEvaluatePrf.mockResolvedValue({ outcome: 'ok', output: PRF_OUTPUT });

    expect(await verifyFeePayerWithPasskey()).toEqual({ ok: true, source: 'random' });
    expect((await getFeePayerInfo())?.source).toBe('random');
  });

  it('records nothing when the passkey gives no PRF output', async () => {
    store.signerSecret = Keypair.random().secret();
    mockEvaluatePrf.mockResolvedValue({ outcome: 'unsupported', output: null });

    expect(await verifyFeePayerWithPasskey()).toEqual({ ok: false, reason: 'no-prf' });
    expect((await getFeePayerInfo())?.source).toBe('unknown');
  });
});
