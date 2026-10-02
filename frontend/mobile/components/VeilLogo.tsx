import Svg, { Rect } from 'react-native-svg';

/**
 * The Veil mark — "the Drape": three bars fading like fabric falling. They read
 * as the layers of the stack (fiat on top, USDC beneath, yield under that), with
 * only the top layer fully opaque. Lifted from the adopted logo direction in the
 * design project ("2c").
 */
export function VeilLogo({ size = 22, color = '#FDDA24' }: { size?: number; color?: string }) {
  return (
    <Svg width={size} height={size} viewBox="0 0 96 96">
      <Rect x="22" y="26" width="52" height="12" rx="6" fill={color} />
      <Rect x="28" y="44" width="40" height="12" rx="6" fill={color} opacity={0.5} />
      <Rect x="34" y="62" width="28" height="12" rx="6" fill={color} opacity={0.22} />
    </Svg>
  );
}
