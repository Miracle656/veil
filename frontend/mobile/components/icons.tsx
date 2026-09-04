/**
 * The wallet's icon set — clean 24×24 line icons drawn with `react-native-svg`,
 * lifted directly from the redesign artboards. One source of truth so every
 * screen shares the same stroke weight and geometry, and so the app never falls
 * back to emoji glyphs (which don't respect the theme or the brand).
 *
 * Every icon takes `{ size, color }` and defaults to `currentColor`-style usage:
 * pass the theme colour the surrounding text/tile uses.
 */

import Svg, { Circle, Line, Path, Rect } from 'react-native-svg';

export type IconProps = {
  /** Square edge length in px. */
  size?: number;
  /** Stroke colour. */
  color?: string;
  /** Stroke width in the 24×24 viewBox. */
  strokeWidth?: number;
};

const DEFAULT_SIZE = 22;
const DEFAULT_STROKE = 1.75;

function Base({
  size = DEFAULT_SIZE,
  children,
}: {
  size?: number;
  children: React.ReactNode;
}) {
  return (
    <Svg width={size} height={size} viewBox="0 0 24 24" fill="none">
      {children}
    </Svg>
  );
}

// ── Primary actions ──────────────────────────────────────────────────────────

export function SendIcon({ size, color = 'currentColor', strokeWidth = 1.9 }: IconProps) {
  return (
    <Base size={size}>
      <Path d="M5 12h14M12 5l7 7-7 7" stroke={color} strokeWidth={strokeWidth} strokeLinecap="round" strokeLinejoin="round" />
    </Base>
  );
}

/** A check mark — success confirmation. */
export function CheckIcon({ size, color = 'currentColor', strokeWidth = 2.4 }: IconProps) {
  return (
    <Base size={size}>
      <Path d="M5 13l4.2 4.2L19 7" stroke={color} strokeWidth={strokeWidth} strokeLinecap="round" strokeLinejoin="round" />
    </Base>
  );
}

/** Filled paper-plane (the FontAwesome "send" glyph), for the primary Send action. */
export function PaperPlaneIcon({ size, color = 'currentColor' }: IconProps) {
  return (
    <Base size={size}>
      <Path d="M21.5 2.5 2.6 11.1l6.9 2.4 2.4 6.9L21.5 2.5Z" fill={color} />
      <Path d="M21.5 2.5 9.5 13.5" stroke={color} strokeWidth={1.4} strokeLinecap="round" opacity={0.35} />
    </Base>
  );
}

export function ReceiveIcon({ size, color = 'currentColor', strokeWidth = 1.9 }: IconProps) {
  return (
    <Base size={size}>
      <Path d="M19 12H5M12 19l-7-7 7-7" stroke={color} strokeWidth={strokeWidth} strokeLinecap="round" strokeLinejoin="round" />
    </Base>
  );
}

export function SwapIcon({ size, color = 'currentColor', strokeWidth = 1.9 }: IconProps) {
  return (
    <Base size={size}>
      <Path d="M7 10l5-5 5 5M17 14l-5 5-5-5" stroke={color} strokeWidth={strokeWidth} strokeLinecap="round" strokeLinejoin="round" />
    </Base>
  );
}

/** QR-scan viewfinder — the "scan a recipient" affordance. */
export function ScanIcon({ size, color = 'currentColor', strokeWidth = 1.9 }: IconProps) {
  return (
    <Base size={size}>
      <Path d="M4 8V6a2 2 0 0 1 2-2h2M16 4h2a2 2 0 0 1 2 2v2M20 16v2a2 2 0 0 1-2 2h-2M8 20H6a2 2 0 0 1-2-2v-2" stroke={color} strokeWidth={strokeWidth} strokeLinecap="round" strokeLinejoin="round" />
      <Line x1="4" y1="12" x2="20" y2="12" stroke={color} strokeWidth={strokeWidth} strokeLinecap="round" />
    </Base>
  );
}

