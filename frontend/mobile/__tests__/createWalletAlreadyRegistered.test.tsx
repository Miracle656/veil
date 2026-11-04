/**
 * Tapping "Create with passkey" when the device already holds a Veil passkey
 * must offer sign-in, not an error.
 *
 * Reported by several people whose FIRST wallet this was: creation told them
 * they already had an account. They do have a passkey — the SDK records its
 * credential id during registration, before the wallet is deployed, so a run
 * that failed or was killed after that point leaves the id behind. Registering
 * again cannot succeed: that id goes out as `excludeCredentials` and the
 * platform refuses, permanently. Signing in with the same passkey works and
 * hands them their wallet, which is why "sign in just works fine".
 *
 * The old behaviour showed a paragraph suggesting they reset the wallet in
 * Settings → Danger zone — advice that destroys a working wallet, given to
 * someone whose wallet was fine and one tap away.
 */

const mockReplace = jest.fn();
const mockGetSdkItem = jest.fn();
const mockCreatePasskeyWallet = jest.fn();

jest.mock('expo-router', () => ({ useRouter: () => ({ replace: mockReplace, push: jest.fn(), back: jest.fn() }) }));
jest.mock('../hooks/useTheme', () => ({
  useTheme: () => ({ colors: new Proxy({}, { get: () => '#000000' }) }),
}));
jest.mock('../lib/sdkStorage', () => ({
  SDK_KEY_ID: 'invisible_wallet_key_id',
  getSdkItem: (...a: unknown[]) => mockGetSdkItem(...a),
}));
jest.mock('../lib/passkeyWallet', () => ({
  createPasskeyWallet: (...a: unknown[]) => mockCreatePasskeyWallet(...a),
  recreatePasskeyWallet: jest.fn(),
  retryRecoveryBinding: jest.fn(),
  FEE_PAYER_PRF_SALT: new Uint8Array(32),
}));
jest.mock('../lib/testnetWallet', () => ({
  createTestnetWallet: jest.fn(),
  importTestnetWallet: jest.fn(),
}));
jest.mock('../lib/network', () => ({
  getNetwork: () => ({ friendbotUrl: null, horizonUrl: 'https://horizon.example' }),
}));
jest.mock('../components/WalletProvider', () => ({ useWallet: () => ({}) }));
jest.mock('../lib/passkey', () => ({
  evaluatePrf: jest.fn(),
  isNoCredentialProvider: () => false,
  isExcludedCredentialExists: (e: unknown) =>
    String((e as Error)?.message ?? '').toLowerCase().includes('excluded credential'),
  NO_CREDENTIAL_PROVIDER_MESSAGE: 'no provider',
  CREDENTIAL_ALREADY_EXISTS_MESSAGE: 'already exists',
}));

import CreateWalletScreen from '../app/create-wallet';

type Instance = { props: Record<string, unknown>; children: (Instance | string)[] };
type Renderer = {
  act: (fn: () => Promise<void>) => Promise<void>;
  create: (el: unknown) => {
    root: { findByProps: (p: object) => Instance; findAllByProps: (p: object) => Instance[] };
  };
};
// eslint-disable-next-line @typescript-eslint/no-require-imports
const renderer: Renderer = require('react-test-renderer');

function text(node: Instance): string {
  return node.children.map((c) => (typeof c === 'string' ? c : text(c))).join('');
}

jest.setTimeout(60_000);

async function tapCreate() {
  let tree!: ReturnType<Renderer['create']>;
  await renderer.act(async () => {
    tree = renderer.create(<CreateWalletScreen />);
  });
  const button = tree.root.findByProps({ testID: 'create-passkey-button' });
  await renderer.act(async () => {
    await (button.props.onPress as () => Promise<void>)();
  });
  return tree.root;
}

beforeEach(() => {
  mockReplace.mockReset();
  mockGetSdkItem.mockReset();
  mockCreatePasskeyWallet.mockReset();
});

it('offers sign-in instead of registering when a credential id is already stored', async () => {
  mockGetSdkItem.mockResolvedValue('an-existing-credential-id');

  const root = await tapCreate();

  // Never even asked the platform: a second registration against a stored
  // credential id is refused by the OS every time.
  expect(mockCreatePasskeyWallet).not.toHaveBeenCalled();
  expect(root.findAllByProps({ testID: 'create-wallet-already-registered-screen' }).length).toBeGreaterThan(0);

  const signIn = root.findByProps({ testID: 'create-wallet-sign-in-instead' });
  await renderer.act(async () => {
    (signIn.props.onPress as () => void)();
  });
  expect(mockReplace).toHaveBeenCalledWith('/login');
});

it('routes to the same screen when the platform refuses an excluded credential', async () => {
  // Storage can be empty while the authenticator still holds the passkey —
  // then the refusal is the only signal, and it must land in the same place.
  mockGetSdkItem.mockResolvedValue(null);
  mockCreatePasskeyWallet.mockRejectedValue(
    new Error('One of the excluded credentials exists on the local device.'),
  );

  const root = await tapCreate();

  expect(root.findAllByProps({ testID: 'create-wallet-already-registered-screen' }).length).toBeGreaterThan(0);
  expect(root.findAllByProps({ testID: 'create-wallet-sign-in-instead' }).length).toBeGreaterThan(0);
});

it('creates normally when nothing is registered yet', async () => {
  mockGetSdkItem.mockResolvedValue(null);
  mockCreatePasskeyWallet.mockResolvedValue({
    status: 'created',
    wallet: { address: 'CWALLET', recoverable: true },
  });

  const root = await tapCreate();

  expect(mockCreatePasskeyWallet).toHaveBeenCalledTimes(1);
  expect(root.findAllByProps({ testID: 'create-wallet-already-registered-screen' })).toHaveLength(0);
});

it('warns that creating makes a new wallet, and offers sign-in, before any prompt', async () => {
  // The fresh-install trap: storage is empty after a reinstall, so nothing
  // here knows about the wallet the passkey already opens and the platform
  // has no reason to refuse. Nothing can detect it, so the screen has to say
  // so while there is still a choice to make.
  mockGetSdkItem.mockResolvedValue(null);
  let tree!: ReturnType<Renderer['create']>;
  await renderer.act(async () => {
    tree = renderer.create(<CreateWalletScreen />);
  });
  const root = tree.root;

  const notice = root.findByProps({ testID: 'create-wallet-new-wallet-notice' });
  const words = text(notice).toLowerCase();
  expect(words).toContain('brand-new wallet');
  expect(words).toContain('sign in');

  // And the way out is a control, not just prose.
  const link = root.findByProps({ testID: 'create-wallet-sign-in-link' });
  await renderer.act(async () => {
    (link.props.onPress as () => void)();
  });
  expect(mockReplace).toHaveBeenCalledWith('/login');
  expect(mockCreatePasskeyWallet).not.toHaveBeenCalled();
});
