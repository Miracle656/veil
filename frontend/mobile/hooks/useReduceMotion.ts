import { useEffect, useState } from 'react';
import { AccessibilityInfo } from 'react-native';

/**
 * Subscribe to the OS "Reduce Motion" accessibility setting.
 *
 * Defaults to `false` until the initial async check resolves, then tracks
 * `reduceMotionChanged` events until unmount. Safe on web and in environments
 * where `AccessibilityInfo` methods are absent or unimplemented.
 */
export function useReduceMotion(): boolean {
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
        // Web or stubbed runtimes may not implement reduceMotionChanged.
      }
    }

    return () => {
      active = false;
      try {
        subscription?.remove?.();
      } catch {
        // Ignore cleanup errors on unsupported platforms.
      }
    };
  }, []);

  return reduceMotion;
}
