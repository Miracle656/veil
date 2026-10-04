/**
 * Profile — the mobile port of the web wallet's `app/settings/profile/page.tsx`.
 *
 * The same four fields in the same order, the same fifteen languages and four
 * roles, the same five personas, and the same defaults, so a profile set up in
 * the browser reads identically here. What differs is the plumbing: the web page
 * reads and writes `localStorage` synchronously during render, so the draft is
 * loaded in an effect here and every value is validated on its way in and out
 * (lib/agentProfile.ts).
 *
 * The name is the only free-text field, so it is the only one with something to
 * validate. It is bounded at {@link MAX_NAME_LENGTH} and scrubbed of control
 * characters before it is stored, because a name is interpolated into the
 * agent's greeting — a newline in there would put a fake line break in the
 * middle of anything that later prints it.
 *
 * Nothing on this screen puts the name anywhere but AsyncStorage. It is not a
 * route parameter, because expo-router would carry it in the URL, and deep
 * links are readable by other apps and end up in server logs; and it is not
 * logged, because a log line is a copy that outlives the setting. If the profile
 * ever needs to reach the agent, that goes in the POST body with the message,
 * which is where it already goes (lib/agentClient.ts).
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import { Pressable, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { FlowHeader } from '../../components/FlowHeader';

import { useTheme } from '../../hooks/useTheme';
import {
  DEFAULT_PROFILE,
  LANGUAGES,
  MAX_NAME_LENGTH,
  PERSONAS,
  ROLES,
  loadProfile,
  nameProblem,
  normaliseProfile,
  replaceProfile,
  resetProfile,
  type CompleteProfile,
} from '../../lib/agentProfile';
import type { ThemeColors } from '../../lib/theme';
import { fontFamily, typography } from '../../theme/typography';

export default function ProfileSettingsScreen() {
  const { colors } = useTheme();
  const styles = useMemo(() => createStyles(colors), [colors]);

  const [draft, setDraft] = useState<CompleteProfile>({ ...DEFAULT_PROFILE });
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    let alive = true;
    void loadProfile().then((stored) => {
      if (alive) setDraft(normaliseProfile(stored));
    });
    return () => {
      alive = false;
    };
  }, []);

  // The same two seconds the web page holds its "Saved!" for.
  useEffect(() => {
    if (!saved) return;
    const timer = setTimeout(() => setSaved(false), 2000);
    return () => clearTimeout(timer);
  }, [saved]);

  const problem = nameProblem(draft.name);

  const save = useCallback(() => {
    if (problem) return;
    void replaceProfile(draft).then((stored) => {
      setDraft(stored);
      setSaved(true);
    });
  }, [draft, problem]);

  const reset = useCallback(() => {
    void resetProfile().then(() => {
      setDraft({ ...DEFAULT_PROFILE });
      setSaved(false);
    });
  }, []);

  return (
    <SafeAreaView style={styles.screen} edges={['top']} testID="profile-screen">
      <View style={styles.header}>
        <FlowHeader title="Profile" />
      </View>
      <ScrollView
        showsVerticalScrollIndicator={false}
        contentContainerStyle={styles.content}
        keyboardShouldPersistTaps="handled"
      >
        <View style={styles.card}>
          <Text style={styles.label}>YOUR NAME</Text>
          <TextInput
            style={styles.input}
            placeholder="How should the agent address you?"
            placeholderTextColor={colors.textFaint}
            value={draft.name}
            onChangeText={(name) => setDraft((prev) => ({ ...prev, name }))}
            maxLength={MAX_NAME_LENGTH}
            autoComplete="off"
            autoCorrect={false}
            accessibilityLabel="Your name"
          />
          <Text style={problem ? styles.problem : styles.hint}>
            {problem ?? 'The agent will greet you by name'}
          </Text>
        </View>

        <View style={styles.card}>
          <Text style={styles.label}>WALLET ROLE</Text>
          <View style={styles.options}>
            {ROLES.map((role) => (
              <Option
                key={role.value}
                label={role.label}
                description={role.desc}
                selected={draft.role === role.value}
                onPress={() => setDraft((prev) => ({ ...prev, role: role.value }))}
                styles={styles}
              />
            ))}
          </View>
          <Text style={styles.hint}>Affects what your agent suggests when you receive funds</Text>
        </View>

        <View style={styles.card}>
          <Text style={styles.label}>LANGUAGE</Text>
          <View style={styles.pills}>
            {LANGUAGES.map((language) => {
              const selected = draft.language === language;
              return (
                <Pressable
                  key={language}
                  accessibilityRole="radio"
                  accessibilityState={{ selected }}
                  accessibilityLabel={language}
                  onPress={() => setDraft((prev) => ({ ...prev, language }))}
                  style={({ pressed }) => [
                    styles.pill,
                    selected && styles.pillSelected,
                    pressed && styles.pressed,
                  ]}
                >
                  <Text style={[styles.pillText, selected && styles.pillTextSelected]}>
                    {language}
                  </Text>
                </Pressable>
              );
            })}
          </View>
          <Text style={styles.hint}>The agent will respond in your preferred language</Text>
        </View>

        <View style={styles.card}>
          <Text style={styles.label}>AGENT PERSONALITY</Text>
          <View style={styles.options}>
            {PERSONAS.map((persona) => (
              <Option
                key={persona.label}
                label={persona.label}
                description={persona.desc}
                selected={draft.persona === persona.value}
                onPress={() => setDraft((prev) => ({ ...prev, persona: persona.value }))}
                styles={styles}
              />
            ))}
          </View>
        </View>

        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Save profile"
          accessibilityState={{ disabled: Boolean(problem) }}
          disabled={Boolean(problem)}
          onPress={save}
          style={({ pressed }) => [styles.primary, pressed && styles.pressed]}
        >
          <Text style={styles.primaryText}>{saved ? 'Saved!' : 'Save Profile'}</Text>
        </Pressable>

        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Reset to defaults"
          onPress={reset}
          style={({ pressed }) => [styles.secondary, pressed && styles.pressed]}
        >
          <Text style={styles.secondaryText}>Reset to Defaults</Text>
        </Pressable>
      </ScrollView>
    </SafeAreaView>
  );
}

/**
 * One selectable row: a title, a line of explanation, and a tick when chosen.
 *
 * The web page gives each role its own icon; there is no matching set in
 * components/icons.tsx, so the tick carries the selected state the way it does on
 * the security screen.
 */