/** Two figures — the contacts / address-book affordance. */
export function UsersIcon({ size, color = 'currentColor', strokeWidth = 1.8 }: IconProps) {
  return (
    <Base size={size}>
      <Path d="M15 20v-1.5a3.5 3.5 0 0 0-3.5-3.5h-4A3.5 3.5 0 0 0 4 18.5V20" stroke={color} strokeWidth={strokeWidth} strokeLinecap="round" strokeLinejoin="round" />
      <Circle cx="9.5" cy="8" r="3" stroke={color} strokeWidth={strokeWidth} />
      <Path d="M17 15.2a3.5 3.5 0 0 1 3 3.3V20M16 5.2a3 3 0 0 1 0 5.6" stroke={color} strokeWidth={strokeWidth} strokeLinecap="round" strokeLinejoin="round" />
    </Base>
  );
}

/** Down-into-tray — the "save QR" affordance. */
export function DownloadIcon({ size, color = 'currentColor', strokeWidth = 1.9 }: IconProps) {
  return (
    <Base size={size}>
      <Path d="M12 3v11M8 10l4 4 4-4M5 20h14" stroke={color} strokeWidth={strokeWidth} strokeLinecap="round" strokeLinejoin="round" />
    </Base>
  );
}

/** Three linked nodes — the share affordance. */
export function ShareIcon({ size, color = 'currentColor', strokeWidth = 1.8 }: IconProps) {
  return (
    <Base size={size}>
      <Circle cx="18" cy="5" r="2.6" stroke={color} strokeWidth={strokeWidth} />
      <Circle cx="6" cy="12" r="2.6" stroke={color} strokeWidth={strokeWidth} />
      <Circle cx="18" cy="19" r="2.6" stroke={color} strokeWidth={strokeWidth} />
      <Path d="M8.3 10.8l7.4-4.3M8.3 13.2l7.4 4.3" stroke={color} strokeWidth={strokeWidth} strokeLinecap="round" />
    </Base>
  );
}

/** Flat-top hexagon — the passkey / Soroban-contract mark. */
export function HexagonIcon({ size, color = 'currentColor', strokeWidth = 1.8, filled = false }: IconProps & { filled?: boolean }) {
  return (
    <Base size={size}>
      <Path d="M7.7 4h8.6L21 12l-4.7 8H7.7L3 12z" fill={filled ? color : 'none'} stroke={color} strokeWidth={strokeWidth} strokeLinejoin="round" />
    </Base>
  );
}

export function BuyIcon({ size, color = 'currentColor', strokeWidth = DEFAULT_STROKE }: IconProps) {
  return (
    <Base size={size}>
      <Rect x="2" y="5" width="20" height="14" rx="2.5" stroke={color} strokeWidth={strokeWidth} />
      <Path d="M2 10h20" stroke={color} strokeWidth={strokeWidth} />
    </Base>
  );
}

// ── Secondary features ───────────────────────────────────────────────────────

export function AgentIcon({ size, color = 'currentColor', strokeWidth = DEFAULT_STROKE }: IconProps) {
  return (
    <Base size={size}>
      <Path d="M12 2a4 4 0 014 4v1a4 4 0 01-8 0V6a4 4 0 014-4zm0 10c-4 0-7 2-7 4v1h14v-1c0-2-3-4-7-4z" stroke={color} strokeWidth={strokeWidth} strokeLinejoin="round" />
    </Base>
  );
}

export function VaultIcon({ size, color = 'currentColor', strokeWidth = DEFAULT_STROKE }: IconProps) {
  return (
    <Base size={size}>
      <Path d="M7 10V7a5 5 0 0110 0v3M5 10h14v10H5V10z" stroke={color} strokeWidth={strokeWidth} strokeLinejoin="round" />
    </Base>
  );
}

export function WithdrawIcon({ size, color = 'currentColor', strokeWidth = DEFAULT_STROKE }: IconProps) {
  return (
    <Base size={size}>
      <Path d="M12 21V9m0 12l-4-4m4 4l4-4M3 7V5a2 2 0 012-2h14a2 2 0 012 2v2" stroke={color} strokeWidth={strokeWidth} strokeLinecap="round" strokeLinejoin="round" />
    </Base>
  );
}

