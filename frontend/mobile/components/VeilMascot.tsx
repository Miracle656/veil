import Svg, { Defs, LinearGradient, Path, Stop } from 'react-native-svg';

import {
  MASCOT_FADE_STOPS,
  mascotPath,
  usesFade,
  type MascotAperture,
} from '../lib/mascotGeometry';

/**
 * The Veil mascot — the Drape standing up.
 *
 * Same 96×96 box and same taper as {@link VeilLogo}, because the figure is
 * built from that mark's own corners rather than drawn beside it. Cloth only:
 * no limbs, no features, and any opening is cloth removed.
 *
 * Nothing user-facing renders this yet, on purpose. `docs/BRAND_MASCOT.md` asks
 * for a read from someone Nigerian whose judgement is trusted before it reaches
 * an app icon, a store listing or marketing, and that is cheaper to do now than
 * after it ships.
 */
export function VeilMascot({
  size = 96,
  color = '#FDDA24',
  aperture = 'none',
  label = 'Veil',
}: {
  size?: number;
  color?: string;
  aperture?: MascotAperture;
  /** Accessible name. Pass '' for a decorative instance beside a text label. */
  label?: string;
}) {
  const faded = usesFade(size);
  // Unlike the web, each Svg here is its own native view, so a fixed gradient
  // id cannot collide with another mascot on the same screen.
  const gradientId = 'veilMascotFade';

  return (
    <Svg
      width={size}
      height={size}
      viewBox="0 0 96 96"
      {...(label
        ? { accessible: true, accessibilityRole: 'image' as const, accessibilityLabel: label }
        : { accessibilityElementsHidden: true, importantForAccessibility: 'no-hide-descendants' as const })}
    >
      {faded ? (
        <Defs>
          <LinearGradient id={gradientId} x1="0" y1="0" x2="0" y2="1">
            {MASCOT_FADE_STOPS.map((stop) => (
              <Stop
                key={stop.offset}
                offset={stop.offset}
                stopColor={color}
                stopOpacity={stop.opacity}
              />
            ))}
          </LinearGradient>
        </Defs>
      ) : null}
      <Path d={mascotPath(aperture)} fill={faded ? `url(#${gradientId})` : color} fillRule="evenodd" />
    </Svg>
  );
}
