import { ReactNode } from 'react';
import {
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useRouter, type Href } from 'expo-router';


// ── Design tokens (match web wallet dark theme) ───────────────────────────
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
}: ScreenScaffoldProps) {
  const router = useRouter();

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
      <Text style={styles.title}>{title}</Text>
      {description ? <Text style={styles.description}>{description}</Text> : null}
      {children}
    </>
  );

  return (
    <SafeAreaView style={styles.root} edges={['top']}>
      <View style={styles.header}>
        {hideBack ? (
          <View style={styles.headerSide} />
        ) : (
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={backLabel}
            onPress={handleBack}
            style={({ pressed }) => [styles.backButton, pressed && styles.pressed]}
            hitSlop={12}
          >
            <Text style={styles.backChevron}>←</Text>
            <Text style={styles.backLabel}>{backLabel}</Text>
          </Pressable>
        )}
        <Text style={styles.logo}>VEIL</Text>
        <View style={styles.headerSide} />
      </View>

      {scrollable ? (
        <ScrollView
          style={styles.scroll}
          contentContainerStyle={styles.scrollContent}
          showsVerticalScrollIndicator={false}
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
const styles = StyleSheet.create({
  root: {
    flex: 1,
    backgroundColor: colors.bg,
  },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 16,
    paddingVertical: 10,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: colors.border,
  },
  headerSide: {
    minWidth: 72,
  },
  backButton: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    paddingVertical: 4,
    minWidth: 72,
  },
  backChevron: {
    color: colors.offWhite,
    fontSize: 18,
    marginTop: -2,
  },
  backLabel: {
    color: colors.offWhite,
    fontSize: 14,
    fontWeight: '500',
  },
  logo: {
    color: colors.gold,
    fontSize: 18,
    fontWeight: '900',
    letterSpacing: 2,
  },
  pressed: { opacity: 0.6 },
  scroll: { flex: 1 },
  scrollContent: { flexGrow: 1, paddingBottom: 32 },
  body: {
    paddingHorizontal: 24,
    paddingTop: 20,
    gap: 12,
  },
  eyebrow: {
    color: colors.muted,
    fontSize: 11,
    fontWeight: '700',
    letterSpacing: 1.6,
    textTransform: 'uppercase',
  },
  title: {
    color: colors.offWhite,
    fontSize: 30,
    fontWeight: '700',
    letterSpacing: -0.4,
  },
  description: {
    color: colors.muted,
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
    color: colors.gold,
    fontSize: 22,
    marginTop: -4,
  },
  comingSoonLabel: {
    color: colors.gold,
    fontSize: 12,
    fontWeight: '700',
    letterSpacing: 1.4,
    textTransform: 'uppercase',
  },
  comingSoonNote: {
    color: colors.muted,
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
    color: colors.offWhite,
    fontSize: 15,
    fontWeight: '600',
    flex: 1,
  },
  navRowHint: {
    color: colors.muted,
    fontSize: 12,
    maxWidth: 180,
    textAlign: 'right',
  },
  navRowChevron: {
    color: colors.muted,
    fontSize: 22,
    lineHeight: 22,
  },
});
