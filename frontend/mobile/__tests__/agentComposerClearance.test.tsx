/**
 * #1039 — the agent's reply drew on top of its own input box.
 *
 * The composer is anchored over the thread (`KeyboardStickyView` translates it
 * by the keyboard height with no layout pass), so the thread's content padding
 * is the only thing standing between the last message and the chips and the
 * input. This test pins that padding to the composer's *measured* height:
 * with the keyboard closed, with it open, and at the largest text size. A
 * constant creeping back in fails here rather than on a device.
 */

// Bottom inset of the mocked safe area; `liftedBy` subtracts it from the
// keyboard height, exactly as the screen does.
const INSET_BOTTOM = 34;
const mockKeyboard = { height: 0 };

jest.mock('expo-router', () => ({
  useRouter: () => ({
    push: jest.fn(),
    replace: jest.fn(),
    back: jest.fn(),
    canGoBack: () => false,
  }),
}));

// A passthrough view: the translation is native animation the test environment
// cannot run, and it is not what this test is pinning — the padding is.
jest.mock('react-native-keyboard-controller', () => {
  const React = require('react');
  const { View } = require('react-native');
  return {
    KeyboardStickyView: ({ children, ...props }: Record<string, unknown>) =>
      React.createElement(View, props, children),
    useKeyboardState: (selector: (state: { height: number }) => number) => selector(mockKeyboard),
  };
});

jest.mock('react-native-safe-area-context', () => {
  const { View } = require('react-native');
  return {
    SafeAreaView: View,
    useSafeAreaInsets: () => ({ top: 59, bottom: INSET_BOTTOM, left: 0, right: 0 }),
  };
});

jest.mock('../hooks/useTheme', () => ({
  useTheme: () => ({ colors: new Proxy({}, { get: () => '#000000' }) }),
}));

jest.mock('../hooks/useNetwork', () => ({
  useNetwork: () => ({
    network: {
      networkPassphrase: 'Test SDF Network ; September 2015',
      horizonUrl: 'https://horizon-testnet.stellar.org',
      displayName: 'Testnet',
    },
  }),
}));

jest.mock('../lib/walletStore', () => ({
  getWalletAddress: jest.fn(async () => null),
  getSignerSecret: jest.fn(async () => null),
  getPasskeyId: jest.fn(async () => null),
}));

jest.mock('../lib/passkey', () => ({ signPayloadWithPasskey: jest.fn() }));
jest.mock('../lib/polyfills', () => ({}));
jest.mock('expo-clipboard', () => ({ setStringAsync: jest.fn(async () => true) }));
jest.mock('../components/icons', () => ({
  ArrowUpIcon: () => null,
  BackIcon: () => null,
}));
jest.mock('../components/VeilLogo', () => ({ VeilLogo: () => null }));

import { StyleSheet } from 'react-native';
import type { ScrollViewProps, StyleProp, ViewStyle } from 'react-native';

import AgentScreen from '../app/(tabs)/agent';

// No @types package ships for react-test-renderer; this is the slice used here.
type LayoutEventLike = { nativeEvent: { layout: { height: number } } };
type Instance = { props: Record<string, unknown> };
type Root = { findAll: (predicate: (node: Instance) => boolean) => Instance[] };
type Renderer = {
  act: (fn: () => Promise<void>) => Promise<void>;
  create: (el: unknown) => { root: Root };
};
// eslint-disable-next-line @typescript-eslint/no-require-imports
const renderer: Renderer = require('react-test-renderer');

// The first render in this file pays for transforming the screen's whole
// import graph in a cold worker — same as the other screen test here.
jest.setTimeout(60_000);

function find(root: Root, testID: string, extra: (node: Instance) => boolean = () => true): Instance {
  const matches = root.findAll(
    (node) => (node.props as { testID?: string }).testID === testID && extra(node)
  );
  if (matches.length === 0) throw new Error(`no element with testID ${testID}`);
  return matches[0];
}

async function renderAgent(keyboardHeight: number, composerHeight: number): Promise<Root> {
  mockKeyboard.height = keyboardHeight;
  let tree!: { root: Root };
  await renderer.act(async () => {
    tree = renderer.create(<AgentScreen />);
  });
  // Report the composer's height the way the real one does — `onLayout` —
  // so the assertion covers the measurement path, not just the arithmetic.
  const composer = find(
    tree.root,
    'agent-composer',
    (node) => typeof node.props.onLayout === 'function'
  );
  const onLayout = composer.props.onLayout as (event: LayoutEventLike) => void;
  await renderer.act(async () => {
    onLayout({ nativeEvent: { layout: { height: composerHeight } } });
  });
  return tree.root;
}

function threadPadding(root: Root): number {
  const thread = find(root, 'agent-thread', (node) => node.props.contentContainerStyle !== undefined);
  const style = StyleSheet.flatten(
    thread.props.contentContainerStyle as ScrollViewProps['contentContainerStyle']
  );
  return typeof style?.paddingBottom === 'number' ? style.paddingBottom : Number.NaN;
}

it('reserves the measured composer height with the keyboard closed', async () => {
  const root = await renderAgent(0, 168);
  expect(threadPadding(root)).toBe(16 + 168);
});

it('adds the keyboard lift on top when the keyboard is open', async () => {
  // Keyboard 300 high, inset 34 → the sticky view lifts the composer by 266.
  const root = await renderAgent(300, 168);
  expect(threadPadding(root)).toBe(16 + 168 + 266);
});

it('tracks the composer as it grows — largest text size, and typing', async () => {
  const small = await renderAgent(0, 420);
  expect(threadPadding(small)).toBe(16 + 420);
  const smallOpen = await renderAgent(300, 420);
  expect(threadPadding(smallOpen)).toBe(16 + 420 + 266);
});

it('anchors the composer over the thread, so the reservation is what clears it', async () => {
  const root = await renderAgent(0, 168);
  const anchorStyle = StyleSheet.flatten(
    find(root, 'agent-composer-anchor').props.style as StyleProp<ViewStyle>
  );
  expect(anchorStyle.position).toBe('absolute');
  expect(anchorStyle.bottom).toBe(0);
  // The thread's viewport runs the full height of the screen behind the
  // composer; the padding pinned above is what keeps the last message
  // visible inside it.
  const thread = find(root, 'agent-thread', (node) => node.props.style !== undefined);
  expect(StyleSheet.flatten(thread.props.style as StyleProp<ViewStyle>).flex).toBe(1);
});
