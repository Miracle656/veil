import React from 'react';
import { AccessibilityInfo, Appearance } from 'react-native';

import { SPLASH_FAILSAFE_MS, SPLASH_TIMING, SPLASH_TOTAL_MS } from '../../lib/brandSplash';
import { BrandSplash } from '../BrandSplash';

// react-test-renderer ships no types; this is the part of it used here, as
// the other component tests in this folder declare it.
interface ReactTestRenderer {
  toJSON(): unknown;
  unmount(): void;
}
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { act, create } = require('react-test-renderer') as {
  act: (fn: () => Promise<void>) => Promise<void>;
  create: (element: React.ReactElement) => ReactTestRenderer;
};

jest.mock('react-native-safe-area-context', () => ({
  useSafeAreaInsets: () => ({ top: 0, bottom: 24, left: 0, right: 0 }),
}));

function texts(tree: ReactTestRenderer): string[] {
  const out: string[] = [];
  const walk = (node: unknown) => {
    if (typeof node === 'string') out.push(node);
    else if (Array.isArray(node)) node.forEach(walk);
    else if (node && typeof node === 'object') walk((node as { children?: unknown }).children);
  };
  walk(tree.toJSON());
  return out;
}

async function mount(onDone = jest.fn()) {
  let tree!: ReactTestRenderer;
  await act(async () => {
    tree = create(<BrandSplash onDone={onDone} />);
  });
  return { tree, onDone };
}

describe('BrandSplash', () => {
  beforeEach(() => {
    jest.useFakeTimers();
    jest.spyOn(Appearance, 'getColorScheme').mockReturnValue('dark');
    jest.spyOn(AccessibilityInfo, 'isReduceMotionEnabled').mockResolvedValue(false);
  });

  afterEach(() => {
    jest.useRealTimers();
    jest.restoreAllMocks();
  });

  it('shows the name and who it is from', async () => {
    const { tree } = await mount();
    expect(texts(tree)).toEqual(['Veil', 'from', 'Divinity Labs']);
  });

  it('removes itself and reports it, once', async () => {
    const { tree, onDone } = await mount();
    expect(tree.toJSON()).not.toBeNull();
    await act(async () => {
      jest.advanceTimersByTime(SPLASH_FAILSAFE_MS + 50);
    });
    expect(tree.toJSON()).toBeNull();
    expect(onDone).toHaveBeenCalledTimes(1);
  });

  // Timed on the reduced-motion path, which runs on a plain timer. The test
  // environment does not play animations at their real speed.
  it('is still up just before its time is over', async () => {
    (AccessibilityInfo.isReduceMotionEnabled as jest.Mock).mockResolvedValue(true);
    const { tree } = await mount();
    await act(async () => {
      jest.advanceTimersByTime(SPLASH_TIMING.textIn + SPLASH_TIMING.hold - 50);
    });
    expect(tree.toJSON()).not.toBeNull();
  });

  it('with reduced motion, holds and then cuts away with no fade', async () => {
    (AccessibilityInfo.isReduceMotionEnabled as jest.Mock).mockResolvedValue(true);
    const { tree, onDone } = await mount();
    await act(async () => {
      jest.advanceTimersByTime(SPLASH_TIMING.textIn + SPLASH_TIMING.hold + 10);
    });
    expect(tree.toJSON()).toBeNull();
    expect(onDone).toHaveBeenCalledTimes(1);
  });

  it('still comes down if the reduced-motion check fails', async () => {
    (AccessibilityInfo.isReduceMotionEnabled as jest.Mock).mockRejectedValue(new Error('unavailable'));
    const { tree } = await mount();
    await act(async () => {
      jest.advanceTimersByTime(SPLASH_FAILSAFE_MS + 50);
    });
    expect(tree.toJSON()).toBeNull();
  });

  it('does not call back after it has been unmounted early', async () => {
    const { tree, onDone } = await mount();
    await act(async () => {
      tree.unmount();
    });
    await act(async () => {
      jest.advanceTimersByTime(SPLASH_TOTAL_MS + SPLASH_FAILSAFE_MS);
    });
    expect(onDone).not.toHaveBeenCalled();
  });
});
