/**
 * Brand theme constants for Veil Mobile.
 *
 * Ported from `frontend/wallet/app/globals.css` (:root tokens)
 * and `BRAND_GUIDELINES.md`.
 *
 * Usage: `import { colors, surfaces, spacing, radii } from '@/constants/theme'`
 *
 * Acceptance: `colors.gold === '#FDDA24'` etc.; no raw hex in components.
 */

export const colors = {
  gold: '#FDDA24' as const,
  nearBlack: '#0F0F0F' as const,
  offWhite: '#F6F7F8' as const,
  lilac: '#B7ACE8' as const,
  teal: '#00A7B5' as const,
  warmGrey: '#D6D2C4' as const,
  navy: '#002E5D' as const,
  textMuted: 'rgba(246, 247, 248, 0.55)' as const,
} as const;

/** Light-theme overrides (mirrors `[data-theme="light"]` from globals.css). */
export const lightColors: typeof colors = {
  gold: '#C4A800' as const,
  nearBlack: '#FFFFFF' as const,
  offWhite: '#1A1A1A' as const,
  lilac: '#B7ACE8' as const,
  teal: '#007A85' as const,
  warmGrey: '#D6D2C4' as const,
  navy: '#002E5D' as const,
  textMuted: 'rgba(26, 26, 26, 0.60)' as const,
} as const;

export const surfaces = {
  surface: 'rgba(255,255,255,0.03)' as const,
  surfaceMd: 'rgba(255,255,255,0.06)' as const,
  borderDim: 'rgba(255,255,255,0.08)' as const,
} as const;

/** Light-theme surface overrides. */
export const lightSurfaces: typeof surfaces = {
  surface: 'rgba(0,0,0,0.03)' as const,
  surfaceMd: 'rgba(0,0,0,0.06)' as const,
  borderDim: 'rgba(0,0,0,0.10)' as const,
} as const;

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
  full: 100,
} as const;
