import { ReactElement, ReactNode, useMemo } from 'react';
import {
  Pressable,
  RefreshControlProps,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useRouter, type Href } from 'expo-router';

import { useTheme } from '../hooks/useTheme';
import { FlowHeader } from './FlowHeader';
import type { ThemeColors } from '../lib/theme';
import { fontFamily } from '../theme/typography';

// ── Design tokens (legacy static export kept for back-compat) ─────────────
// Prefer `useTheme()` in new code; the scaffold itself is now theme-aware.
export const colors = {
  bg: '#0B0B0F',
  surface: '#15161B',
  surfaceHigh: '#1C1D24',
  border: 'rgba(246, 247, 248, 0.08)',
  borderStrong: 'rgba(246, 247, 248, 0.16)',
  offWhite: '#F6F7F8',
  muted: '#9BA1A6',
  gold: '#D4AF37',
  teal: '#5EE2D6',
  danger: '#FF6B6B',
} as const;

/** Navigation target accepted by expo-router: a string path or object form. */
export type ScreenScaffoldProps = {
  /** Page eyebrow (small uppercase label) */
  eyebrow?: string;
  /** Page title (large heading) */
  title: string;
  /** Short description beneath the title */
  description?: string;
  /** Optional back-target. When omitted, the header still shows a back chevron that calls router.back(). */
  backHref?: Href;
  /** Override the back-button label */
  backLabel?: string;
  /** Hide the leading back button (use on primary tab destinations) */
  hideBack?: boolean;
  /** Optional action area to render under the description (e.g. link grid, link list) */
  children?: ReactNode;
  /** When true, content scrolls; defaults to true */
  scrollable?: boolean;
  /** Forwarded to the root view so e2e flows can identify the screen. */
  testID?: string;
  /** Optional refresh control for pull-to-refresh. */
  refreshControl?: ReactElement<RefreshControlProps>;
};

// ── Scaffold ────────────────────────────────────────────────────────────

export function ScreenScaffold({
  eyebrow,
  title,
  description,
  backHref,
  backLabel = 'Back',
  hideBack = false,
  children,
  scrollable = true,
  testID,
  refreshControl,
}: ScreenScaffoldProps) {
  const router = useRouter();
  const { colors } = useTheme();
  const styles = useMemo(() => createStyles(colors), [colors]);

  const handleBack = () => {
    if (backHref) {
      router.push(backHref);
      return;
    }
    if (router.canGoBack()) router.back();
    else router.push('/');
  };

  const ContentInner = (
    <>
      {eyebrow ? <Text style={styles.eyebrow}>{eyebrow}</Text> : null}
      {description ? <Text style={styles.description}>{description}</Text> : null}
      {children}
    </>
  );

  return (
    <SafeAreaView style={styles.root} edges={['top']} testID={testID}>
      {/* The house header: FlowHeader itself, not an imitation of it.

          The title belongs beside the back control, which is where Send, Swap,
          Receive and every other screen put it. This had the back button alone
          on one row and the title underneath in the body, so a scaffolded page
          started a line lower than its neighbours and read as a different
          layout — which it was. */}
      <View style={styles.header}>
        {hideBack ? (
          <Text style={styles.title}>{title}</Text>
        ) : (
          <FlowHeader title={title} onBack={handleBack} />
        )}
      </View>

      {scrollable ? (
        <ScrollView
          style={styles.scroll}
          contentContainerStyle={styles.scrollContent}
          showsVerticalScrollIndicator={false}
          refreshControl={refreshControl}
        >
          <View style={styles.body}>{ContentInner}</View>
        </ScrollView>
      ) : (
        <View style={styles.body}>{ContentInner}</View>
      )}
    </SafeAreaView>
  );
}

