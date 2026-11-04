import { Image, StyleSheet, Text, View } from 'react-native';
import Svg, { Circle, Path } from 'react-native-svg';

/**
 * A round asset logo — the real marks for every asset in the registry, with a
 * lettered gold-tint fallback for anything else.
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
const AQUA = require('../assets/tokens/aqua.png');

// EURC shipped in the bundle but was never mapped, so a EURC holder got the
// lettered "E" with the real logo sitting unused a directory away.
const LOGOS: Record<string, number> = { XLM, USDC, EURC, USDT0, AQUA };

/**
 * USDY's mark, transcribed from Ondo's SVG rather than rasterised.
 *
 * It is two shapes — a navy disc and one path — so it stays sharp at every size
 * the app asks for (34 in lists, 38 in the assets card, 56 on the token page)
 * and costs nothing in the bundle. A PNG would have to ship at the largest of
 * those and be downscaled for the rest.
 */
function UsdyMark({ size }: { size: number }) {
  return (
    <Svg width={size} height={size} viewBox="0 0 800 800">
      <Circle cx={400} cy={400} r={400} fill="#122A5F" />
      <Path
        fillRule="evenodd"
        clipRule="evenodd"
        fill="#FFFFFF"
        d="M620 400C620 278.497 521.502 180 400 180V100C420.71 100 440.931 102.099 460.46 106.095C597.165 134.069 700 255.025 700 400C700 565.685 565.685 700 400 700C269.378 700 158.254 616.519 117.07 500H203.988C240.402 571.234 314.506 620 400 620C521.502 620 620 521.503 620 400ZM134.602 260C184.902 355.156 284.878 420 400 420V340C301.404 340 217.956 275.14 189.997 185.76C167.921 207.402 149.176 232.429 134.602 260ZM223.837 157.143C240.953 238.734 313.322 300 400 300C455.229 300 500 344.772 500 400C500 455.229 455.229 500 400 500H250.311C282.601 548.239 337.592 580 400 580C499.411 580 580 499.411 580 400C580 300.589 499.411 220 400 220C344.772 220 300 175.228 300 120V117.071C272.56 126.769 246.953 140.346 223.837 157.143Z"
      />
    </Svg>
  );
}

export function TokenIcon({ code, size = 34 }: { code: string; size?: number }) {
  const upper = code.toUpperCase();

  if (upper === 'USDY') {
    return (
      <View style={[styles.disc, { width: size, height: size, borderRadius: size / 2 }]}>
        <UsdyMark size={size} />
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
