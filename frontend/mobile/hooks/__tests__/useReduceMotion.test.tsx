import React from 'react';
import { AccessibilityInfo } from 'react-native';

import { useReduceMotion } from '../useReduceMotion';

type Renderer = {
  act: (fn: () => Promise<void> | void) => Promise<void> | void;
  create: (el: unknown) => {
    unmount: () => void;
  };
};

// eslint-disable-next-line @typescript-eslint/no-require-imports
const renderer: Renderer = require('react-test-renderer');

function Harness({ onValue }: { onValue: (value: boolean) => void }) {
  const value = useReduceMotion();
  onValue(value);
  return null;
}

describe('useReduceMotion', () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('returns true when reduce motion is initially enabled', async () => {
    const remove = jest.fn();
    jest.spyOn(AccessibilityInfo, 'isReduceMotionEnabled').mockResolvedValue(true);
    jest
      .spyOn(AccessibilityInfo, 'addEventListener')
      .mockReturnValue({ remove } as unknown as ReturnType<
        typeof AccessibilityInfo.addEventListener
      >);

    let latest = false;
    let tree!: ReturnType<Renderer['create']>;
    await renderer.act(async () => {
      tree = renderer.create(
        <Harness
          onValue={(v) => {
            latest = v;
          }}
        />,
      );
      await Promise.resolve();
    });

    expect(latest).toBe(true);
    renderer.act(() => {
      tree.unmount();
    });
  });

  it('returns false when reduce motion is initially disabled', async () => {
    const remove = jest.fn();
    jest.spyOn(AccessibilityInfo, 'isReduceMotionEnabled').mockResolvedValue(false);
    jest
      .spyOn(AccessibilityInfo, 'addEventListener')
      .mockReturnValue({ remove } as unknown as ReturnType<
        typeof AccessibilityInfo.addEventListener
      >);

    let latest = true;
    let tree!: ReturnType<Renderer['create']>;
    await renderer.act(async () => {
      tree = renderer.create(
        <Harness
          onValue={(v) => {
            latest = v;
          }}
        />,
      );
      await Promise.resolve();
    });

    expect(latest).toBe(false);
    renderer.act(() => {
      tree.unmount();
    });
  });

  it('updates when reduceMotionChanged fires while mounted and removes listener on unmount', async () => {
    const remove = jest.fn();
    let changeHandler: ((enabled: boolean) => void) | undefined;

    jest.spyOn(AccessibilityInfo, 'isReduceMotionEnabled').mockResolvedValue(false);
    jest.spyOn(AccessibilityInfo, 'addEventListener').mockImplementation(((
      event: string,
      handler: unknown,
    ) => {
      if (event === 'reduceMotionChanged') {
        changeHandler = handler as (enabled: boolean) => void;
      }
      return { remove };
    }) as unknown as typeof AccessibilityInfo.addEventListener);

    let latest = false;
    let tree!: ReturnType<Renderer['create']>;
    await renderer.act(async () => {
      tree = renderer.create(
        <Harness
          onValue={(v) => {
            latest = v;
          }}
        />,
      );
      await Promise.resolve();
    });

    expect(latest).toBe(false);
    expect(changeHandler).toBeDefined();

    renderer.act(() => {
      changeHandler?.(true);
    });
    expect(latest).toBe(true);

    renderer.act(() => {
      changeHandler?.(false);
    });
    expect(latest).toBe(false);

    expect(remove).not.toHaveBeenCalled();
    renderer.act(() => {
      tree.unmount();
    });
    expect(remove).toHaveBeenCalledTimes(1);
  });

  it('does not throw when AccessibilityInfo methods are missing or fail (e.g. web)', async () => {
    const originalIsEnabled = AccessibilityInfo.isReduceMotionEnabled;
    const originalAddListener = AccessibilityInfo.addEventListener;

    (AccessibilityInfo as unknown as Record<string, unknown>).isReduceMotionEnabled = undefined;
    (AccessibilityInfo as unknown as Record<string, unknown>).addEventListener = undefined;

    let latest = true;
    let tree!: ReturnType<Renderer['create']>;
    await renderer.act(async () => {
      tree = renderer.create(
        <Harness
          onValue={(v) => {
            latest = v;
          }}
        />,
      );
      await Promise.resolve();
    });

    expect(latest).toBe(false);
    renderer.act(() => {
      tree.unmount();
    });

    AccessibilityInfo.isReduceMotionEnabled = originalIsEnabled;
    AccessibilityInfo.addEventListener = originalAddListener;
  });
});
