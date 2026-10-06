'use client'

import { useId } from 'react'

import {
  MASCOT_FADE_STOPS,
  mascotPath,
  usesFade,
  type MascotAperture,
} from '@/lib/mascotGeometry'

/**
 * The Veil mascot — the Drape standing up.
 *
 * Same 96×96 box and same taper as {@link VeilMark}, because the figure is
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
  color = 'var(--gold)',
  aperture = 'none',
  className,
  title = 'Veil',
}: {
  size?: number
  /** Any CSS colour. Pass `currentColor` to inherit from the parent. */
  color?: string
  aperture?: MascotAperture
  className?: string
  /** Accessible name. Pass '' for a decorative instance beside a text label. */
  title?: string
}) {
  // Several mascots render on one page in the picker, and a duplicate gradient
  // id would silently make every one of them use the first one's stops.
  const gradientId = useId()
  const faded = usesFade(size)

  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 96 96"
      className={className}
      {...(title ? { role: 'img', 'aria-label': title } : { 'aria-hidden': true })}
    >
      {faded ? (
        <defs>
          <linearGradient id={gradientId} x1="0" y1="0" x2="0" y2="1">
            {MASCOT_FADE_STOPS.map((stop) => (
              <stop
                key={stop.offset}
                offset={stop.offset}
                stopColor={color}
                stopOpacity={stop.opacity}
              />
            ))}
          </linearGradient>
        </defs>
      ) : null}
      <path
        d={mascotPath(aperture)}
        fill={faded ? `url(#${gradientId})` : color}
        fillRule="evenodd"
      />
    </svg>
  )
}
