/**
 * Spacing and corner-radius tokens — the RN equivalent of the web wallet's
 * spacing scale. Lives alongside `theme/colors.ts` and `theme/typography.ts` so
 * every screen has one place to import layout constants from instead of
 * hardcoding numbers.
 */
export const spacing = {
  xs: 4,
  sm: 8,
  md: 16,
  lg: 24,
  xl: 32,
  xxl: 48,
} as const;

export const radii = {
  sm: 6,
  md: 12,
  lg: 16,
  /** Pill / fully-rounded. Large enough to round any control height in use. */
  full: 100,
} as const;
