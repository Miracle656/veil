/**
 * The Veil drape mark — three stacked bars fading downward, the veil lifting.
 *
 * This is the current brand mark (it matches the mobile app and the design
 * system's `veil-mark-currentcolor.svg`). `components/VeilLogo.tsx` holds the
 * older fingerprint-in-a-circle logo and is still used by pages that have not
 * been revamped, so both exist deliberately rather than one replacing the other.
 */
export function VeilMark({
  size = 26,
  color = 'var(--gold)',
  className,
}: {
  size?: number
  /** Any CSS colour. Pass `currentColor` to inherit from the parent. */
  color?: string
  className?: string
}) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 96 96"
      className={className}
      role="img"
      aria-label="Veil"
    >
      <rect x="22" y="26" width="52" height="12" rx="6" fill={color} />
      <rect x="28" y="44" width="40" height="12" rx="6" fill={color} opacity="0.5" />
      <rect x="34" y="62" width="28" height="12" rx="6" fill={color} opacity="0.22" />
    </svg>
  )
}

/** The mark paired with the Anton wordmark, as it appears in the sidebar. */
export function VeilWordmark({ size = 26, fontSize = 19 }: { size?: number; fontSize?: number }) {
  return (
    <div className="flex items-center gap-[11px]">
      <VeilMark size={size} />
      <div
        className="font-anton text-gold"
        style={{ fontSize, letterSpacing: '0.08em' }}
      >
        VEIL
      </div>
    </div>
  )
}
