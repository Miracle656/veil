import React from 'react';
import { Animated, StyleSheet, type StyleProp, type ViewStyle } from 'react-native';
import * as Haptics from 'expo-haptics';

import { Skeleton } from '../Skeleton';
import { SuccessAnimation } from '../SuccessAnimation';
import { VeilLogoAnimated } from '../VeilLogoAnimated';
import { BottomSheet } from '../BottomSheet';
import { useReduceMotion } from '../../hooks/useReduceMotion';

jest.mock('../../hooks/useReduceMotion', () => ({
  useReduceMotion: jest.fn(() => false),
}));

jest.mock('../../hooks/useTheme', () => ({
  useTheme: () => ({
    isDark: true,
    colors: {
      accent: '#FDDA24',
      onAccent: '#0B0B0F',
      textStrong: '#FFFFFF',
      textMuted: '#888888',
      surfaceRaised: '#1A1A22',
      border: '#333333',
    },
  }),
}));

jest.mock('expo-haptics', () => ({
  impactAsync: jest.fn(async () => undefined),
  notificationAsync: jest.fn(async () => undefined),
  ImpactFeedbackStyle: { Medium: 'medium' },
  NotificationFeedbackType: { Success: 'success' },
}));

type Instance = {
  props: Record<string, unknown>;
  children: (Instance | string)[];
};

type Renderer = {
  act: (fn: () => Promise<void> | void) => Promise<void> | void;
  create: (el: unknown) => {
    root: {
      findAll: (predicate: (node: Instance) => boolean) => Instance[];
    };
    unmount: () => void;
  };
};

// eslint-disable-next-line @typescript-eslint/no-require-imports
const renderer: Renderer = require('react-test-renderer');
const mockUseReduceMotion = useReduceMotion as jest.MockedFunction<typeof useReduceMotion>;

