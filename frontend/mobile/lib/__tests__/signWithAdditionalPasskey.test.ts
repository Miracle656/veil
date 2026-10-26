/**
 * Either passkey can sign — and the key in the credential is the one that did.
 *
 * `__check_auth` looks the credential's public key up in the signer list and
 * verifies the signature against it, so a signature from the added passkey
 * carried with the primary's key would fail on chain. And a wallet with no
 * added passkey must take exactly the path it always has.
 */

const mockGet = jest.fn();
const mockActive = jest.fn();

jest.mock('react-native-passkeys', () => ({ isSupported: () => true, get: (...a: unknown[]) => mockGet(...a) }));
jest.mock('expo-crypto', () => ({ getRandomBytes: (n: number) => new Uint8Array(n) }));
jest.mock('../walletConnect', () => ({ registerAuthEntrySigner: jest.fn() }));
jest.mock('../additionalSigners', () => ({ listActiveAdditionalSigners: () => mockActive() }));
jest.mock('../walletStore', () => ({
  getPasskeyId: async () => 'cHJpbWFyeQ',
  getPasskeyPublicKey: async () => `04${'01'.repeat(64)}`,
  getSignerSecret: async () => null,
}));

import { signPayloadWithPasskey } from '../passkey';

const ADDED_KEY = `04${'02'.repeat(64)}`;
// A minimal DER signature: SEQUENCE { INTEGER 1, INTEGER 1 }.
const DER_SIG = Buffer.from([0x30, 0x06, 0x02, 0x01, 0x01, 0x02, 0x01, 0x01]).toString('base64url');

function assertionFrom(id: string) {
  return {
    id,
    response: {
      authenticatorData: Buffer.alloc(37, 5).toString('base64url'),
      clientDataJSON: Buffer.from('{}').toString('base64url'),
      signature: DER_SIG,
    },
  };
}

beforeEach(() => jest.clearAllMocks());

it('with no added passkey, offers only the primary and signs with its key', async () => {
  mockActive.mockResolvedValue([]);
  mockGet.mockResolvedValue(assertionFrom('cHJpbWFyeQ'));

  const sig = await signPayloadWithPasskey(new Uint8Array(32));

  expect(mockGet.mock.calls[0][0].allowCredentials).toEqual([{ id: 'cHJpbWFyeQ', type: 'public-key' }]);
  expect(Buffer.from(sig!.publicKey).toString('hex')).toBe(`04${'01'.repeat(64)}`);
});

it('offers a confirmed added passkey too, and carries ITS key when it answers', async () => {
  mockActive.mockResolvedValue([{ credentialId: 'YWRkZWQ', publicKey: ADDED_KEY, status: 'active', transports: ['hybrid'], addedAt: '' }]);
  mockGet.mockResolvedValue(assertionFrom('YWRkZWQ'));

  const sig = await signPayloadWithPasskey(new Uint8Array(32));

  expect(mockGet.mock.calls[0][0].allowCredentials).toEqual([
    { id: 'cHJpbWFyeQ', type: 'public-key' },
    { id: 'YWRkZWQ', type: 'public-key', transports: ['hybrid'] },
  ]);
  expect(Buffer.from(sig!.publicKey).toString('hex')).toBe(ADDED_KEY);
});

it('refuses an answer from a credential the wallet does not know', async () => {
  mockActive.mockResolvedValue([{ credentialId: 'YWRkZWQ', publicKey: ADDED_KEY, status: 'active', addedAt: '' }]);
  mockGet.mockResolvedValue(assertionFrom('c3RyYW5nZXI'));

  await expect(signPayloadWithPasskey(new Uint8Array(32))).rejects.toMatchObject({ outcome: 'refused' });
});

it('an unreadable added-passkey list never stops the primary from signing', async () => {
  mockActive.mockRejectedValue(new Error('corrupt'));
  mockGet.mockResolvedValue(assertionFrom('cHJpbWFyeQ'));

  const sig = await signPayloadWithPasskey(new Uint8Array(32));
  expect(Buffer.from(sig!.publicKey).toString('hex')).toBe(`04${'01'.repeat(64)}`);
});
