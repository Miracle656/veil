import { useEffect, useMemo, useRef, useState } from 'react';
import { StyleSheet, useWindowDimensions, View } from 'react-native';
import { Tabs } from 'expo-router';
import type { BottomTabBarProps } from '@react-navigation/bottom-tabs';
import Animated, {
  runOnJS,
  useAnimatedStyle,
  useReducedMotion,
  useSharedValue,
  withSpring,
  withTiming,
  type SharedValue,
} from 'react-native-reanimated';
import { Gesture, GestureDetector } from 'react-native-gesture-handler';

import { VeilTabBar } from '../../components/VeilTabBar';
import {
  AGENT_EDGE_WIDTH,
  SWIPE_ACTIVE_OFFSET_X,
  SWIPE_FAIL_OFFSET_Y,
  adjacentTab,
  resolveSwipe,
} from '../../lib/tabSwipe';

type NavHandle = { current: string | undefined; navigate: (name: string) => void };

/** Reduce-motion users get the tab change with no drag and no slide. */
const SLIDE_MS = 180;
/** A drag past the first or last tab moves this share of the finger distance. */
const EDGE_RESISTANCE = 0.25;

/**
 * Bottom tabs — Wallet / Earn / Agent / Settings, drawn by VeilTabBar as one
 * rounded pill with Swap sitting between Earn and Agent. Swap, Send and Receive
 * are push routes at the app root: they open over the tabs as full-screen flows
 * without the tab bar, reached from this bar and from the balance card.
 *
 * Swiping left or right moves between the four tabs in order and never reaches
 * Swap or the hidden prover-spike route. The whole tab area is one pan gesture,
 * so the screen follows the finger. The bar stays fixed while the content moves.
 *
 * Agent is the exception: the chat, its text box and its horizontal chip row
 * need the middle of the screen. On Agent only thin strips at each edge swipe,
 * so chat scrolling and the keyboard are left alone.
 */
export default function TabsLayout() {
  const { width } = useWindowDimensions();
  const reduceMotion = useReducedMotion();

  const [active, setActive] = useState<string | undefined>('dashboard');
  const onAgent = active === 'agent';

  // Written by the tab bar, read by the gesture. A ref, not state, because the
  // gesture reads it at the moment of release, not during render.
  const navRef = useRef<NavHandle | null>(null);

  const offset = useSharedValue(0);
  const canPrev = useSharedValue(false);
  const canNext = useSharedValue(false);

  useEffect(() => {
    canPrev.value = adjacentTab(active, -1) !== null;
    canNext.value = adjacentTab(active, 1) !== null;
  }, [active, canPrev, canNext]);

  const gestures = useMemo(() => {
    const go = (direction: 1 | -1) => {
      const target = adjacentTab(navRef.current?.current, direction);
      if (target) navRef.current?.navigate(target);
    };

    // Runs on the JS thread after the slide-out finishes. The new screen enters
    // from the side it was dragged from, which is the opposite of `target`.
    const commit = (direction: 1 | -1, target: number) => {
      go(direction);
      offset.value = -target;
      offset.value = withTiming(0, { duration: SLIDE_MS });
    };

    const make = (enabled: boolean) =>
      Gesture.Pan()
        .enabled(enabled)
        .activeOffsetX([-SWIPE_ACTIVE_OFFSET_X, SWIPE_ACTIVE_OFFSET_X])
        .failOffsetY([-SWIPE_FAIL_OFFSET_Y, SWIPE_FAIL_OFFSET_Y])
        .onUpdate((e) => {
          if (reduceMotion) return;
          const wantsNext = e.translationX < 0;
          const blocked = wantsNext ? !canNext.value : !canPrev.value;
          offset.value = blocked ? e.translationX * EDGE_RESISTANCE : e.translationX;
        })
        .onEnd((e) => {
          const direction = resolveSwipe(e.translationX, e.velocityX, width);
          const allowed = direction === 1 ? canNext.value : direction === -1 ? canPrev.value : false;
          if (!allowed) {
            offset.value = withSpring(0);
            return;
          }
          if (reduceMotion) {
            offset.value = 0;
            runOnJS(go)(direction as 1 | -1);
            return;
          }
          const target = direction === 1 ? -width : width;
          offset.value = withTiming(target, { duration: SLIDE_MS }, (finished) => {
            if (finished) runOnJS(commit)(direction as 1 | -1, target);
          });
        })
        .onFinalize((_e, success) => {
          // A cancelled pan (for example a vertical scroll that won) must not
          // leave the content dragged sideways.
          if (!success) offset.value = withSpring(0);
        });

    return {
      full: make(!onAgent),
      edgeLeft: make(onAgent),
      edgeRight: make(onAgent),
    };
  }, [onAgent, width, reduceMotion, offset, canPrev, canNext]);

  const contentStyle = useAnimatedStyle(() => ({
    transform: [{ translateX: offset.value }],
  }));

  return (
    <>
      <GestureDetector gesture={gestures.full}>
        <Animated.View style={[styles.fill, contentStyle]}>
          <Tabs
            tabBar={(props) => (
              <TabBarSlot
                {...props}
                offset={offset}
                onFocus={setActive}
                navRef={navRef}
              />
            )}
            screenOptions={{ headerShown: false }}
          >
            <Tabs.Screen name="dashboard" options={{ title: 'Home' }} />
            <Tabs.Screen name="earn" options={{ title: 'Earn' }} />
            <Tabs.Screen name="agent" options={{ title: 'Agent' }} />
            <Tabs.Screen name="settings" options={{ title: 'Settings' }} />
            <Tabs.Screen name="prover-spike" options={{ href: null }} />
          </Tabs>
        </Animated.View>
      </GestureDetector>

      {onAgent ? (
        <>
          <GestureDetector gesture={gestures.edgeLeft}>
            <View style={[styles.edge, styles.edgeLeft]} />
          </GestureDetector>
          <GestureDetector gesture={gestures.edgeRight}>
            <View style={[styles.edge, styles.edgeRight]} />
          </GestureDetector>
        </>
      ) : null}
    </>
  );
}

/**
 * Renders the Veil bar and reports the focused tab up to the layout. It draws
 * nothing on Agent, which takes the whole screen.
 */
function TabBarSlot({
  offset,
  onFocus,
  navRef,
  ...props
}: BottomTabBarProps & {
  offset: SharedValue<number>;
  onFocus: (name: string | undefined) => void;
  navRef: { current: NavHandle | null };
}) {
  const focused = props.state.routes[props.state.index]?.name;
  const { navigation } = props;

  useEffect(() => {
    onFocus(focused);
    navRef.current = {
      current: focused,
      navigate: (name: string) => navigation.navigate(name),
    };
  }, [focused, navigation, onFocus, navRef]);

  if (focused === 'agent') return null;
  return <VeilTabBar {...props} offset={offset} />;
}

const styles = StyleSheet.create({
  fill: {
    flex: 1,
  },
  edge: {
    position: 'absolute',
    top: 0,
    bottom: 0,
    width: AGENT_EDGE_WIDTH,
  },
  edgeLeft: {
    left: 0,
  },
  edgeRight: {
    right: 0,
  },
});
