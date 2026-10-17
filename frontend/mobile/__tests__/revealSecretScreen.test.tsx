/**
 * #1041 — the reveal screen's contract with the user.
 *
 * The decision logic is tested in `lib/__tests__/secretExport.test.ts`; what is
 * tested here is the part only a screen can get wrong: whether a key can reach
 * the render tree before the lock is passed, whether the consequences are on
 * the screen before the button that shows the key, and whether the key is gone
 * again when the user leaves.
 *
 * A smart wallet is rendered with its fee-payer key sitting in the very storage
 * slot a keypair wallet's secret occupies, so "the secret never appears in the
 * tree" is asserted as rendered text, not as a status code — the failure this
 * guards against is a render path, not a decision path.
 */

import { Keypair, StrKey } from '@stellar/stellar-sdk';

const mockStore = new Map<string, string>();

// ── Controllable seams ──────────────────────────────────────────────────────────

const mockAuth = {
  level: 2 as number,
  success: true,
  error: '',
  /** Counts the enrolled-level checks, i.e. how many times the lock was asked. */
  checks: 0,
  prompts: 0,
};

jest.mock('expo-local-authentication', () => ({
  SecurityLevel: { NONE: 0, SECRET: 1, BIOMETRIC: 2, PASSCODE: 3 },
  getEnrolledLevelAsync: jest.fn(async () => {
    mockAuth.checks += 1;
    if (mockAuth.level === -1) throw new Error('keystore unavailable');
    return mockAuth.level;
  }),
  authenticateAsync: jest.fn(async () => {
    mockAuth.prompts += 1;
    return { success: mockAuth.success, error: mockAuth.error };
  }),
}));

jest.mock('expo-secure-store', () => ({
  getItemAsync: jest.fn(async (key: string) => (mockStore.has(key) ? mockStore.get(key)! : null)),
  setItemAsync: jest.fn(async (key: string, value: string) => {
    mockStore.set(key, value);
  }),
  deleteItemAsync: jest.fn(async (key: string) => {
    mockStore.delete(key);
  }),
}));

const mockClipboard = jest.fn(async (_value: string) => true);
jest.mock('expo-clipboard', () => ({ setStringAsync: (value: string) => mockClipboard(value) }));

/** Captured so a test can fire the blur cleanup the navigator would fire. */
let blurCleanup: (() => void) | null = null;
const mockPush = jest.fn();
jest.mock('expo-router', () => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { useEffect } = require('react');
  return {
    useFocusEffect: (callback: () => (() => void) | void) => {
      useEffect(() => {
        const cleanup = callback();
        blurCleanup = typeof cleanup === 'function' ? cleanup : null;
        return () => {
          blurCleanup = null;
          if (typeof cleanup === 'function') cleanup();
        };
      }, [callback]);
    },
    useRouter: () => ({ push: mockPush, back: jest.fn(), canGoBack: () => true, replace: jest.fn() }),
  };
});

jest.mock('react-native-safe-area-context', () => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { View } = require('react-native');
  return {
    SafeAreaView: View,
    useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }),
  };
});

jest.mock('../hooks/useTheme', () => ({
  useTheme: () => ({ colors: new Proxy({}, { get: () => '#000000' }) }),
}));

// React Native's own Jest mock supplies `AppState.addEventListener` (a jest.fn
// that records the handler), so a test can fire a background transition
// without replacing the module the whole screen renders from.
import { AppState } from 'react-native';

function fireAppState(state: 'background' | 'active') {
  const calls = (AppState.addEventListener as unknown as jest.Mock).mock.calls;
  const handler = calls[calls.length - 1]?.[1] as ((next: string) => void) | undefined;
  if (!handler) throw new Error('the screen did not subscribe to AppState');
  handler(state);
}

import RevealSecretScreen from '../app/settings/reveal-secret';
import { createTestnetWallet, importTestnetWallet } from '../lib/testnetWallet';
import { setPasskeyCredential, setSignerSecret, setWalletAddress } from '../lib/walletStore';

type Instance = { props: Record<string, unknown>; children: (Instance | string)[] };
/** `tree.root` is itself an instance that also carries the query methods. */
type TestNode = Instance & {
  findByProps: (p: object) => Instance;
  findAllByProps: (p: object) => Instance[];
};
type Tree = { root: TestNode; unmount: () => void };
type Renderer = {
  act: (fn: () => Promise<void>) => Promise<void>;
  create: (el: unknown) => Tree;
};
// eslint-disable-next-line @typescript-eslint/no-require-imports
const renderer: Renderer = require('react-test-renderer');

