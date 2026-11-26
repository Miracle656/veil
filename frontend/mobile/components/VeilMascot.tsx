import Svg, { ClipPath, Defs, G, Path } from 'react-native-svg';

import { MASCOT_BANDS, isLayered, mascotPath, type MascotAperture } from '../lib/mascotGeometry';

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
  detail = 'auto',
  label = 'Veil',
}: {
  size?: number;
  color?: string;
  aperture?: MascotAperture;
  /** 'auto' follows the size. Force it only to show the two side by side. */
  detail?: 'auto' | 'flat' | 'layered';
  /** Accessible name. Pass '' for a decorative instance beside a text label. */
  label?: string;
}) {
  const layered = detail === 'auto' ? isLayered(size) : detail === 'layered';
  // Unlike the web, each Svg here is its own native view, so a fixed clip id
  // cannot collide with another mascot on the same screen.
  const clipId = 'veilMascotOutline';

  return (
    <Svg
      width={size}
      height={size}
      viewBox="0 0 96 96"
      {...(label
        ? { accessible: true, accessibilityRole: 'image' as const, accessibilityLabel: label }
        : { accessibilityElementsHidden: true, importantForAccessibility: 'no-hide-descendants' as const })}
    >
      {layered ? (
        <>
          <Defs>
            <ClipPath id={clipId}>
              {/* The aperture belongs to the outline, so a clipped figure keeps it. */}
              <Path d={mascotPath(aperture)} clipRule="evenodd" />
            </ClipPath>
          </Defs>
          <G clipPath={`url(#${clipId})`}>
            {MASCOT_BANDS.map((band) => (
              <Path key={band.opacity} d={band.d} fill={color} opacity={band.opacity} />
            ))}
          </G>
        </>
      ) : (
        <Path d={mascotPath(aperture)} fill={color} fillRule="evenodd" />
      )}
    </Svg>
  );
}