export function ConnectIcon({ size, color = 'currentColor', strokeWidth = DEFAULT_STROKE }: IconProps) {
  return (
    <Base size={size}>
      <Path d="M8.5 8.5l7 7M13 5l6 6-4 4-6-6" stroke={color} strokeWidth={strokeWidth} strokeLinecap="round" />
    </Base>
  );
}

export function PoolsIcon({ size, color = 'currentColor', strokeWidth = DEFAULT_STROKE }: IconProps) {
  return (
    <Base size={size}>
      <Path d="M4 7h16M4 12h16M4 17h16" stroke={color} strokeWidth={strokeWidth} strokeLinecap="round" />
    </Base>
  );
}

// ── Tab bar ──────────────────────────────────────────────────────────────────

export function HomeIcon({ size, color = 'currentColor', strokeWidth = DEFAULT_STROKE }: IconProps) {
  return (
    <Base size={size}>
      <Path d="M3 10l9-7 9 7v9a2 2 0 01-2 2h-5v-6H10v6H5a2 2 0 01-2-2z" stroke={color} strokeWidth={strokeWidth} strokeLinejoin="round" />
    </Base>
  );
}

export function AssetsIcon({ size, color = 'currentColor', strokeWidth = DEFAULT_STROKE }: IconProps) {
  return (
    <Base size={size}>
      <Circle cx="12" cy="12" r="8" stroke={color} strokeWidth={strokeWidth} />
      <Path d="M12 8v8M8 12h8" stroke={color} strokeWidth={strokeWidth} strokeLinecap="round" />
    </Base>
  );
}

export function SettingsIcon({ size, color = 'currentColor', strokeWidth = 1.4 }: IconProps) {
  return (
    <Base size={size}>
      <Circle cx="12" cy="12" r="3" stroke={color} strokeWidth={strokeWidth + 0.35} />
      <Path
        d="M19 12a7 7 0 00-.1-1l2-1.5-2-3.4-2.3 1a7 7 0 00-1.7-1l-.3-2.5H10l-.3 2.5a7 7 0 00-1.7 1l-2.3-1-2 3.4 2 1.5a7 7 0 000 2l-2 1.5 2 3.4 2.3-1a7 7 0 001.7 1l.3 2.5h4l.3-2.5a7 7 0 001.7-1l2.3 1 2-3.4-2-1.5a7 7 0 00.1-1z"
        stroke={color}
        strokeWidth={strokeWidth}
        strokeLinejoin="round"
      />
    </Base>
  );
}

// ── Utility ──────────────────────────────────────────────────────────────────

export function CopyIcon({ size = 14, color = 'currentColor', strokeWidth = DEFAULT_STROKE }: IconProps) {
  return (
    <Base size={size}>
      <Rect x="9" y="9" width="12" height="12" rx="2" stroke={color} strokeWidth={strokeWidth} />
      <Path d="M5 15H4a2 2 0 01-2-2V4a2 2 0 012-2h9a2 2 0 012 2v1" stroke={color} strokeWidth={strokeWidth} />
    </Base>
  );
}

export function GearIcon({ size = 18, color = 'currentColor', strokeWidth = 1.5 }: IconProps) {
  return (
    <Base size={size}>
      <Circle cx="12" cy="12" r="3" stroke={color} strokeWidth={strokeWidth + 0.25} />
      <Path
        d="M19.4 15a1.6 1.6 0 00.3 1.8l.1.1a2 2 0 11-2.8 2.8l-.1-.1a1.6 1.6 0 00-2.8 1.1V21a2 2 0 11-4 0v-.1A1.6 1.6 0 009 19.4a1.6 1.6 0 00-1.8.3l-.1.1a2 2 0 11-2.8-2.8l.1-.1a1.6 1.6 0 00-1.1-2.8H3a2 2 0 110-4h.1A1.6 1.6 0 004.6 9a1.6 1.6 0 00-.3-1.8l-.1-.1a2 2 0 112.8-2.8l.1.1a1.6 1.6 0 001.8.3H9a1.6 1.6 0 001-1.5V3a2 2 0 114 0v.1a1.6 1.6 0 001 1.5 1.6 1.6 0 001.8-.3l.1-.1a2 2 0 112.8 2.8l-.1.1a1.6 1.6 0 00-.3 1.8V9a1.6 1.6 0 001.5 1H21a2 2 0 110 4h-.1a1.6 1.6 0 00-1.5 1z"
        stroke={color}
        strokeWidth={strokeWidth}
      />
    </Base>
  );
}

