import { useEffect, useRef, useState } from 'react';
import { AccessibilityInfo, Animated, Appearance, Image, StyleSheet, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import {
  BRAND_NAME,
  MAKER_NAME,
  MAKER_PREFIX,
  SPLASH_FAILSAFE_MS,
  SPLASH_IMAGE_WIDTH,
  SPLASH_TIMING,
  splashPalette,
} from '../lib/brandSplash';
import { fontFamily } from '../theme/typography';

// The very files the native splash draws, so the mark is identical to the pixel.
const MARK = {
  light: require('../assets/images/splash-icon-light.png'),
  dark: require('../assets/images/splash-icon-dark.png'),
} as const;

/**
 * The opening screen. See lib/brandSplash.ts for what it is and why it is
 * built this way. Mount it once, above the rest of the app; it removes itself.
 */
export function BrandSplash({ onDone }: { onDone?: () => void }) {
  const insets = useSafeAreaInsets();
  // Read once: the native splash did not change with the phone's setting
  // half-way through either.
  const palette = useRef(splashPalette(Appearance.getColorScheme())).current;
  const text = useRef(new Animated.Value(0)).current;
  const screen = useRef(new Animated.Value(1)).current;
  const [gone, setGone] = useState(false);
  const finished = useRef(false);

  useEffect(() => {
    let cancelled = false;
    const finish = () => {
      if (finished.current) return;
      finished.current = true;
      setGone(true);
      onDone?.();
    };

    // Whatever the animation does, the screen comes down.
    const failsafe = setTimeout(finish, SPLASH_FAILSAFE_MS);

    let holdTimer: ReturnType<typeof setTimeout> | undefined;
    let animation: Animated.CompositeAnimation | undefined;

    const run = (reduceMotion: boolean) => {
      if (cancelled) return;
      if (reduceMotion) {
        // No fades: show everything at once, hold, then cut to the app.
        text.setValue(1);
        holdTimer = setTimeout(finish, SPLASH_TIMING.textIn + SPLASH_TIMING.hold);
        return;
      }
      animation = Animated.sequence([
        Animated.timing(text, { toValue: 1, duration: SPLASH_TIMING.textIn, useNativeDriver: true }),
        Animated.delay(SPLASH_TIMING.hold),
        Animated.timing(screen, { toValue: 0, duration: SPLASH_TIMING.out, useNativeDriver: true }),
      ]);
      animation.start(finish);
    };

    AccessibilityInfo.isReduceMotionEnabled()
      .then(run)
      .catch(() => run(false));

    return () => {
      // Unmounted from outside: nothing may fire afterwards, onDone included.
      cancelled = true;
      finished.current = true;
      clearTimeout(failsafe);
      if (holdTimer) clearTimeout(holdTimer);
      animation?.stop();
    };
    // Runs once, on mount.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  if (gone) return null;

  return (
    <Animated.View
      testID="brand-splash"
      accessible
      accessibilityRole="image"
      accessibilityLabel={`${BRAND_NAME}, ${MAKER_PREFIX} ${MAKER_NAME}`}
      style={[StyleSheet.absoluteFill, styles.screen, { backgroundColor: palette.background, opacity: screen }]}
    >
      {/* Centred on the full window, exactly where the native splash put it. */}
      <View style={styles.centre} pointerEvents="none">
        <Image source={MARK[palette.scheme]} style={styles.mark} resizeMode="contain" />
        {/* Hung below the centre rather than stacked with the mark, so adding
            the name does not push the mark up. */}
        <Animated.Text
          style={[styles.name, { color: palette.name, opacity: text }]}
          allowFontScaling={false}
        >
          {BRAND_NAME}
        </Animated.Text>
      </View>

      <Animated.View
        pointerEvents="none"
        style={[styles.maker, { bottom: Math.max(insets.bottom, 16) + 28, opacity: text }]}
      >
        <Text style={[styles.makerPrefix, { color: palette.makerPrefix }]} allowFontScaling={false}>
          {MAKER_PREFIX}
        </Text>
        <Text style={[styles.makerName, { color: palette.makerName }]} allowFontScaling={false}>
          {MAKER_NAME}
        </Text>
      </Animated.View>
    </Animated.View>
  );
}

const styles = StyleSheet.create({
  screen: {
    // Above every screen, sheet and banner in the app.
    zIndex: 9999,
    elevation: 9999,
  },
  centre: {
    ...StyleSheet.absoluteFillObject,
    alignItems: 'center',
    justifyContent: 'center',
  },
  mark: {
    width: SPLASH_IMAGE_WIDTH,
    height: SPLASH_IMAGE_WIDTH,
  },
  name: {
    position: 'absolute',
    // Half the image, less the empty margin the image carries below the mark.
    top: '50%',
    marginTop: SPLASH_IMAGE_WIDTH / 2 - 44,
    fontFamily: fontFamily.heading,
    fontSize: 40,
    lineHeight: 48,
    letterSpacing: 0.5,
  },
  maker: {
    position: 'absolute',
    left: 0,
    right: 0,
    alignItems: 'center',
  },
  makerPrefix: {
    fontFamily: fontFamily.body,
    fontSize: 14,
    lineHeight: 18,
    marginBottom: 4,
  },
  makerName: {
    fontFamily: fontFamily.bodySemiBold,
    fontSize: 18,
    lineHeight: 24,
    letterSpacing: 0.2,
  },
});
