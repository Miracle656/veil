import { useEffect, useState } from 'react';
import { AccessibilityInfo } from 'react-native';

export type StackAnimation = 'slide_from_right' | 'fade';
export type TabAnimation = 'fade' | 'none';

export type ScreenTransitions = {
  /** Default transition for pushed stack screens (root, onboarding, privacy). */
  stack: StackAnimation;
  /** Transition for full-screen covers (lock, offline) that replace context. */
  cover: 'fade';
  /** Transition between bottom tabs. */
  tab: TabAnimation;
};

/**
 * Pure mapping from the OS reduce-motion flag to the app's navigator
 * transitions.
 *
 * When reduce motion is off, pushed screens slide in from the right on both
 * Android and iOS, cover screens (`lock`, `offline`) fade in, and tabs
 * cross-fade. When reduce motion is on, nothing slides.
 */
export function getTransitions(reduceMotion: boolean): ScreenTransitions {
  if (reduceMotion) {
    return {
      stack: 'fade',
      cover: 'fade',
      tab: 'none',
    };
  }
  return {
    stack: 'slide_from_right',
    cover: 'fade',
    tab: 'fade',
  };
}

/**
 * Subscribe to the OS "Reduce Motion" setting and return the matching screen
 * transitions for all four navigators.
 */
export function useTransitions(): ScreenTransitions {
  const [reduceMotion, setReduceMotion] = useState(false);

  useEffect(() => {
    let active = true;

    if (typeof AccessibilityInfo?.isReduceMotionEnabled === 'function') {
      Promise.resolve(AccessibilityInfo.isReduceMotionEnabled())
        .then((enabled) => {
          if (active) setReduceMotion(Boolean(enabled));
        })
        .catch(() => undefined);
    }

    let subscription: { remove?: () => void } | undefined;
    if (typeof AccessibilityInfo?.addEventListener === 'function') {
      try {
        subscription = AccessibilityInfo.addEventListener('reduceMotionChanged', (enabled) => {
          if (active) setReduceMotion(Boolean(enabled));
        });
      } catch {
        // Unsupported on web or stubbed runtimes.
      }
    }

    return () => {
      active = false;
      try {
        subscription?.remove?.();
      } catch {
        // Ignore cleanup errors.
      }
    };
  }, []);

  return getTransitions(reduceMotion);
}