export function EyeIcon({ size = 18, color = 'currentColor', strokeWidth = 1.5 }: IconProps) {
  return (
    <Base size={size}>
      <Path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7-10-7-10-7z" stroke={color} strokeWidth={strokeWidth} strokeLinecap="round" strokeLinejoin="round" />
      <Circle cx="12" cy="12" r="3" stroke={color} strokeWidth={strokeWidth} />
    </Base>
  );
}

export function EyeOffIcon({ size = 18, color = 'currentColor', strokeWidth = 1.5 }: IconProps) {
  return (
    <Base size={size}>
      <Path d="M9.6 4.5A9.9 9.9 0 0112 4.3c6.5 0 10 7 10 7a18 18 0 01-2.4 3.3M5.2 5.8A17.8 17.8 0 002 11.3s3.5 7 10 7a9.9 9.9 0 004-.8" stroke={color} strokeWidth={strokeWidth} strokeLinecap="round" strokeLinejoin="round" />
      <Path d="M9.9 9.9a3 3 0 004.2 4.2" stroke={color} strokeWidth={strokeWidth} strokeLinecap="round" strokeLinejoin="round" />
      <Line x1="3" y1="3" x2="21" y2="21" stroke={color} strokeWidth={strokeWidth} strokeLinecap="round" />
    </Base>
  );
}

export function ChevronDownIcon({ size = 12, color = 'currentColor', strokeWidth = 1.6 }: IconProps) {
  return (
    <Base size={size}>
      <Path d="M6 9l6 6 6-6" stroke={color} strokeWidth={strokeWidth} strokeLinecap="round" strokeLinejoin="round" />
    </Base>
  );
}

/** Up-trend / received. */
export function ArrowUpIcon({ size = 12, color = 'currentColor', strokeWidth = 2.2 }: IconProps) {
  return (
    <Base size={size}>
      <Path d="M12 19V5M5 12l7-7 7 7" stroke={color} strokeWidth={strokeWidth} strokeLinecap="round" strokeLinejoin="round" />
    </Base>
  );
}

/** Down-trend / sent. */
export function ArrowDownIcon({ size = 12, color = 'currentColor', strokeWidth = 2 }: IconProps) {
  return (
    <Base size={size}>
      <Path d="M12 5v14M19 12l-7 7-7-7" stroke={color} strokeWidth={strokeWidth} strokeLinecap="round" strokeLinejoin="round" />
    </Base>
  );
}

/** Earn / yield — a ringed circle (◎). */
export function EarnIcon({ size, color = 'currentColor', strokeWidth = DEFAULT_STROKE }: IconProps) {
  return (
    <Base size={size}>
      <Circle cx="12" cy="12" r="9" stroke={color} strokeWidth={strokeWidth} />
      <Circle cx="12" cy="12" r="3.5" stroke={color} strokeWidth={strokeWidth} />
    </Base>
  );
}

/** Plus — the universal pay/send action on the tab bar. */
export function PlusIcon({ size, color = 'currentColor', strokeWidth = 2.2 }: IconProps) {
  return (
    <Base size={size}>
      <Path d="M12 5v14M5 12h14" stroke={color} strokeWidth={strokeWidth} strokeLinecap="round" />
    </Base>
  );
}

/** Back chevron. */
export function BackIcon({ size = 24, color = 'currentColor', strokeWidth = 2 }: IconProps) {
  return (
    <Base size={size}>
      <Path d="M15 5l-7 7 7 7" stroke={color} strokeWidth={strokeWidth} strokeLinecap="round" strokeLinejoin="round" />
    </Base>
  );
}