function text(node: Instance): string {
  return node.children.map((c) => (typeof c === 'string' ? c : text(c))).join('');
}

/** Every string in the tree — the only way to prove a key is absent from it. */
function allText(node: Instance): string {
  return text(node);
}

async function render() {
  let tree!: Tree;
  await renderer.act(async () => {
    tree = renderer.create(<RevealSecretScreen />);
  });
  return tree;
}

async function press(instance: Instance) {
  await renderer.act(async () => {
    (instance.props.onPress as (e?: unknown) => void)({});
  });
}

async function ackAndReveal(root: TestNode) {
  await press(root.findByProps({ testID: 'secret-reveal-ack' }));
  await press(root.findByProps({ testID: 'secret-reveal-button' }));
}

const SECRET_KEY = 'veil_signer_secret';

beforeEach(() => {
  mockStore.clear();
  blurCleanup = null;
  (AppState.addEventListener as unknown as jest.Mock).mockClear();
  mockAuth.level = 2;
  mockAuth.success = true;
  mockAuth.error = '';
  mockAuth.checks = 0;
  mockAuth.prompts = 0;
  mockClipboard.mockClear();
  mockPush.mockClear();
  global.fetch = jest.fn(async () => ({ ok: true, status: 200, text: async () => '' })) as never;
});

// First render pays for transforming React Native and the screen's whole import
// graph in a cold worker; the assertions themselves take milliseconds.
jest.setTimeout(120_000);

const SMART_ADDRESS = StrKey.encodeContract(Buffer.alloc(32, 4));

// ── A smart wallet is offered nothing ───────────────────────────────────────────

it('tells a smart wallet it has no secret to reveal, and never shows its fee-payer key', async () => {
  const feePayer = Keypair.random();
  await setWalletAddress(SMART_ADDRESS);
  await setSignerSecret(feePayer.secret());
  await setPasskeyCredential('cred-id', 'a1b2c3');

  const { root } = await render();

  const refusal = root.findByProps({ testID: 'secret-export-refusal' });
  expect(text(refusal)).toContain('no secret key to reveal');
  expect(text(refusal)).toContain('never left it');
  expect(text(refusal)).toContain(SMART_ADDRESS);

  // No path to a reveal at all.
  expect(root.findAllByProps({ testID: 'secret-reveal-button' })).toHaveLength(0);

  // The fee-payer key sits one read away from this screen. It must not reach
  // the render tree in any form.
  expect(mockStore.get(SECRET_KEY)).toBe(feePayer.secret());
  expect(allText(root)).not.toContain(feePayer.secret());
});

it('offers a smart wallet the backup path instead', async () => {
  await setWalletAddress(SMART_ADDRESS);
  const { root } = await render();

  await press(root.findByProps({ testID: 'secret-refusal-backup-link' }));
  expect(mockPush).toHaveBeenCalledWith('/settings/backup');
});

// ── The gate comes before the key ───────────────────────────────────────────────

it('states the consequences, with the reveal button disabled until they are acknowledged', async () => {
  const created = await createTestnetWallet();
  const { root } = await render();

  const gate = root.findByProps({ testID: 'secret-export-consequences' });
  expect(text(gate)).toContain('Anyone who has this secret');
  expect(text(gate)).toContain('This is the only copy');
  expect(text(gate)).toContain('Veil cannot recover it');

  // The wallet's address is on screen in full — never elided.
  expect(text(root.findByProps({ testID: 'gate-address' }))).toBe(created.address);

  const button = root.findByProps({ testID: 'secret-reveal-button' });
  expect(button.props.disabled).toBe(true);
  expect((button.props.accessibilityState as { disabled: boolean }).disabled).toBe(true);

  // Nothing key-shaped is rendered while the gate is closed.
  expect(root.findAllByProps({ testID: 'secret-revealed-value' })).toHaveLength(0);
  expect(allText(root)).not.toContain(mockStore.get(SECRET_KEY) ?? '');
});

it('reveals nothing when the unlock is dismissed', async () => {
  await createTestnetWallet();
  mockAuth.success = false;
  mockAuth.error = 'UserCancel';

  const { root } = await render();
  await ackAndReveal(root);

  expect(root.findAllByProps({ testID: 'secret-revealed-value' })).toHaveLength(0);
  expect(text(root.findByProps({ testID: 'secret-export-consequences' }))).toContain(
    'Unlock cancelled',
  );
  expect(allText(root)).not.toContain(mockStore.get(SECRET_KEY) ?? '');
});

