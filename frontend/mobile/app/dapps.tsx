/**
 * The dApp directory.
 *
 * A list of the Stellar dApps Veil supports, read straight from the same
 * module as the browser's allow-list (`lib/dappAllowlist.ts`) so the directory
 * and what the browser will actually open can never drift apart. Tapping an
 * entry opens the browser shell at exactly that origin.
 *
 * The search filter matches name and category, and a query with no matches
 * shows an empty state rather than a blank screen.
 */

import { useMemo, useState } from 'react';
import { Image, Pressable, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useRouter } from 'expo-router';

import { FlowHeader } from '../components/FlowHeader';
import { useTheme } from '../hooks/useTheme';
import { filterDapps, type DappEntry } from '../lib/dappAllowlist';
import type { ThemeColors } from '../lib/theme';
import { fontFamily } from '../theme/typography';

export default function DappDirectoryScreen() {
  const router = useRouter();
  const { colors } = useTheme();
  const styles = useMemo(() => createStyles(colors), [colors]);
  const [query, setQuery] = useState('');

  const results = useMemo(() => filterDapps(query), [query]);
  const isEmpty = results.length === 0;

  return (
    <SafeAreaView style={styles.screen} edges={['top']} testID="dapp-directory">
      <View style={styles.header}>
        <FlowHeader title="Discover" />
      </View>

      <View style={styles.searchWrap}>
        <TextInput
          value={query}
          onChangeText={setQuery}
          placeholder="Search by name or category"
          placeholderTextColor={colors.textFaint}
          autoCapitalize="none"
          autoCorrect={false}
          returnKeyType="search"
          accessibilityLabel="Search dApps"
          style={styles.search}
          testID="dapp-search"
        />
      </View>

      <ScrollView
        showsVerticalScrollIndicator={false}
        contentContainerStyle={styles.content}
        keyboardShouldPersistTaps="handled"
      >
        <Text style={styles.eyebrow}>
          {isEmpty
            ? 'NO MATCHES'
            : `${results.length} ${results.length === 1 ? 'DAPP' : 'DAPPS'}`}
        </Text>

        {isEmpty ? (
          <View style={styles.empty} testID="dapp-directory-empty">
            <Text style={styles.emptyTitle}>No dApps match “{query.trim()}”</Text>
            <Text style={styles.emptyMessage}>
              Try a category like Swap, Trade or Learn — or clear the search to see everything Veil
              supports.
            </Text>
            <Pressable
              accessibilityRole="button"
              onPress={() => setQuery('')}
              style={({ pressed }) => [styles.secondary, pressed && styles.pressed]}
            >
              <Text style={styles.secondaryText}>Clear search</Text>
            </Pressable>
          </View>
        ) : (
          results.map((entry) => (
            <DappRow
              key={entry.id}
              entry={entry}
              colors={colors}
              styles={styles}
              onPress={() =>
                router.push({ pathname: '/dapp', params: { origin: entry.origin } })
              }
            />
          ))
        )}
      </ScrollView>
    </SafeAreaView>
  );
}

function DappRow({
  entry,
  colors,
  styles,
  onPress,
}: {
  entry: DappEntry;
  colors: ThemeColors;
  styles: ReturnType<typeof createStyles>;
  onPress: () => void;
}) {
  const [iconFailed, setIconFailed] = useState(false);

  return (
    <Pressable
      accessibilityRole="link"
      accessibilityLabel={`${entry.name}, ${entry.category}`}
      accessibilityHint={`Opens ${entry.origin}`}
      onPress={onPress}
      style={({ pressed }) => [styles.row, pressed && styles.pressed]}
      testID={`dapp-row-${entry.id}`}
    >
      {iconFailed ? (
        <View style={styles.iconFallback}>
          <Text style={styles.iconFallbackText}>{entry.name.slice(0, 1).toUpperCase()}</Text>
        </View>
      ) : (
        <Image
          source={{ uri: entry.icon }}
          style={styles.icon}
          onError={() => setIconFailed(true)}
          accessibilityIgnoresInvertColors
        />
      )}

      <View style={styles.rowText}>
        <View style={styles.rowTop}>
          <Text style={styles.rowName}>{entry.name}</Text>
          <View style={styles.categoryPill}>
            <Text style={styles.categoryText}>{entry.category}</Text>
          </View>
        </View>
        <Text style={styles.rowDescription}>{entry.description}</Text>
        <Text style={styles.rowOrigin} numberOfLines={1}>
          {entry.origin}
        </Text>
      </View>

      <Text style={styles.chevron}>›</Text>
    </Pressable>
  );
}

