/**
 * The names screen shows the name its user already holds.
 *
 * It opened on a bare claim form for the holder of `jack` (2026-11-11), which
 * reads as "you have no name". These pin what the holder sees instead: the
 * name, how long it is theirs, and the address it resolves to, and that a list
 * which could not be read says so rather than looking empty.
 */

import { Keypair, StrKey } from '@stellar/stellar-sdk';

const mockWallet = StrKey.encodeContract(Buffer.alloc(32, 7));
const mockSpending = Keypair.random().publicKey();
const mockLoadOwnedNames = jest.fn();

jest.mock('expo-router', () => ({ useRouter: () => ({ push: jest.fn(), back: jest.fn() }) }));
jest.mock('../hooks/useTheme', () => ({
  useTheme: () => ({ colors: new Proxy({}, { get: () => '#000000' }), isDark: false }),
}));
jest.mock('../components/FlowHeader', () => ({ FlowHeader: () => null }));
jest.mock('../components/SlideToConfirm', () => ({ SlideToConfirm: () => null }));
jest.mock('../lib/ownAddresses', () => ({
  getOwnAddresses: jest.fn(async () => ({ wallet: mockWallet, spending: mockSpending })),
}));
jest.mock('../lib/veilIans', () => ({ namesContractId: () => 'CREGISTRY' }));
jest.mock('../lib/ownedNames', () => ({
  ...jest.requireActual('../lib/ownedNames'),
  loadOwnedNames: (...args: unknown[]) => mockLoadOwnedNames(...args),
  rememberOwnName: jest.fn(async () => undefined),
}));
jest.mock('../lib/names', () => ({
  ...jest.requireActual('../lib/names'),
  nameState: jest.fn(async () => 'available'),
  quoteFromChain: jest.fn(async () => null),
  usdcBalance: jest.fn(async () => null),
  registerName: jest.fn(),
}));

import NamesScreen from '../app/names';
import { formatNameDate } from '../lib/ownedNames';

// No @types package ships for react-test-renderer; this is the slice used here.
type Instance = { props: Record<string, unknown>; children: (Instance | string)[] };
type Root = { findAllByProps: (p: object) => Instance[] };
type Renderer = {
  act: (fn: () => Promise<void>) => Promise<void>;
  create: (el: unknown) => { root: Root; unmount: () => void };
};
// eslint-disable-next-line @typescript-eslint/no-require-imports
const renderer: Renderer = require('react-test-renderer');
// eslint-disable-next-line @typescript-eslint/no-require-imports
const React = require('react');

function text(node: Instance): string {
  return node.children.map((c) => (typeof c === 'string' ? c : text(c))).join('');
}

/** The host node carrying a testID, or null. A composite and its host both match. */
function byTestId(root: Root, testID: string): Instance | null {
  return root.findAllByProps({ testID })[0] ?? null;
}

async function open(): Promise<{ root: Root; unmount: () => void }> {
  let tree: { root: Root; unmount: () => void } | undefined;
  await renderer.act(async () => {
    tree = renderer.create(React.createElement(NamesScreen));
  });
  // Let the address read and the owned-names read settle.
  await renderer.act(async () => {
    await Promise.resolve();
  });
  if (!tree) throw new Error('screen did not render');
  return tree;
}

async function close(tree: { unmount: () => void }): Promise<void> {
  await renderer.act(async () => {
    tree.unmount();
  });
}

const EXPIRES = 1825768862;

describe('names screen: the name you already hold', () => {
  beforeEach(() => mockLoadOwnedNames.mockReset());

  it('shows a name held on the spending account, its term, and where it resolves', async () => {
    mockLoadOwnedNames.mockResolvedValue({
      names: [{ name: 'jack', pointsAt: mockSpending, account: 'spending', expiresAt: EXPIRES }],
      complete: true,
    });

    const tree = await open();
    const card = byTestId(tree.root, 'names-owned-jack');
    expect(card).not.toBeNull();

    const shown = text(card as Instance);
    expect(shown).toContain('YOU HOLD');
    expect(shown).toContain('jack*useveilapp.xyz');
    expect(shown).toContain(`Yours until ${formatNameDate(EXPIRES)}.`);
    expect(shown).toContain('arrives in your spending account');
    expect(shown).toContain('Resolves to');
    // The whole address, never a shortened one.
    expect(shown).toContain(mockSpending);

    expect(mockLoadOwnedNames).toHaveBeenCalledWith({ wallet: mockWallet, spending: mockSpending });
    expect(byTestId(tree.root, 'names-owned-unchecked')).toBeNull();
    await close(tree);
  });

  it('says smart wallet when that is where the name points', async () => {
    mockLoadOwnedNames.mockResolvedValue({
      names: [{ name: 'ada', pointsAt: mockWallet, account: 'wallet', expiresAt: null }],
      complete: true,
    });

    const tree = await open();
    const shown = text(byTestId(tree.root, 'names-owned-ada') as Instance);
    expect(shown).toContain('arrives in your smart wallet');
    expect(shown).toContain(mockWallet);
    // An expiry that could not be read is left out, not invented.
    expect(shown).not.toContain('Yours until');
    await close(tree);
  });

  it('says it could not check, rather than looking like no name is held', async () => {
    mockLoadOwnedNames.mockResolvedValue({ names: [], complete: false });

    const tree = await open();
    expect(byTestId(tree.root, 'names-owned-unchecked')).not.toBeNull();
    await close(tree);
  });

  it('shows nothing extra to somebody who holds no name', async () => {
    mockLoadOwnedNames.mockResolvedValue({ names: [], complete: true });

    const tree = await open();
    expect(byTestId(tree.root, 'names-owned-unchecked')).toBeNull();
    expect(tree.root.findAllByProps({ children: 'YOU HOLD' })).toHaveLength(0);
    await close(tree);
  });
});
