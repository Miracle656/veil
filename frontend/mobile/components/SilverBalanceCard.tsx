import { useCallback, useMemo, useRef, useState } from 'react';
import { Animated, Pressable, StyleSheet, Text, View } from 'react-native';
import { Skeleton } from './Skeleton';
import { useRouter } from 'expo-router';
import { LinearGradient } from 'expo-linear-gradient';

import { useCurrency } from '../hooks/useCurrency';
import { useHiddenAmounts } from '../hooks/useHiddenAmounts';
import { fontFamily } from '../theme/typography';
import { formatUsd } from '../lib/fetchPrice';
import { VeilLogo } from './VeilLogo';
import { EyeIcon, EyeOffIcon, PaperPlaneIcon, ReceiveIcon } from './icons';

/** Ink used on the light silver face. */
const INK = '#0F0F0F';
const INK_55 = 'rgba(15,15,15,0.55)';
const INK_60 = 'rgba(15,15,15,0.6)';
// Only the loading/error placeholder is a fixed height — it has no content to
// measure. The real card measures itself; see `faceFront` below.
const PLACEHOLDER_HEIGHT = 208;

export type SilverBalanceCardProps = {
  /** Native balance string (XLM), or undefined while loading. */
  balance?: string;
  /** Fiat value in USD, or null when unpriced. */
  usd?: number | null;
  /**
   * The whole wallet in USD — every asset, both accounts — or null when any
   * holding is unpriced. When present it leads the card; when absent the card
   * falls back to the XLM figure rather than showing a sum that leaves an
   * asset out.
   */
  totalUsd?: number | null;
  /** Short line of the largest holdings, e.g. "412.98 USDC · 31 XLM". */
  breakdown?: string | null;
  loading?: boolean;
  error?: boolean;
  /** Reserved amount in XLM (locks base reserve and trustlines) */
  /** Explanation for why the amount is reserved */
};


