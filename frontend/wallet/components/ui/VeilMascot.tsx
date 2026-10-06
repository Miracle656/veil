'use client'

import { useId } from 'react'

import { MASCOT_BANDS, isLayered, mascotPath, type MascotAperture } from '@/lib/mascotGeometry'

/**
 * The Veil mascot — the Drape standing up.
 *
 * Same 96×96 box and the same falling edge as {@link VeilMark}: the figure is
 * built from that mark's own bar corners rather than drawn beside it. Cloth
 * only — no limbs, no features, and any opening is cloth removed.
 *
 * Draws itself two ways. Below 64px it is one solid shape, because a silhouette
 * that gains and loses parts as it is resized is not a mark. At or above it the
 * seams appear, clipped to that same outline, so the detailed figure and the
 * plain one are provably the same object.
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
  detail = 'auto',
  className,
  title = 'Veil',
}: {
  size?: number
  /** Any CSS colour. Pass `currentColor` to inherit from the parent. */
  color?: string
  aperture?: MascotAperture
  /** 'auto' follows the size. Force it only to show the two side by side. */
  detail?: 'auto' | 'flat' | 'layered'
  className?: string
  /** Accessible name. Pass '' for a decorative instance beside a text label. */
  title?: string
}) {
  // Several mascots render on one page in the picker, and a duplicate clip id
  // would silently make every one of them use the first one's outline.
  const clipId = useId()
  const layered = detail === 'auto' ? isLayered(size) : detail === 'layered'

  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 96 96"
      className={className}
      {...(title ? { role: 'img', 'aria-label': title } : { 'aria-hidden': true })}
    >
      {layered ? (
        <>
          <defs>
            <clipPath id={clipId} clipPathUnits="userSpaceOnUse">
              {/* The aperture belongs to the outline, so a clipped figure keeps it. */}
              <path d={mascotPath(aperture)} clipRule="evenodd" />
            </clipPath>
          </defs>
          <g clipPath={`url(#${clipId})`}>
            {MASCOT_BANDS.map((band) => (
              <path key={band.opacity} d={band.d} fill={color} opacity={band.opacity} />
            ))}
          </g>
        </>
      ) : (
        <path d={mascotPath(aperture)} fill={color} fillRule="evenodd" />
      )}
    </svg>
  )
}
