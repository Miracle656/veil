import React from 'react';
import { AccessibilityInfo } from 'react-native';

import { getTransitions, useTransitions, type ScreenTransitions } from '../transitions';

type Renderer = {
  act: (fn: () => Promise<void> | void) => Promise<void> | void;
  create: (el: unknown) => {
    unmount: () => void;
  };
};

// eslint-disable-next-line @typescript-eslint/no-require-imports
const renderer: Renderer = require('react-test-renderer');

function Harness({ onValue }: { onValue: (value: ScreenTransitions) => void }) {
  const value = useTransitions();
  onValue(value);
  return null;
}

describe('transitions', () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  describe('getTransitions', () => {
    it('uses slide_from_right for stacks and fade for covers and tabs when reduce motion is off', () => {
      expect(getTransitions(false)).toEqual({
        stack: 'slide_from_right',
        cover: 'fade',
        tab: 'fade',
      });
    });

    it('uses fade or none everywhere and never slides when reduce motion is on', () => {
      const result = getTransitions(true);
      expect(result).toEqual({
        stack: 'fade',
        cover: 'fade',
        tab: 'none',
      });
      expect(result.stack).not.toContain('slide');
    });
  });

  describe('useTransitions', () => {
    it('returns non-reduced transitions when reduce motion is off', async () => {
      const remove = jest.fn();
      jest.spyOn(AccessibilityInfo, 'isReduceMotionEnabled').mockResolvedValue(false);
      jest
        .spyOn(AccessibilityInfo, 'addEventListener')
        .mockReturnValue({ remove } as unknown as ReturnType<
          typeof AccessibilityInfo.addEventListener
        >);

      let latest!: ScreenTransitions;
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

      expect(latest).toEqual(getTransitions(false));
      renderer.act(() => {
        tree.unmount();
      });
      expect(remove).toHaveBeenCalledTimes(1);
    });

    it('switches to reduced transitions when reduce motion is on or changes while mounted', async () => {
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

      let latest!: ScreenTransitions;
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

      expect(latest).toEqual(getTransitions(false));

      renderer.act(() => {
        changeHandler?.(true);
      });
      expect(latest).toEqual(getTransitions(true));

      renderer.act(() => {
        tree.unmount();
      });
      expect(remove).toHaveBeenCalledTimes(1);
    });
  });
});
