import { useEffect, useRef, useState } from 'react';
import { Animated, Easing, Modal, Pressable, StyleSheet, View } from 'react-native';

import { useTheme } from '../hooks/useTheme';

/**
 * A panel that rises from the bottom edge, with the backdrop fading behind it.
 *
 * `Modal`'s own `animationType` gives you two wrong answers here. `"fade"` makes
 * the sheet appear in place, which reads as a dialog rather than something you
 * pulled up — the swap token picker did this, and it looked like a page swap.
 * `"slide"` moves the entire modal including the backdrop, so the dim arrives as
 * a sliding rectangle rather than a dimming of what is behind it.
 *
 * So the two are animated separately: opacity on the backdrop, translateY on the
 * panel.
 *
 * The `Modal`'s mount is driven from internal state rather than straight from
 * `visible`, because binding it to the prop unmounts the panel on the frame the
 * close begins and the exit animation is never seen.
 */
export function BottomSheet({
  visible,
  onClose,
  children,
  /** Accessibility label for the backdrop's dismiss target. */
  closeLabel = 'Close',
}: {
  visible: boolean;
  onClose: () => void;
  children: React.ReactNode;
  closeLabel?: string;
}) {
  const { colors, isDark } = useTheme();
  const [mounted, setMounted] = useState(visible);
  const anim = useRef(new Animated.Value(0)).current;

  useEffect(() => {
    if (visible) {
      setMounted(true);
      Animated.timing(anim, {
        toValue: 1,
        duration: 220,
        easing: Easing.out(Easing.cubic),
        useNativeDriver: true,
      }).start();
      return;
    }
    Animated.timing(anim, {
      toValue: 0,
      duration: 160,
      easing: Easing.in(Easing.cubic),
      useNativeDriver: true,
    }).start(({ finished }) => {
      if (finished) setMounted(false);
    });
  }, [visible, anim]);

  if (!mounted) return null;

  // Far enough to clear a tall sheet, so the panel is fully off-screen at rest
  // rather than peeking during the first frame.
  const translateY = anim.interpolate({ inputRange: [0, 1], outputRange: [560, 0] });

  return (
    <Modal visible transparent animationType="none" onRequestClose={onClose} statusBarTranslucent>
      <View style={styles.root}>
        <Animated.View style={[styles.backdrop, { opacity: anim }]}>
          <Pressable
            style={StyleSheet.absoluteFill}
            onPress={onClose}
            accessibilityRole="button"
            accessibilityLabel={closeLabel}
          />
        </Animated.View>

        <Animated.View
          style={[
            styles.panel,
            {
              backgroundColor: isDark ? colors.surfaceRaised : '#FFFFFF',
              borderColor: colors.border,
              transform: [{ translateY }],
            },
          ]}
        >
          <View style={[styles.grabber, { backgroundColor: colors.border }]} />
          {children}
        </Animated.View>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, justifyContent: 'flex-end' },
  backdrop: { ...StyleSheet.absoluteFillObject, backgroundColor: 'rgba(0,0,0,0.6)' },
  panel: {
    borderTopLeftRadius: 24,
    borderTopRightRadius: 24,
    borderTopWidth: StyleSheet.hairlineWidth,
    paddingHorizontal: 20,
    paddingTop: 10,
    paddingBottom: 36,
  },
  grabber: {
    alignSelf: 'center',
    width: 40,
    height: 4,
    borderRadius: 2,
    marginBottom: 14,
  },
});
