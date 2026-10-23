/**
 * #442 — a render crash anywhere must land on the branded fallback, report
 * through the (opt-in) Sentry path, and recover on retry — never a red box
 * over a white screen.
 *
 * Assertions walk the *committed* host tree (`toJSON`), not
 * `findAllByProps`: error recovery renders the boundary more than once per
 * pass, and react-test-renderer's instance traversal reports the superseded
 * pass alongside the committed one. What `toJSON` shows is what ships.
 */

import { Text } from 'react-native';

const mockCapture = jest.fn();
jest.mock('../lib/sentry', () => ({
  captureMobileError: (error: unknown) => mockCapture(error),
}));

import { ErrorBoundary } from '../components/ErrorBoundary';

type Json = { props?: Record<string, unknown>; children?: Json[] | string };

type Tree = {
  toJSON: () => Json | Json[] | null;
  root: { findByProps: (p: object) => { props: Record<string, unknown> } };
};

// No @types package ships for react-test-renderer; this is the slice used here.
type Renderer = {
  act: (fn: () => void) => void;
  create: (el: unknown) => Tree;
};
// eslint-disable-next-line @typescript-eslint/no-require-imports
const renderer: Renderer = require('react-test-renderer');

function walk(node: Json | Json[] | null | string | undefined, visit: (n: Json) => void): void {
  if (node == null || typeof node === 'string') return;
  if (Array.isArray(node)) {
    for (const child of node) walk(child, visit);
    return;
  }
  visit(node);
  for (const child of node.children ?? []) walk(child, visit);
}

/** How many elements with this testID are actually on screen. */
function countTestID(tree: Tree, testID: string): number {
  let count = 0;
  walk(tree.toJSON(), (node) => {
    if (node.props?.['testID'] === testID) count += 1;
  });
  return count;
}

/** Every literal string in the rendered tree, for content assertions. */
function allText(tree: Tree): string {
  const out: string[] = [];
  walk(tree.toJSON(), (node) => {
    for (const child of node.children ?? []) if (typeof child === 'string') out.push(child);
  });
  return out.join(' ');
}

let shouldThrow = true;

function Bomb(): React.ReactElement {
  if (shouldThrow) throw new Error('render exploded');
  return <Text>healed</Text>;
}

function render(boundary: React.ReactElement): Tree {
  let tree!: Tree;
  renderer.act(() => {
    tree = renderer.create(boundary);
  });
  return tree;
}

function press(tree: Tree, testID: string): void {
  // toJSON drops handlers, so reach for the instance to press: this is the
  // instance-view traversal, used only to find the node — never to assert.
  const target = tree.root.findByProps({ testID });
  renderer.act(() => {
    (target.props['onPress'] as () => void)();
  });
}

beforeEach(() => {
  mockCapture.mockReset();
  shouldThrow = true;
  // React logs every caught render error; this file asserts on them on
  // purpose, so the expected noise is not mistaken for a failure.
  jest.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
  jest.restoreAllMocks();
});

it('passes children through untouched while nothing throws', () => {
  shouldThrow = false;
  const tree = render(
    <ErrorBoundary>
      <Text>all good</Text>
    </ErrorBoundary>,
  );
  expect(countTestID(tree, 'error-boundary-fallback')).toBe(0);
  expect(allText(tree)).toContain('all good');
});

it('swaps in the fallback, reports the error, and recovers on retry', () => {
  const tree = render(
    <ErrorBoundary>
      <Bomb />
    </ErrorBoundary>,
  );

  expect(countTestID(tree, 'error-boundary-fallback')).toBe(1);
  expect(mockCapture).toHaveBeenCalledWith(expect.objectContaining({ message: 'render exploded' }));
  // The promise the fallback makes: signing happened nowhere near this error.
  expect(allText(tree)).toContain('untouched');

  // Retry with the flake gone: the boundary must re-render its children,
  // which is what turns a white screen back into the app.
  shouldThrow = false;
  press(tree, 'error-boundary-retry');
  expect(countTestID(tree, 'error-boundary-fallback')).toBe(0);
  expect(allText(tree)).toContain('healed');
});

it('keeps showing the fallback and re-reports if the re-render throws again', () => {
  const tree = render(
    <ErrorBoundary>
      <Bomb />
    </ErrorBoundary>,
  );
  press(tree, 'error-boundary-retry');
  expect(countTestID(tree, 'error-boundary-fallback')).toBe(1);
  expect(mockCapture).toHaveBeenCalledTimes(2);
});