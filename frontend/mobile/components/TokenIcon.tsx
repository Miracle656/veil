import { Image, StyleSheet, Text, View } from 'react-native';
import Svg, { Rect } from 'react-native-svg';

/**
 * A round asset logo — the real XLM / USDC / EURC marks lifted from the web
 * wallet's `public/tokens`, a drawn mark for USDT0, and a lettered gold-tint
 * fallback for everything else.
 *
 * XLM's mark is a monochrome silhouette, so it's tinted white on a black disc
 * (matching the web's invert-on-black treatment); the others are already full
 * colour circular logos and render as-is.
 */

// Bundled at build time by Metro.
const XLM = require('../assets/tokens/xlm.png');
const USDC = require('../assets/tokens/usdc.png');
const EURC = require('../assets/tokens/eurc.png');

// EURC shipped in the bundle but was never mapped, so a EURC holder got the
// lettered "E" with the real logo sitting unused a directory away.
const LOGOS: Record<string, number> = { XLM, USDC, EURC };

/** Tether's green. The mark below is the ₮ letterform, drawn rather than shipped. */
const TETHER_GREEN = '#26A17B';

/**
 * USDT0 has no bundled PNG, and unlike every other registry asset it cannot get
 * one the usual way: its issuer
 * (GATISXX6BZ6NC7IKQBY37CJD4SOZL3CYZJWXEDG6JVIY4WBS6KXJHN6Q) publishes no
 * home_domain at all, so there is no stellar.toml to read a logo URL from — the
 * same gap that makes the registry pin, not domain verification, the only thing
 * telling the real USDT0 from the seven impostors sharing its code.
 *
 * So it is drawn: a ₮ on Tether green, which scales to any size and adds no
 * bytes to the bundle.
 */
function Usdt0Mark({ size }: { size: number }) {
  return (
    <Svg width={size} height={size} viewBox="0 0 24 24">
      <Rect x={0} y={0} width={24} height={24} rx={12} fill={TETHER_GREEN} />
      {/* The crossbar, the stem, and the second stroke that makes it a ₮. */}
      <Rect x={5} y={5.6} width={14} height={2.5} rx={0.5} fill="#FFFFFF" />
      <Rect x={10.6} y={5.6} width={2.8} height={12.8} rx={0.5} fill="#FFFFFF" />
      <Rect x={7.4} y={10.4} width={9.2} height={2.1} rx={0.4} fill="#FFFFFF" />
    </Svg>
  );
}

export function TokenIcon({ code, size = 34 }: { code: string; size?: number }) {
  const upper = code.toUpperCase();

  if (upper === 'USDT0') {
    return (
      <View style={[styles.disc, { width: size, height: size, borderRadius: size / 2 }]}>
        <Usdt0Mark size={size} />
      </View>
    );
  }

  const src = LOGOS[upper];

  if (src) {
    const isXlm = upper === 'XLM';
    return (
      <View
        style={[
          styles.disc,
          { width: size, height: size, borderRadius: size / 2, backgroundColor: isXlm ? '#0F0F0F' : 'transparent' },
        ]}
      >
        <Image
          // Key by code so switching tokens remounts the image — RN Android
          // otherwise keeps a stale (e.g. tinted) bitmap and the logo vanishes.
          key={upper}
          source={src}
          style={{
            width: size,
            height: size,
            ...(isXlm ? { tintColor: '#F6F7F8', padding: 4 } : {}),
          }}
          resizeMode="contain"
        />
      </View>
    );
  }

  // Lettered fallback for unknown assets.
  return (
    <View style={[styles.disc, styles.fallback, { width: size, height: size, borderRadius: size / 2 }]}>
      <Text style={[styles.letter, { fontSize: size * 0.4 }]}>{upper.slice(0, 1)}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  disc: {
    alignItems: 'center',
    justifyContent: 'center',
    overflow: 'hidden',
    flexShrink: 0,
  },
  fallback: {
    backgroundColor: 'rgba(253,218,36,0.12)',
    borderWidth: 1,
    borderColor: 'rgba(253,218,36,0.22)',
  },
  letter: {
    color: '#FDDA24',
    fontWeight: '700',
  },
});