const createStyles = (colors: ThemeColors) =>
  StyleSheet.create({
    screen: { flex: 1, backgroundColor: colors.background },
    header: { paddingHorizontal: 20, paddingTop: 16 },
    searchWrap: { paddingHorizontal: 20, paddingTop: 12 },
    search: {
      backgroundColor: colors.surfaceMd,
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: colors.border,
      borderRadius: 14,
      paddingHorizontal: 16,
      paddingVertical: 12,
      color: colors.textPrimary,
      fontFamily: fontFamily.body,
      fontSize: 15,
    },
    content: { padding: 20, paddingBottom: 48, gap: 10 },
    eyebrow: {
      color: colors.textMuted,
      fontFamily: fontFamily.accent,
      fontSize: 11,
      letterSpacing: 1,
      marginBottom: 2,
    },
    row: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: 14,
      padding: 14,
      borderRadius: 16,
      backgroundColor: colors.surface,
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: colors.border,
    },
    icon: {
      width: 44,
      height: 44,
      borderRadius: 12,
      backgroundColor: colors.surfaceMd,
    },
    iconFallback: {
      width: 44,
      height: 44,
      borderRadius: 12,
      backgroundColor: colors.surfaceMd,
      alignItems: 'center',
      justifyContent: 'center',
    },
    iconFallbackText: {
      color: colors.accent,
      fontFamily: fontFamily.bodySemiBold,
      fontSize: 18,
    },
    rowText: { flex: 1, gap: 3 },
    rowTop: { flexDirection: 'row', alignItems: 'center', gap: 8 },
    rowName: { color: colors.textStrong, fontFamily: fontFamily.bodySemiBold, fontSize: 16 },
    categoryPill: {
      paddingHorizontal: 8,
      paddingVertical: 2,
      borderRadius: 999,
      backgroundColor: colors.surfaceMd,
    },
    categoryText: {
      color: colors.textMuted,
      fontFamily: fontFamily.bodyMedium,
      fontSize: 10,
      letterSpacing: 0.5,
      textTransform: 'uppercase',
    },
    rowDescription: {
      color: colors.textMuted,
      fontFamily: fontFamily.body,
      fontSize: 13,
      lineHeight: 18,
    },
    rowOrigin: { color: colors.textFaint, fontFamily: fontFamily.address, fontSize: 11 },
    chevron: { color: colors.textFaint, fontSize: 22 },
    empty: {
      marginTop: 24,
      padding: 20,
      borderRadius: 16,
      backgroundColor: colors.surface,
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: colors.border,
      gap: 10,
    },
    emptyTitle: { color: colors.textStrong, fontFamily: fontFamily.bodySemiBold, fontSize: 17 },
    emptyMessage: {
      color: colors.textMuted,
      fontFamily: fontFamily.body,
      fontSize: 14,
      lineHeight: 20,
    },
    secondary: {
      marginTop: 4,
      alignItems: 'center',
      paddingVertical: 12,
      borderRadius: 100,
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: colors.border,
    },
    secondaryText: { color: colors.textPrimary, fontFamily: fontFamily.bodyMedium, fontSize: 14 },
    pressed: { opacity: 0.7 },
  });