/** Vertical swap arrows (⇅) — the swap-direction toggle. */
export function SwapVerticalIcon({ size, color = 'currentColor', strokeWidth = 2 }: IconProps) {
  return (
    <Base size={size}>
      <Path d="M8 4v16M8 20l-3-3M8 20l3-3M16 20V4M16 4l-3 3M16 4l3 3" stroke={color} strokeWidth={strokeWidth} strokeLinecap="round" strokeLinejoin="round" />
    </Base>
  );
}

// ── Pay-for services ─────────────────────────────────────────────────────────

export function AirtimeIcon({ size, color = 'currentColor', strokeWidth = DEFAULT_STROKE }: IconProps) {
  return (
    <Base size={size}>
      <Rect x="7" y="2" width="10" height="20" rx="2.5" stroke={color} strokeWidth={strokeWidth} />
      <Path d="M11 18h2" stroke={color} strokeWidth={strokeWidth} strokeLinecap="round" />
    </Base>
  );
}

export function DataIcon({ size, color = 'currentColor', strokeWidth = DEFAULT_STROKE }: IconProps) {
  return (
    <Base size={size}>
      <Path d="M4 11a12 12 0 0116 0M7 14.5a7 7 0 0110 0" stroke={color} strokeWidth={strokeWidth} strokeLinecap="round" />
      <Path d="M12 18h.01" stroke={color} strokeWidth={strokeWidth + 0.6} strokeLinecap="round" />
    </Base>
  );
}

export function PowerIcon({ size, color = 'currentColor', strokeWidth = DEFAULT_STROKE }: IconProps) {
  return (
    <Base size={size}>
      <Path d="M13 2L5 13h6l-1 9 9-12h-6l1-8z" stroke={color} strokeWidth={strokeWidth} strokeLinejoin="round" />
    </Base>
  );
}

export function TVIcon({ size, color = 'currentColor', strokeWidth = DEFAULT_STROKE }: IconProps) {
  return (
    <Base size={size}>
      <Rect x="2" y="6" width="20" height="13" rx="2.5" stroke={color} strokeWidth={strokeWidth} />
      <Path d="M8 3l4 3 4-3" stroke={color} strokeWidth={strokeWidth} strokeLinecap="round" strokeLinejoin="round" />
    </Base>
  );
}

export function BillsIcon({ size, color = 'currentColor', strokeWidth = DEFAULT_STROKE }: IconProps) {
  return (
    <Base size={size}>
      <Path d="M6 2h12v20l-3-2-3 2-3-2-3 2V2z" stroke={color} strokeWidth={strokeWidth} strokeLinejoin="round" />
      <Path d="M9 8h6M9 12h6" stroke={color} strokeWidth={strokeWidth} strokeLinecap="round" />
    </Base>
  );
}

export function BankIcon({ size, color = 'currentColor', strokeWidth = DEFAULT_STROKE }: IconProps) {
  return (
    <Base size={size}>
      <Path d="M3 9l9-5 9 5M5 9v9M9 9v9M15 9v9M19 9v9M3 21h18" stroke={color} strokeWidth={strokeWidth} strokeLinecap="round" strokeLinejoin="round" />
    </Base>
  );
}

export function BettingIcon({ size, color = 'currentColor', strokeWidth = DEFAULT_STROKE }: IconProps) {
  return (
    <Base size={size}>
      <Rect x="4" y="4" width="16" height="16" rx="3.5" stroke={color} strokeWidth={strokeWidth} />
      <Path d="M9 9h.01M15 15h.01M15 9h.01M9 15h.01" stroke={color} strokeWidth={strokeWidth + 0.8} strokeLinecap="round" />
    </Base>
  );
}

export function GridIcon({ size, color = 'currentColor', strokeWidth = DEFAULT_STROKE }: IconProps) {
  return (
    <Base size={size}>
      <Rect x="4" y="4" width="6" height="6" rx="1.5" stroke={color} strokeWidth={strokeWidth} />
      <Rect x="14" y="4" width="6" height="6" rx="1.5" stroke={color} strokeWidth={strokeWidth} />
      <Rect x="4" y="14" width="6" height="6" rx="1.5" stroke={color} strokeWidth={strokeWidth} />
      <Rect x="14" y="14" width="6" height="6" rx="1.5" stroke={color} strokeWidth={strokeWidth} />
    </Base>
  );
}