it('refuses to reveal on a device with no lock to reveal behind', async () => {
  await createTestnetWallet();
  mockAuth.level = 0; // nothing enrolled

  const { root } = await render();
  await ackAndReveal(root);

  expect(root.findAllByProps({ testID: 'secret-revealed-value' })).toHaveLength(0);
  expect(text(root.findByProps({ testID: 'secret-export-consequences' }))).toContain(
    'no passcode or biometric',
  );
  // It must not even have prompted: a prompt nobody can answer reads as a pass.
  expect(mockAuth.checks).toBe(1);
  expect(mockAuth.prompts).toBe(0);
});

// ── The reveal, and its end ─────────────────────────────────────────────────────

it('shows the full key behind the lock, then takes it back', async () => {
  const created = await createTestnetWallet();
  const secret = mockStore.get(SECRET_KEY);
  if (!secret) throw new Error('expected a stored key');

  const { root } = await render();
  await ackAndReveal(root);

  // Shown whole: not masked, not truncated, not split.
  expect(text(root.findByProps({ testID: 'secret-revealed-value' }))).toBe(secret);
  expect(text(root.findByProps({ testID: 'secret-revealed-address' }))).toBe(created.address);
  expect(text(root.findByProps({ testID: 'secret-only-copy-banner' }))).toContain('only copy');

  // Copying is offered, with the clipboard's exposure stated.
  await press(root.findByProps({ testID: 'secret-copy-button' }));
  expect(mockClipboard).toHaveBeenCalledWith(secret);

  // Hide → back to the gate, key gone from the tree.
  await press(root.findByProps({ testID: 'secret-hide-button' }));
  expect(root.findAllByProps({ testID: 'secret-revealed-value' })).toHaveLength(0);
  expect(allText(root)).not.toContain(secret);
  // The acknowledgement is consumed by the reveal, so the next one has to be
  // given again rather than remembered.
  expect(root.findByProps({ testID: 'secret-reveal-button' }).props.disabled).toBe(true);
});

it('conceals the key when the app is backgrounded or the screen loses focus', async () => {
  await createTestnetWallet();
  const secret = mockStore.get(SECRET_KEY);
  if (!secret) throw new Error('expected a stored key');

  const { root } = await render();
  await ackAndReveal(root);
  expect(text(root.findByProps({ testID: 'secret-revealed-value' }))).toBe(secret);

  // Switching apps is when a shoulder-surfed key is most likely to be visible,
  // so it has to cost a fresh unlock to see it again.
  await renderer.act(async () => {
    fireAppState('background');
  });
  expect(root.findAllByProps({ testID: 'secret-revealed-value' })).toHaveLength(0);
  expect(allText(root)).not.toContain(secret);

  await renderer.act(async () => {
    blurCleanup?.();
  });
  expect(root.findAllByProps({ testID: 'secret-revealed-value' })).toHaveLength(0);
});

it('asks the lock again for a second reveal', async () => {
  await createTestnetWallet();
  const { root } = await render();

  await ackAndReveal(root);
  const first = text(root.findByProps({ testID: 'secret-revealed-value' }));

  await press(root.findByProps({ testID: 'secret-hide-button' }));
  await ackAndReveal(root);

  // Two checks and two prompts: the lock is passed per reveal, not per visit.
  expect(mockAuth.checks).toBe(2);
  expect(mockAuth.prompts).toBe(2);
  expect(text(root.findByProps({ testID: 'secret-revealed-value' }))).toBe(first);
});

// ── The round trip, seen from the screen ────────────────────────────────────────

it('shows a key that reproduces the wallet when imported back', async () => {
  const created = await createTestnetWallet();
  const { root, unmount } = await render();
  await ackAndReveal(root);
  const secret = text(root.findByProps({ testID: 'secret-revealed-value' }));
  expect(secret).toBe(mockStore.get(SECRET_KEY));

  // Reinstall: the keychain is emptied and the screen mounted again, as it is
  // when the app itself is reinstalled. Nothing is revealed for a wallet whose
  // key is not on the device.
  mockStore.clear();
  await renderer.act(async () => {
    unmount();
  });

  const orphan = await render();
  expect(orphan.root.findAllByProps({ testID: 'secret-revealed-value' })).toHaveLength(0);
  expect(text(orphan.root.findByProps({ testID: 'secret-export-refusal' }))).toContain('No wallet');

  // The key from the first reveal, imported with the real import flow, is the
  // same wallet again — which is the whole point of revealing it.
  await renderer.act(async () => {
    orphan.unmount();
    await importTestnetWallet(secret);
  });

  const { root: restored } = await render();
  expect(text(restored.findByProps({ testID: 'gate-address' }))).toBe(created.address);
  await ackAndReveal(restored);
  expect(text(restored.findByProps({ testID: 'secret-revealed-value' }))).toBe(secret);
});