// ── Coming-soon badge ────────────────────────────────────────────────────
export function ComingSoonBadge({ note }: { note?: string }) {
  const { colors } = useTheme();
  const styles = useMemo(() => createStyles(colors), [colors]);
  return (
    <View style={styles.comingSoon}>
      <Text style={styles.comingSoonDot}>•</Text>
      <Text style={styles.comingSoonLabel}>Coming soon</Text>
      {note ? <Text style={styles.comingSoonNote}>{note}</Text> : null}
    </View>
  );
}

// ── Link row used to satisfy "every route is reachable via navigation" ───
export function NavRow({
  href,
  label,
  hint,
}: {
  href: Href;
  label: string;
  hint?: string;
}) {
  const router = useRouter();
  const { colors } = useTheme();
  const styles = useMemo(() => createStyles(colors), [colors]);
  return (
    <Pressable
      accessibilityRole="link"
      onPress={() => router.push(href)}
      style={({ pressed }) => [styles.navRow, pressed && styles.navRowPressed]}
    >
      <Text style={styles.navRowLabel}>{label}</Text>
      {hint ? <Text style={styles.navRowHint}>{hint}</Text> : null}
      <Text style={styles.navRowChevron}>›</Text>
    </Pressable>
  );
}

// ── Styles ───────────────────────────────────────────────────────────────
const createStyles = (colors: ThemeColors) =>
  StyleSheet.create({
    root: {
      flex: 1,
      backgroundColor: colors.background,
    },
    header: {
      flexDirection: 'row',
      alignItems: 'center',
      paddingHorizontal: 20,
      paddingTop: 16,
      paddingBottom: 4,
    },
    pressed: { opacity: 0.6 },
    scroll: { flex: 1 },
    scrollContent: { flexGrow: 1, paddingBottom: 32 },
    body: {
      paddingHorizontal: 20,
      paddingTop: 20,
      gap: 12,
    },
    eyebrow: {
      fontFamily: fontFamily.accent,
      color: colors.textMuted,
      fontSize: 11,
      letterSpacing: 0.8,
      textTransform: 'uppercase',
    },
    title: {
      fontFamily: fontFamily.heading,
      color: colors.textStrong,
      // 26 to match FlowHeader exactly: on a tab destination this renders in
      // place of it, and two title sizes for the same role is the drift.
      fontSize: 26,
    },
    description: {
      fontFamily: fontFamily.body,
      color: colors.textMuted,
      fontSize: 14,
      lineHeight: 20,
    },
    comingSoon: {
      marginTop: 24,
      paddingVertical: 10,
      paddingHorizontal: 14,
      backgroundColor: colors.surface,
      borderColor: colors.border,
      borderWidth: StyleSheet.hairlineWidth,
      borderRadius: 999,
      flexDirection: 'row',
      alignItems: 'center',
      gap: 8,
      alignSelf: 'flex-start',
    },
    comingSoonDot: {
      color: colors.accent,
      fontSize: 22,
      marginTop: -4,
    },
    comingSoonLabel: {
      fontFamily: fontFamily.accent,
      color: colors.accent,
      fontSize: 12,
      letterSpacing: 0.8,
      textTransform: 'uppercase',
    },
    comingSoonNote: {
      fontFamily: fontFamily.body,
      color: colors.textMuted,
      fontSize: 12,
    },
    navRow: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: 12,
      paddingHorizontal: 16,
      paddingVertical: 14,
      backgroundColor: colors.surface,
      borderColor: colors.border,
      borderWidth: StyleSheet.hairlineWidth,
      borderRadius: 12,
    },
    navRowPressed: { opacity: 0.7 },
    navRowLabel: {
      fontFamily: fontFamily.bodySemiBold,
      color: colors.textPrimary,
      fontSize: 15,
      flex: 1,
    },
    navRowHint: {
      fontFamily: fontFamily.body,
      color: colors.textMuted,
      fontSize: 12,
      maxWidth: 180,
      textAlign: 'right',
    },
    navRowChevron: {
      color: colors.textMuted,
      fontSize: 22,
      lineHeight: 22,
    },
  });