/** Trim a raw balance string to at most 2 decimals for display. */
function trimAmount(raw: string): string {
  const n = Number(raw);
  if (!isFinite(n)) return raw;
  return n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

/** The brushed-metal face + diagonal shine, filling its parent. */
function Metal() {
  return (
    <>
      <LinearGradient
        colors={['#3a3d42', '#8f959c', '#e8ebee', '#9aa0a7', '#5c6066', '#caced3', '#75797f']}
        locations={[0, 0.22, 0.38, 0.52, 0.7, 0.88, 1]}
        start={{ x: 0, y: 0 }}
        end={{ x: 1, y: 1 }}
        style={StyleSheet.absoluteFill}
      />
      <LinearGradient
        colors={['transparent', 'rgba(255,255,255,0.55)', 'transparent']}
        locations={[0.38, 0.46, 0.55]}
        start={{ x: 0.05, y: 0 }}
        end={{ x: 0.75, y: 0.35 }}
        style={StyleSheet.absoluteFill}
      />
    </>
  );
}

/**
 * The home balance on a brushed-silver card (design "3a") — now a FLIP card.
 *
 * The face shows the whole wallet in the user's local currency (every asset,
 * both accounts) with the largest holdings underneath; tapping it flips the card
 * (a rotateY animation) to the XLM balance. When any holding is unpriced the
 * total is withheld and the card shows XLM on the front and its fiat value on
 * the back, as before. Send / Receive live on both faces. The
 * balance and its fiat value are real (dashboard balance × Lens price); the
 * "earning" chip is a static affordance until the live Blend yield lands.
 */
export function SilverBalanceCard({
  balance,
  usd = null,
  totalUsd = null,
  breakdown = null,
  loading,
  error,
}: SilverBalanceCardProps) {
  const router = useRouter();
  const { currency, format } = useCurrency();
  const { mask, hidden, toggle: toggleHidden } = useHiddenAmounts();
  const styles = useMemo(() => createStyles(), []);

  const flip = useRef(new Animated.Value(0)).current;
  const [flipped, setFlipped] = useState(false);

  const toggleFlip = useCallback(() => {
    const to = flipped ? 0 : 1;
    Animated.spring(flip, { toValue: to, useNativeDriver: true, friction: 9, tension: 12 }).start();
    setFlipped((f) => !f);
  }, [flip, flipped]);

  const frontRotate = flip.interpolate({ inputRange: [0, 1], outputRange: ['0deg', '180deg'] });
  const backRotate = flip.interpolate({ inputRange: [0, 1], outputRange: ['180deg', '360deg'] });

  const showLoading = !!loading && balance === undefined;
  const hasFiat = usd !== null && usd !== undefined;
  const cryptoText = balance !== undefined ? `${trimAmount(balance)} XLM` : '—';
  const fiatText = hasFiat ? format(usd) : '—';
  // Users read the front of this card as "what I have". XLM alone made a
  // wallet holding mostly USDC look nearly empty, so the all-asset total leads
  // whenever it is known, and the XLM view moves to the back.
  const hasTotal = totalUsd !== null && totalUsd !== undefined;


  // The whole card flips (Send/Receive included). Only the VISIBLE face is
  // interactive (pointerEvents + zIndex/elevation below): the turned-away face
  // is mirror-flipped and would otherwise steal taps / swap Send↔Receive.
  const face = (label: string, big: string, sub: string) => (
    <>
      <Metal />
      <View style={styles.headerRow}>
        <Text style={styles.label}>{label}</Text>
        <View style={styles.headerRight}>
          <Pressable
            onPress={toggleHidden}
            hitSlop={10}
            accessibilityRole="button"
            accessibilityLabel={hidden ? 'Show balance' : 'Hide balance'}
            style={({ pressed }) => [styles.eyeBtn, pressed && styles.pressed]}
          >
            {hidden ? <EyeOffIcon size={18} color={INK_55} /> : <EyeIcon size={18} color={INK_55} />}
          </Pressable>
          <VeilLogo size={26} color={INK} />
        </View>
      </View>
      <Pressable onPress={toggleFlip} accessibilityRole="button" accessibilityLabel="Flip balance" style={styles.balanceArea}>
        <Text
            style={styles.amount}
            numberOfLines={1}
            adjustsFontSizeToFit
            // Without a floor a long balance shrinks until it is unreadable;
            // 0.65 of 44 is ~28pt, which still reads as the headline figure.
            minimumFontScale={0.65}
          >
          {mask(big)}
        </Text>
        <Text style={styles.sub}>{hidden ? '••••' : sub}</Text>
        {/* The reserve explanation moved to the XLM asset page.
            "Reserved: 1.5 XLM (account base reserve)" never fit on one line
            here, and truncating it left a number whose reason was cut off —
            worse than not saying it. The asset page has room to explain. */}
      </Pressable>
      <View style={styles.actions}>
        <Pressable onPress={() => router.push('/send')} accessibilityRole="button" accessibilityLabel="Send" testID="dashboard-send" style={({ pressed }) => [styles.sendBtn, pressed && styles.pressed]}>
          <PaperPlaneIcon size={15} color="#FDDA24" />
          <Text style={styles.sendText}>Send</Text>
        </Pressable>
        <Pressable onPress={() => router.push('/receive')} accessibilityRole="button" accessibilityLabel="Receive" testID="dashboard-receive" style={({ pressed }) => [styles.receiveBtn, pressed && styles.pressed]}>
          <ReceiveIcon size={15} color={INK} strokeWidth={2} />
          <Text style={styles.receiveText}>Receive</Text>
        </Pressable>
      </View>
    </>
  );

  if (showLoading || error || balance === undefined) {
    return (
      <View style={styles.wrap}>
        <View style={styles.staticFace}>
          <Metal />
          <Text style={styles.label}>Total balance</Text>
          {error ? (
            <Text style={styles.errorText}>Couldn’t load your balance.</Text>
          ) : (
            <View style={styles.loadingRow}>
              {/* Shaped like the value that lands here — a wide amount and the
                  fiat line under it — so the card does not resize on load. */}
              <Skeleton width={168} height={30} radius={8} />
              <Skeleton width={96} height={13} radius={6} style={styles.loadingSub} />
            </View>
          )}
        </View>
      </View>
    );
  }

  return (
    <View style={styles.wrap}>
      <Animated.View
        pointerEvents={flipped ? 'none' : 'auto'}
        style={[styles.faceFront, { zIndex: flipped ? 0 : 2, elevation: flipped ? 0 : 12, transform: [{ perspective: 1400 }, { rotateY: frontRotate }] }]}
      >
        {hasTotal
          ? face('Total balance', format(totalUsd as number), breakdown ?? cryptoText)
          : face('Total balance', cryptoText, hasFiat ? `≈ ${format(usd)}` : 'no price yet')}
      </Animated.View>
      <Animated.View
        pointerEvents={flipped ? 'auto' : 'none'}
        style={[styles.faceBack, { zIndex: flipped ? 2 : 0, elevation: flipped ? 12 : 0, transform: [{ perspective: 1400 }, { rotateY: backRotate }] }]}
      >
        {hasTotal
          ? face('XLM', cryptoText, hasFiat ? `≈ ${format(usd)}` : 'no price yet')
          : face(`Balance · ${currency}`, fiatText, `≈ ${trimAmount(balance)} XLM`)}
      </Animated.View>
    </View>
  );
}


const createStyles = () =>
  StyleSheet.create({
    wrap: {
      // No fixed height. A number here has to be re-guessed every time the
      // card's contents change, and when the guess is low `overflow: 'hidden'`
      // silently eats the bottom padding and clips the Send/Receive row —
      // which is exactly what 208 did once the action row moved into the flow
      // and started taking up height of its own.
      position: 'relative',
    },
    // The FRONT face sits in normal flow, so the wrapper is exactly as tall as
    // the card's content — no slack above the buttons, nothing clipped below
    // them. A rotation does not affect layout, so the height holds while it
    // flips.
    faceFront: {
      borderRadius: 24,
      padding: 24,
      overflow: 'hidden',
      backfaceVisibility: 'hidden',
      shadowColor: '#000',
      shadowOffset: { width: 0, height: 18 },
      shadowOpacity: 0.5,
      shadowRadius: 40,
    },
    // The BACK face fills whatever the front measured. Both faces are built by
    // the same `face()` with the same rows, so they cannot disagree on height.
    faceBack: {
      ...StyleSheet.absoluteFillObject,
      borderRadius: 24,
      padding: 24,
      overflow: 'hidden',
      backfaceVisibility: 'hidden',
      shadowColor: '#000',
      shadowOffset: { width: 0, height: 18 },
      shadowOpacity: 0.5,
      shadowRadius: 40,
    },
    staticFace: {
      minHeight: PLACEHOLDER_HEIGHT,
      borderRadius: 24,
      padding: 24,
      overflow: 'hidden',
    },
    balanceArea: {
      // The tappable flip region (everything above the actions).
    },
    headerRow: {
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'space-between',
    },
    headerRight: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: 12,
    },
    eyeBtn: {
      width: 28,
      height: 28,
      alignItems: 'center',
      justifyContent: 'center',
    },
    label: {
      color: INK_55,
      fontFamily: fontFamily.bodySemiBold,
      fontSize: 11,
      letterSpacing: 1.2,
      textTransform: 'uppercase',
    },
    amount: {
      color: INK,
      fontFamily: fontFamily.heading,
      fontSize: 44,
      // No lineHeight on purpose: with `adjustsFontSizeToFit` a fixed line box
      // does not shrink with the font, so a long balance shrinks inside a 50pt
      // box and the glyphs come out visibly squashed on Android.
      marginTop: 10,
    },
    subRow: {
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'space-between',
      marginTop: 12,
    },
    sub: {
      color: INK_60,
      fontFamily: fontFamily.address,
      fontSize: 12,
      marginTop: 12,
    },
    earnChip: {
      backgroundColor: 'rgba(15,15,15,0.85)',
      borderRadius: 999,
      paddingHorizontal: 12,
      paddingVertical: 4,
    },
    earnChipText: {
      color: '#00E0F0',
      fontFamily: fontFamily.bodySemiBold,
      fontSize: 11,
    },
    loadingRow: {
      paddingVertical: 20,
      alignItems: 'flex-start',
    },
    loadingSub: {
      marginTop: 10,
    },
    errorText: {
      color: INK,
      fontFamily: fontFamily.body,
      fontSize: 14,
      marginTop: 12,
    },
    actions: {
      // In the flow, never absolutely positioned.
      //
      // Absolute meant the buttons floated OVER whatever was above them, so on
      // a funded wallet the reserve note ran underneath them and `overflow:
      // 'hidden'` clipped what stuck out. Nothing about the text was wrong; it
      // had nowhere to go. In the flow the text pushes the buttons down and
      // they can never overlap it.
      //
      // `auto` is kept so the row still sinks to the bottom if the card is ever
      // given a fixed height again. With the card sizing itself there is no
      // free space for it to claim, so it reads as 0 — which is the point: no
      // gap to open above the buttons.
      marginTop: 'auto',
      paddingTop: 16,
      flexDirection: 'row',
      gap: 10,
    },
    sendBtn: {
      flex: 1,
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'center',
      gap: 6,
      backgroundColor: INK,
      borderRadius: 999,
      paddingVertical: 9,
    },
    sendText: {
      color: '#FDDA24',
      fontFamily: fontFamily.bodySemiBold,
      fontSize: 13,
    },
    receiveBtn: {
      flex: 1,
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'center',
      gap: 6,
      borderWidth: 1.5,
      borderColor: INK_55,
      borderRadius: 999,
      paddingVertical: 7.5,
    },
    receiveText: {
      color: INK,
      fontFamily: fontFamily.bodySemiBold,
      fontSize: 13,
    },
    pressed: {
      opacity: 0.7,
    },
  });
