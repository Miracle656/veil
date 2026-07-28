/**
 * Typography constants for Veil Mobile.
 *
 * Ported from `BRAND_GUIDELINES.md` typography tables and the font imports
 * in `frontend/wallet/app/globals.css`.
 *
 * Usage:
 *   import { fonts, fontRoles } from '@/constants/typography'
 *   <Text style={fontRoles.heading}>Dashboard</Text>
 */

export const fonts = {
  lora: 'Lora, Georgia, serif' as const,
  inter: 'Inter, system-ui, sans-serif' as const,
  anton: 'Anton, Impact, sans-serif' as const,
  inconsolata: 'Inconsolata, monospace' as const,
} as const;

export const fontRoles = {
  /** Page titles, card headings, confirmation messages (Lora SemiBold Italic). */
  heading: {
    fontFamily: fonts.lora,
    fontWeight: 600 as const,
    fontStyle: 'italic' as const,
    fontSize: 28,
  } as const,

  /** Wordmark, section labels, badges (Anton ALL CAPS). */
  accent: {
    fontFamily: fonts.anton,
    fontSize: 20,
    letterSpacing: 0.08,
    textTransform: 'uppercase' as const,
  } as const,

  /** Body text / UI labels (Inter, default). */
  body: {
    fontFamily: fonts.inter,
    fontWeight: 400 as const,
    fontSize: 15,
  } as const,

  /** Wallet addresses, contract IDs, transaction hashes (Inconsolata). */
  code: {
    fontFamily: fonts.inconsolata,
    fontWeight: 400 as const,
    fontSize: 14,
  } as const,
} as const;
