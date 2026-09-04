import { useEffect, useMemo, useRef, useState } from 'react';
import {
  Animated,
  Dimensions,
  Easing,
  Modal,
  PanResponder,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from 'react-native';

import { useTheme } from '../hooks/useTheme';
import type { ThemeColors } from '../lib/theme';
import { fontFamily } from '../theme/typography';
import { VeilLogo } from './VeilLogo';
import { BILL_SERVICES, type BillService } from './PayForGrid';

const PANEL_WIDTH = Math.min(320, Dimensions.get('window').width * 0.84);

/**
 * Decelerating curve — fast off the mark, long settle. Reads as the panel being
 * thrown rather than driven, which is what makes a drawer feel physical.
 */
const EASE_OUT = Easing.bezier(0.16, 1, 0.3, 1);
/** Closing is the reverse: unhurried start, quick exit. Shorter, so it never drags. */
const EASE_IN = Easing.bezier(0.4, 0, 1, 1);

const OPEN_MS = 380;
const CLOSE_MS = 230;

/** Past either threshold the drawer commits to closing instead of springing back. */
const DRAG_CLOSE_PX = 64;
const FLING_CLOSE_VX = -0.5;

/**
 * The services drawer, opened from the drape mark in the dashboard header.
 *
 * Everything Veil intends to offer but has not shipped lives here behind a
 * "coming soon" badge, so the Pay-for grid on the dashboard only ever shows
 * things that actually work. A tile that does nothing when tapped is worse
 * than one the user was told is not ready yet.
 *
 * Services move between the two surfaces by flipping `status` in
 * BILL_SERVICES — there is no second list to keep in sync.
 */
export function ServicesDrawer({
  visible,
  onClose,
  services = BILL_SERVICES,
}: {
  visible: boolean;
  onClose: () => void;
  services?: BillService[];
}) {
  const { colors } = useTheme();
  const styles = useMemo(() => createStyles(colors), [colors]);
  // One driver for the whole panel: 0 closed, 1 open. Rows read off the same
  // value at staggered offsets, so the reveal cannot desynchronise from the
  // slide however the animation is interrupted.
  const anim = useRef(new Animated.Value(0)).current;
  // Live finger offset, added to the panel's resting position.
  const drag = useRef(new Animated.Value(0)).current;

  // The Modal's own mount is driven from here, not from `visible` directly.
  // Binding it straight to the prop tears the panel off the screen on the same
  // frame the close begins, so the exit animation is never seen — and because
  // a native-driven value does not sync back to JS when its view unmounts
  // mid-animation, `anim` would then be stranded at 1 and the next open would
  // animate from 1 to 1, i.e. not at all.
  const [mounted, setMounted] = useState(visible);

  useEffect(() => {
    if (visible) {
      // Never trust the previous run to have left these at rest.
      anim.setValue(0);
      drag.setValue(0);
      setMounted(true);
      return;
    }
    // Play the exit first, unmount only once it has finished.
    Animated.timing(anim, {
      toValue: 0,
      duration: CLOSE_MS,
      easing: EASE_IN,
      useNativeDriver: true,
    }).start(({ finished }) => {
      if (finished) setMounted(false);
    });
  }, [visible, anim, drag]);

  // Entrance runs a frame after the Modal has actually put the panel on screen,
  // so the first frames of the curve are not spent on a view that is not there.
  useEffect(() => {
    if (!mounted || !visible) return;
    const frame = requestAnimationFrame(() => {
      Animated.timing(anim, {
        toValue: 1,
        duration: OPEN_MS,
        easing: EASE_OUT,
        useNativeDriver: true,
      }).start();
    });
    return () => cancelAnimationFrame(frame);
  }, [mounted, visible, anim]);

  const pan = useRef(
    PanResponder.create({
      // Claim the gesture only once it is clearly a leftward drag, so vertical
      // scrolling inside the list still belongs to the ScrollView.
      onMoveShouldSetPanResponder: (_e, g) =>
        g.dx < -6 && Math.abs(g.dx) > Math.abs(g.dy) * 1.4,
      // Rightward pull is ignored — the panel is already at its open stop.
      onPanResponderMove: (_e, g) => drag.setValue(Math.min(0, g.dx)),
      onPanResponderRelease: (_e, g) => {
        if (g.dx < -DRAG_CLOSE_PX || g.vx < FLING_CLOSE_VX) {
          // Carry the fling through rather than snapping: animate the remaining
          // distance, then let the parent unmount us.
          Animated.timing(drag, {
            toValue: -PANEL_WIDTH,
            duration: 170,
            easing: EASE_IN,
            useNativeDriver: true,
          }).start(() => {
            // Hand the panel over to `anim` at exactly the offset the drag left
            // it at — anim 0 and drag 0 put it in the same place as anim 1 and
            // drag -PANEL_WIDTH — so the handover costs no visible frame and
            // the close effect has nothing left to animate.
            drag.setValue(0);
            anim.setValue(0);
            onClose();
          });
        } else {
          Animated.spring(drag, {
            toValue: 0,
            damping: 20,
            stiffness: 220,
            mass: 0.7,
            useNativeDriver: true,
          }).start();
        }
      },
    }),
  ).current;

  const panelX = Animated.add(
    anim.interpolate({ inputRange: [0, 1], outputRange: [-PANEL_WIDTH, 0] }),
    drag,
  );

  // The backdrop tracks the drag too, so pulling the panel back also lifts the
  // dimming — the two never look detached from each other.
  const backdropOpacity = Animated.multiply(
    anim,
    drag.interpolate({
      inputRange: [-PANEL_WIDTH, 0],
      outputRange: [0, 1],
      extrapolate: 'clamp',
    }),
  );

  const live = services.filter((s) => s.status === 'live');
  const soon = services.filter((s) => s.status !== 'live');
  const ordered = [...live, ...soon];

  return (
    <Modal
      visible={mounted}
      transparent
      animationType="none"
      onRequestClose={onClose}
      statusBarTranslucent
    >
      <View style={styles.root}>
        <Animated.View style={[styles.backdrop, { opacity: backdropOpacity }]}>
          <Pressable
            style={StyleSheet.absoluteFill}
            onPress={onClose}
            accessibilityRole="button"
            accessibilityLabel="Close services menu"
          />
        </Animated.View>

        <Animated.View
          {...pan.panHandlers}
          style={[styles.panel, { transform: [{ translateX: panelX }] }]}
        >
          <View style={styles.header}>
            <View style={styles.brand}>
              <VeilLogo size={22} color={colors.accent} />
              <Text style={styles.wordmark}>VEIL</Text>
            </View>
            <Pressable
              onPress={onClose}
              accessibilityRole="button"
              accessibilityLabel="Close"
              hitSlop={12}
              style={({ pressed }) => [styles.close, pressed && styles.pressed]}
            >
              <Text style={styles.closeGlyph}>×</Text>
            </Pressable>
          </View>

          <ScrollView contentContainerStyle={styles.body} showsVerticalScrollIndicator={false}>
            {live.length > 0 ? (
              <>
                <Stagger anim={anim} index={0}>
                  <Text style={styles.sectionLabel}>Available</Text>
                </Stagger>
                {live.map((s) => (
                  <Stagger key={s.id} anim={anim} index={ordered.indexOf(s) + 1}>
                    <Row service={s} colors={colors} styles={styles} />
                  </Stagger>
                ))}
              </>
            ) : null}

            <Stagger anim={anim} index={live.length}>
              <Text style={[styles.sectionLabel, live.length > 0 && styles.sectionLabelSpaced]}>
                Coming soon
              </Text>
            </Stagger>
            {soon.map((s) => (
              <Stagger key={s.id} anim={anim} index={ordered.indexOf(s) + 1}>
                <Row service={s} colors={colors} styles={styles} soon />
              </Stagger>
            ))}

            <Stagger anim={anim} index={ordered.length + 1}>
              <Text style={styles.footnote}>
                These arrive as each provider goes live. Nothing here is chargeable yet.
              </Text>
            </Stagger>
          </ScrollView>

          {/* Grab rail — the only hint that the panel can be pushed away. */}
          <View style={styles.grabRail} pointerEvents="none" />
        </Animated.View>
      </View>
    </Modal>
  );
}

/**
 * Reveals its child slightly after the panel starts moving, offset by index so
 * the list cascades in behind the slide. Driven off the panel's own value
 * rather than a timer, so an interrupted open never strands a row half-faded.
 */
function Stagger({
  anim,
  index,
  children,
}: {
  anim: Animated.Value;
  index: number;
  children: React.ReactNode;
}) {
  // Cap the ramp so even a long list finishes with the slide rather than after it.
  const start = Math.min(0.18 + index * 0.055, 0.82);
  const range = { inputRange: [start, Math.min(start + 0.3, 1)], extrapolate: 'clamp' as const };

  return (
    <Animated.View
      style={{
        opacity: anim.interpolate({ ...range, outputRange: [0, 1] }),
        transform: [
          { translateX: anim.interpolate({ ...range, outputRange: [-18, 0] }) },
          { scale: anim.interpolate({ ...range, outputRange: [0.97, 1] }) },
        ],
      }}
    >
      {children}
    </Animated.View>
  );
}

function Row({
  service,
  colors,
  styles,
  soon = false,
}: {
  service: BillService;
  colors: ThemeColors;
  styles: ReturnType<typeof createStyles>;
  soon?: boolean;
}) {
  return (
    <View style={styles.row} accessibilityLabel={`${service.label}${soon ? ', coming soon' : ''}`}>
      <View style={[styles.rowIcon, soon && styles.rowIconSoon]}>
        <service.Icon size={18} color={soon ? colors.textMuted : colors.textPrimary} />
      </View>
      <View style={styles.rowText}>
        <Text style={[styles.rowLabel, soon && styles.rowLabelSoon]}>{service.label}</Text>
        <Text style={styles.rowHint} numberOfLines={1}>
          {service.hint}
        </Text>
      </View>
      {soon ? (
        <View style={styles.badge}>
          <Text style={styles.badgeText}>SOON</Text>
        </View>
      ) : null}
    </View>
  );
}

const createStyles = (colors: ThemeColors) =>
  StyleSheet.create({
    root: { flex: 1, flexDirection: 'row' },
    backdrop: { ...StyleSheet.absoluteFillObject, backgroundColor: 'rgba(0,0,0,0.55)' },
    panel: {
      width: PANEL_WIDTH,
      height: '100%',
      backgroundColor: colors.background,
      borderRightWidth: 1,
      borderRightColor: colors.border,
      paddingTop: 56,
      // Depth: without it the panel reads as a flat region of the same screen
      // rather than a sheet lifted above it.
      ...Platform.select({
        ios: {
          shadowColor: '#000',
          shadowOpacity: 0.45,
          shadowRadius: 24,
          shadowOffset: { width: 8, height: 0 },
        },
        android: { elevation: 24 },
        default: {},
      }),
    },
    grabRail: {
      position: 'absolute',
      right: 3,
      top: '42%',
      width: 3,
      height: 46,
      borderRadius: 999,
      backgroundColor: colors.border,
      opacity: 0.9,
    },
    header: {
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'space-between',
      paddingHorizontal: 20,
      paddingBottom: 18,
      borderBottomWidth: 1,
      borderBottomColor: colors.border,
    },
    brand: { flexDirection: 'row', alignItems: 'center' },
    wordmark: {
      fontFamily: fontFamily.accent,
      fontSize: 19,
      letterSpacing: 1.5,
      color: colors.accent,
      marginLeft: 8,
    },
    close: {
      width: 32,
      height: 32,
      borderRadius: 999,
      alignItems: 'center',
      justifyContent: 'center',
      backgroundColor: colors.surface,
    },
    closeGlyph: { fontSize: 22, lineHeight: 24, color: colors.textSecondary },
    pressed: { opacity: 0.6 },
    body: { paddingHorizontal: 16, paddingTop: 18, paddingBottom: 40 },
    sectionLabel: {
      fontFamily: fontFamily.accent,
      fontSize: 11,
      letterSpacing: 1.6,
      textTransform: 'uppercase',
      color: colors.textFaint,
      marginBottom: 10,
      marginLeft: 4,
    },
    sectionLabelSpaced: { marginTop: 22 },
    row: {
      flexDirection: 'row',
      alignItems: 'center',
      paddingVertical: 11,
      paddingHorizontal: 4,
    },
    rowIcon: {
      width: 38,
      height: 38,
      borderRadius: 12,
      alignItems: 'center',
      justifyContent: 'center',
      backgroundColor: colors.surfaceMd,
    },
    rowIconSoon: { backgroundColor: colors.surface },
    rowText: { flex: 1, marginLeft: 12 },
    rowLabel: {
      fontFamily: fontFamily.bodySemiBold,
      fontSize: 15,
      color: colors.textStrong,
    },
    rowLabelSoon: { color: colors.textSecondary },
    rowHint: {
      fontFamily: fontFamily.body,
      fontSize: 12,
      color: colors.textMuted,
      marginTop: 2,
    },
    badge: {
      paddingHorizontal: 8,
      paddingVertical: 3,
      borderRadius: 999,
      backgroundColor: colors.surface,
      borderWidth: 1,
      borderColor: colors.border,
    },
    badgeText: {
      fontFamily: fontFamily.address,
      fontSize: 9.5,
      letterSpacing: 1,
      color: colors.textFaint,
    },
    footnote: {
      fontFamily: fontFamily.body,
      fontSize: 11.5,
      lineHeight: 17,
      color: colors.textFaint,
      marginTop: 26,
      marginHorizontal: 4,
    },
  });
