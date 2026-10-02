/**
 * Native colour palette — the RN equivalent of the web wallet's `:root` CSS
 * variables in `frontend/wallet/app/globals.css` (dark theme values). Keeping
 * the primitives on these exact values is what preserves side-by-side parity.
 */
export const colors = {
  // Primary
  gold: "#FDDA24",
  nearBlack: "#0F0F0F",
  offWhite: "#F6F7F8",

  // Secondary
  lilac: "#B7ACE8",
  teal: "#00A7B5",
  warmGrey: "#D6D2C4",
  navy: "#002E5D",

  // Surfaces / borders
  surface: "rgba(255,255,255,0.03)",
  surfaceMd: "rgba(255,255,255,0.06)",
  borderDim: "rgba(255,255,255,0.08)",

  // Text
  textMuted: "rgba(246,247,248,0.55)",

  // Gold tints (buttons, chips, highlight) — mirror the rgba(253,218,36,·) values
  goldFill: "#FDDA24",
  goldFillHover: "#f0cf1b",
  goldSoft: "rgba(253,218,36,0.08)",
  goldSoftHover: "rgba(253,218,36,0.14)",
  goldBorder: "rgba(253,218,36,0.18)",
} as const;
