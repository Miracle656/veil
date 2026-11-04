/**
 * The passkey recovery check stopped prompting at all.
 *
 * Reported from a real device: "Passkey recovery check is still not working,
 * it used to work before where it pops up for me to sign my passkey." The row
 * read "Could not check this passkey. Try again." and no biometric prompt ever
 * appeared — because the check never reached the authenticator. It read the
 * SDK's copy of the credential id, found nothing, and returned `failed` on its
 * first line, before `evaluatePrf` could ask the passkey anything. There was
 * nothing to try again.
 *
 * The id was there the whole time, in `walletStore`. An install predating the
 * per-network namespacing keeps the SDK's copy under the BARE key, and
 * `getSdkItem` refuses to fall back to that on mainnet — rightly, because on
 * testnet the bare keys are a different, real wallet. `walletStore` carries no
 * such hazard: it namespaces by the same rule, so its id belongs to the same
 * network by construction.
 *
 * Only AsyncStorage, the network and the secure store are stubbed here, so the
 * namespacing these tests depend on is the real thing.
 */

const mockStore = new Map<string, string>();
const mockGetPasskeyId = jest.fn<Promise<string | null>, []>();
let mockNetworkName = 'mainnet';

jest.mock('../network', () => ({
  getNetworkName: () => mockNetworkName,
  hydrateNetwork: jest.fn(async () => undefined),
}));
jest.mock('../walletStore', () => ({ getPasskeyId: () => mockGetPasskeyId() }));
jest.mock('@react-native-async-storage/async-storage', () => ({
  __esModule: true,
  default: {
    getItem: jest.fn(async (k: string) => mockStore.get(k) ?? null),
    setItem: jest.fn(async (k: string, v: string) => { mockStore.set(k, v); }),
    multiSet: jest.fn(async (pairs: [string, string][]) => { for (const [k, v] of pairs) mockStore.set(k, v); }),
  },
}));

import { SDK_KEY_ID, getCredentialId } from '../sdkStorage';

const MAINNET_KEY = `${SDK_KEY_ID}_mainnet`;

beforeEach(() => {
  mockStore.clear();
  mockNetworkName = 'mainnet';
  jest.clearAllMocks();
  mockGetPasskeyId.mockResolvedValue(null);
});

it("prefers the SDK's own copy when it is there", async () => {
  mockStore.set(MAINNET_KEY, 'from-the-sdk');

  await expect(getCredentialId()).resolves.toBe('from-the-sdk');
  expect(mockGetPasskeyId).not.toHaveBeenCalled();
});

it('falls back to the app’s own store, which is how the prompt comes back', async () => {
  // Exactly the reported state: nothing under the mainnet SDK key, a perfectly
  // good credential id in the secure store.
  mockGetPasskeyId.mockResolvedValue('from-wallet-store');

  await expect(getCredentialId()).resolves.toBe('from-wallet-store');
});

it('writes the id back under the network-scoped key', async () => {
  mockGetPasskeyId.mockResolvedValue('from-wallet-store');

  await getCredentialId();

  // Scoped, not bare — healing it under the bare key would recreate the very
  // ambiguity `getSdkItem` refuses to read.
  expect(mockStore.get(MAINNET_KEY)).toBe('from-wallet-store');
  expect(mockStore.get(SDK_KEY_ID)).toBeUndefined();
});

it('does not read the bare mainnet key, even to fall back', async () => {
  // A testnet wallet's credential lives under the bare key. Reading it here
  // would bind the wrong wallet, which is worse than finding nothing.
  mockStore.set(SDK_KEY_ID, 'a-testnet-credential');

  await expect(getCredentialId()).resolves.toBeNull();
});

it('reports nothing when neither store has it', async () => {
  await expect(getCredentialId()).resolves.toBeNull();
});

it('survives a secure-store read that throws', async () => {
  mockGetPasskeyId.mockRejectedValue(new Error('keystore unavailable'));

  await expect(getCredentialId()).resolves.toBeNull();
});

it('uses the bare key on testnet, where that IS the wallet', async () => {
  mockNetworkName = 'testnet';
  mockStore.set(SDK_KEY_ID, 'the-testnet-credential');

  await expect(getCredentialId()).resolves.toBe('the-testnet-credential');
});