function Option({
  label,
  description,
  selected,
  onPress,
  styles,
}: {
  label: string;
  description: string;
  selected: boolean;
  onPress: () => void;
  styles: ReturnType<typeof createStyles>;
}) {
  return (
    <Pressable
      accessibilityRole="radio"
      accessibilityState={{ selected }}
      accessibilityLabel={label}
      onPress={onPress}
      style={[styles.option, selected && styles.optionSelected]}
    >
      <View style={styles.optionCopy}>
        <Text style={[styles.optionLabel, selected && styles.optionLabelSelected]}>{label}</Text>
        <Text style={styles.optionDescription}>{description}</Text>
      </View>
      {selected && <Text style={styles.optionCheck}>✓</Text>}
    </Pressable>
  );
}

const createStyles = (colors: ThemeColors) =>
  StyleSheet.create({
    screen: { flex: 1, backgroundColor: colors.background },
    header: { paddingHorizontal: 20, paddingTop: 16 },
    content: { padding: 20, paddingBottom: 48, gap: 14 },
    card: {
      backgroundColor: colors.surface,
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: colors.border,
      borderRadius: 16,
      padding: 18,
      gap: 12,
    },
    label: { ...typography.accent, color: colors.label, fontSize: 12 },
    input: {
      backgroundColor: colors.surfaceMd,
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: colors.border,
      borderRadius: 12,
      paddingHorizontal: 14,
      paddingVertical: 12,
      color: colors.textPrimary,
      fontFamily: fontFamily.body,
      fontSize: 15,
    },
    hint: { fontFamily: fontFamily.body, fontSize: 13, lineHeight: 19, color: colors.textMuted },
    problem: { color: colors.danger, fontFamily: fontFamily.body, fontSize: 13, lineHeight: 19 },
    options: { gap: 8 },
    option: {
      alignItems: 'center',
      backgroundColor: colors.surface,
      borderColor: colors.border,
      borderRadius: 12,
      borderWidth: StyleSheet.hairlineWidth,
      flexDirection: 'row',
      gap: 12,
      padding: 14,
    },
    optionSelected: { borderColor: colors.accent, backgroundColor: colors.surfaceMd },
    optionCopy: { flex: 1, gap: 3 },
    optionLabel: { color: colors.textPrimary, fontFamily: fontFamily.bodyMedium, fontSize: 15 },
    optionLabelSelected: { color: colors.accentText },
    optionDescription: {
      color: colors.textMuted,
      fontFamily: fontFamily.body,
      fontSize: 13,
      lineHeight: 18,
    },
    optionCheck: { color: colors.accentText, fontSize: 16, fontFamily: fontFamily.bodySemiBold },
    pills: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
    pill: {
      paddingHorizontal: 14,
      paddingVertical: 8,
      borderRadius: 100,
      backgroundColor: colors.surfaceMd,
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: colors.border,
    },
    pillSelected: { borderColor: colors.accent, backgroundColor: colors.surfaceMd },
    pillText: { color: colors.textPrimary, fontFamily: fontFamily.bodyMedium, fontSize: 13 },
    pillTextSelected: { color: colors.accentText },
    primary: {
      alignItems: 'center',
      paddingVertical: 14,
      borderRadius: 100,
      backgroundColor: colors.accent,
    },
    primaryText: { color: colors.onAccent, fontFamily: fontFamily.bodySemiBold, fontSize: 15 },
    secondary: {
      alignItems: 'center',
      paddingVertical: 12,
      borderRadius: 100,
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: colors.border,
    },
    secondaryText: { color: colors.textMuted, fontFamily: fontFamily.bodyMedium, fontSize: 14 },
    pressed: { opacity: 0.7 },
  });
