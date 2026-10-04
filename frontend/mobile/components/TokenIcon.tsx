import { Image, StyleSheet, Text, View } from 'react-native';

/**
 * A round asset logo — the real XLM / USDC / EURC / USDT0 marks, with a lettered
 * gold-tint fallback for everything else.
 *
 * XLM's mark is a monochrome silhouette, so it's tinted white on a black disc
 * (matching the web's invert-on-black treatment); the others are already full
 * colour circular logos and render as-is.
 */

// Bundled at build time by Metro.
const XLM = require('../assets/tokens/xlm.png');
const USDC = require('../assets/tokens/usdc.png');
const EURC = require('../assets/tokens/eurc.png');
// USDT0's mark is a square on #00805F rather than a circle with transparency.
// The disc clips it, so it lands as a green circle like any other logo.
const USDT0 = require('../assets/tokens/usdt0.png');

// EURC shipped in the bundle but was never mapped, so a EURC holder got the
// lettered "E" with the real logo sitting unused a directory away.
const LOGOS: Record<string, number> = { XLM, USDC, EURC, USDT0 };

export function TokenIcon({ code, size = 34 }: { code: string; size?: number }) {
  const upper = code.toUpperCase();
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