describe('Reduce motion support across animated components', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockUseReduceMotion.mockReturnValue(false);
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  describe('Skeleton', () => {
    it('follows useReduceMotion when prop is omitted', () => {
      const loopSpy = jest.spyOn(Animated, 'loop');

      mockUseReduceMotion.mockReturnValue(true);
      let tree!: ReturnType<Renderer['create']>;
      renderer.act(() => {
        tree = renderer.create(<Skeleton width={100} />);
      });
      expect(loopSpy).not.toHaveBeenCalled();
      renderer.act(() => {
        tree.unmount();
      });

      mockUseReduceMotion.mockReturnValue(false);
      renderer.act(() => {
        tree = renderer.create(<Skeleton width={100} />);
      });
      expect(loopSpy).toHaveBeenCalledTimes(1);
      renderer.act(() => {
        tree.unmount();
      });
    });

    it('allows caller to force reduceMotion either way', () => {
      const loopSpy = jest.spyOn(Animated, 'loop');

      mockUseReduceMotion.mockReturnValue(true);
      let tree!: ReturnType<Renderer['create']>;
      renderer.act(() => {
        tree = renderer.create(<Skeleton width={100} reduceMotion={false} />);
      });
      expect(loopSpy).toHaveBeenCalledTimes(1);
      renderer.act(() => {
        tree.unmount();
      });

      loopSpy.mockClear();
      mockUseReduceMotion.mockReturnValue(false);
      renderer.act(() => {
        tree = renderer.create(<Skeleton width={100} reduceMotion />);
      });
      expect(loopSpy).not.toHaveBeenCalled();
      renderer.act(() => {
        tree.unmount();
      });
    });
  });

  describe('SuccessAnimation', () => {
    it('shows finished state immediately and still fires success haptic when reduce motion is on', () => {
      mockUseReduceMotion.mockReturnValue(true);
      const springSpy = jest.spyOn(Animated, 'spring');
      const loopSpy = jest.spyOn(Animated, 'loop');

      let tree!: ReturnType<Renderer['create']>;
      renderer.act(() => {
        tree = renderer.create(<SuccessAnimation title="Sent" subtitle="All done" />);
      });

      expect(springSpy).not.toHaveBeenCalled();
      expect(loopSpy).not.toHaveBeenCalled();
      expect(Haptics.impactAsync).not.toHaveBeenCalled();
      expect(Haptics.notificationAsync).toHaveBeenCalledWith(
        Haptics.NotificationFeedbackType.Success,
      );

      renderer.act(() => {
        tree.unmount();
      });
    });

    it('runs the buzz and springs when reduce motion is off', () => {
      mockUseReduceMotion.mockReturnValue(false);
      const springSpy = jest.spyOn(Animated, 'spring');
      const loopSpy = jest.spyOn(Animated, 'loop');

      let tree!: ReturnType<Renderer['create']>;
      renderer.act(() => {
        tree = renderer.create(<SuccessAnimation title="Sent" />);
      });

      expect(springSpy).toHaveBeenCalled();
      expect(loopSpy).toHaveBeenCalled();
      expect(Haptics.impactAsync).toHaveBeenCalled();

      renderer.act(() => {
        tree.unmount();
      });
    });
  });

  describe('VeilLogoAnimated', () => {
    it('shows the finished logo with no staggered draw when reduce motion is on', () => {
      mockUseReduceMotion.mockReturnValue(true);
      const staggerSpy = jest.spyOn(Animated, 'stagger');

      let tree!: ReturnType<Renderer['create']>;
      renderer.act(() => {
        tree = renderer.create(<VeilLogoAnimated />);
      });

      expect(staggerSpy).not.toHaveBeenCalled();
      renderer.act(() => {
        tree.unmount();
      });
    });

    it('runs the staggered draw when reduce motion is off', () => {
      mockUseReduceMotion.mockReturnValue(false);
      const staggerSpy = jest.spyOn(Animated, 'stagger');

      let tree!: ReturnType<Renderer['create']>;
      renderer.act(() => {
        tree = renderer.create(<VeilLogoAnimated />);
      });

      expect(staggerSpy).toHaveBeenCalledTimes(1);
      renderer.act(() => {
        tree.unmount();
      });
    });
  });

  describe('BottomSheet', () => {
    it('fades in place instead of sliding when reduce motion is on', () => {
      mockUseReduceMotion.mockReturnValue(true);

      let tree!: ReturnType<Renderer['create']>;
      renderer.act(() => {
        tree = renderer.create(
          <BottomSheet visible onClose={jest.fn()}>
            <></>
          </BottomSheet>,
        );
      });

      const animatedViews = tree.root.findAll(
        (node) =>
          Boolean(node.props?.style) &&
          (StyleSheet.flatten(node.props.style as StyleProp<ViewStyle>) as ViewStyle | undefined)
            ?.borderTopLeftRadius === 24,
      );
      expect(animatedViews.length).toBeGreaterThanOrEqual(1);
      const panelStyle = StyleSheet.flatten(
        animatedViews[0].props.style as StyleProp<ViewStyle>,
      ) as Record<string, unknown>;
      expect(panelStyle.transform).toBeUndefined();
      expect(panelStyle.opacity).toBeDefined();

      renderer.act(() => {
        tree.unmount();
      });
    });

    it('slides up when reduce motion is off', () => {
      mockUseReduceMotion.mockReturnValue(false);

      let tree!: ReturnType<Renderer['create']>;
      renderer.act(() => {
        tree = renderer.create(
          <BottomSheet visible onClose={jest.fn()}>
            <></>
          </BottomSheet>,
        );
      });

      const animatedViews = tree.root.findAll(
        (node) =>
          Boolean(node.props?.style) &&
          (StyleSheet.flatten(node.props.style as StyleProp<ViewStyle>) as ViewStyle | undefined)
            ?.borderTopLeftRadius === 24,
      );
      expect(animatedViews.length).toBeGreaterThanOrEqual(1);
      const panelStyle = StyleSheet.flatten(
        animatedViews[0].props.style as StyleProp<ViewStyle>,
      ) as Record<string, unknown>;
      expect(panelStyle.transform).toBeDefined();

      renderer.act(() => {
        tree.unmount();
      });
    });
  });
});
