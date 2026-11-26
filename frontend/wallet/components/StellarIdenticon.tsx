import { useMemo } from 'react'

import { IDENTICON_GRID, hasIdenticon, identiconFor } from '@/lib/stellarIdenticon'

/**
 * The pixel picture for a Stellar address. Draws nothing for a value that is
 * not an address (a name, "Stellar DEX", "unknown"), keeping the space so
 * rows stay lined up.
 */
export function StellarIdenticon({ address, size = 36 }: { address: string; size?: number }) {
  const icon = useMemo(() => (hasIdenticon(address) ? identiconFor(address) : null), [address])
  return (
    <svg
      width={size}
      height={size}
      viewBox={`0 0 ${IDENTICON_GRID} ${IDENTICON_GRID}`}
      aria-hidden="true"
      shapeRendering="crispEdges"
      style={{ flexShrink: 0, borderRadius: 6 }}
    >
      {icon?.cells.map(({ x, y }) => (
        <rect key={`${x}-${y}`} x={x} y={y} width={1} height={1} fill={icon.color} />
      ))}
    </svg>
  )
}
