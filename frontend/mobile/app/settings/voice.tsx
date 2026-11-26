/**
 * Voice & assistants — what the assistant can and can never do.
 *
 * The page exists because a talking wallet creates beliefs. If the boundary
 * only lives in the team's heads, someone eventually adds "send by voice" as a
 * small convenience and nobody notices what changed. This screen is the
 * in-app half of that written record; `frontend/docs/pages/voice.mdx` is the
 * long-form one, and the facts themselves live in `lib/voice/boundary.ts` so
 * the two cannot drift.
 *
 * It is reached from Settings, which is where a user goes looking when they
 * want to know what they have just given a voice assistant permission to do.
 * The page states only what is true today — it makes no promise about what a
 * later version might support.
 */

import type { ReactNode } from 'react';
import { useMemo } from 'react';
import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { FlowHeader } from '../../components/FlowHeader';

import { useTheme } from '../../hooks/useTheme';
import { openExternalUrl } from '../../lib/about';
import type { ThemeColors } from '../../lib/theme';
import {
  VOICE_AUTHORISATION,
  VOICE_BOUNDARY_DOC_URL,
  VOICE_DOES,
  VOICE_NEVER_DOES,
  VOICE_PLATFORM_CONSTRAINTS,
  type VoiceFact,
} from '../../lib/voice/boundary';
import { fontFamily, typography } from '../../theme/typography';

export default function VoiceScreen() {
  const { colors } = useTheme();
  const styles = useMemo(() => createStyles(colors), [colors]);

  return (
    <SafeAreaView style={styles.screen} edges={['top']} testID="voice-screen">
      <View style={styles.header}>
        <FlowHeader title="Voice & assistants" />
      </View>
      <ScrollView showsVerticalScrollIndicator={false} contentContainerStyle={styles.content}>
        <View style={styles.card}>
          <Text style={styles.lead}>
            The assistant reads, and that is all. Asking about your balance or a price costs
            nothing; nothing an assistant asks can move money.
          </Text>
        </View>

        <Section title="What it does" styles={styles}>
          {VOICE_DOES.map((fact) => (
            <Fact key={fact.key} fact={fact} styles={styles} />
          ))}
        </Section>

        <Section title="What it never does" styles={styles}>
          {VOICE_NEVER_DOES.map((fact) => (
            <Fact key={fact.key} fact={fact} styles={styles} />
          ))}
        </Section>

        <Section title="What authorises a payment" styles={styles}>
          {VOICE_AUTHORISATION.map((step, index) => (
            <View key={step} style={styles.step}>
              <Text style={styles.stepNumber}>{index + 1}</Text>
              <Text style={styles.stepText}>{step}</Text>
            </View>
          ))}
        </Section>

        <Section title="Platform constraints" styles={styles}>
          {VOICE_PLATFORM_CONSTRAINTS.map((fact) => (
            <Fact key={fact.key} fact={fact} styles={styles} />
          ))}
        </Section>

        <Pressable
          accessibilityRole="link"
          onPress={() => void openExternalUrl(VOICE_BOUNDARY_DOC_URL)}
          style={({ pressed }) => [styles.linkRow, pressed && styles.pressed]}
          testID="voice-docs-link"
        >
          <View style={styles.linkText}>
            <Text style={styles.linkLabel}>The full page</Text>
            <Text style={styles.hint}>
              The same boundary in full, in the documentation
            </Text>
          </View>
          <Text style={styles.chevron}>›</Text>
        </Pressable>

        <Text style={styles.footnote}>
          This page describes what the app does now. It says nothing about what a later version
          might do — come back and read it again if that changes.
        </Text>
      </ScrollView>
    </SafeAreaView>
  );
}

function Section({
  title,
  styles,
  children,
}: {
  title: string;
  styles: ReturnType<typeof createStyles>;
  children: ReactNode;
}) {
  return (
    <>
      <Text style={styles.sectionLabel}>{title}</Text>
      <View style={styles.card}>{children}</View>
    </>
  );
}

function Fact({ fact, styles }: { fact: VoiceFact; styles: ReturnType<typeof createStyles> }) {
  return (
    <View style={styles.fact}>
      <Text style={styles.factClaim}>{fact.claim}</Text>
      <Text style={styles.factDetail}>{fact.detail}</Text>
    </View>
  );
}

const createStyles = (colors: ThemeColors) =>
  StyleSheet.create({
    screen: { flex: 1, backgroundColor: colors.background },
    header: { paddingHorizontal: 20, paddingTop: 16 },
    content: { padding: 20, paddingBottom: 48, gap: 14 },
    sectionLabel: {
      ...typography.accent,
      color: colors.textMuted,
      fontSize: 11,
      marginTop: 10,
    },
    card: {
      backgroundColor: colors.surface,
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: colors.border,
      borderRadius: 16,
      padding: 18,
      gap: 14,
    },
    lead: { fontFamily: fontFamily.body, fontSize: 15, lineHeight: 23, color: colors.textPrimary },
    fact: { gap: 3 },
    factClaim: { fontFamily: fontFamily.bodySemiBold, fontSize: 15, color: colors.textStrong },
    factDetail: { fontFamily: fontFamily.body, fontSize: 13, lineHeight: 19, color: colors.textMuted },
    step: { flexDirection: 'row', gap: 10, alignItems: 'flex-start' },
    stepNumber: {
      fontFamily: fontFamily.bodySemiBold,
      fontSize: 13,
      color: colors.accentText,
      minWidth: 16,
    },
    stepText: {
      flex: 1,
      fontFamily: fontFamily.body,
      fontSize: 13,
      lineHeight: 19,
      color: colors.textMuted,
    },
    linkRow: {
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'space-between',
      gap: 12,
      paddingVertical: 6,
      paddingHorizontal: 4,
    },
    linkText: { flex: 1, gap: 2 },
    linkLabel: { fontFamily: fontFamily.bodyMedium, fontSize: 15, color: colors.textPrimary },
    chevron: { fontFamily: fontFamily.body, fontSize: 20, color: colors.textFaint },
    hint: { fontFamily: fontFamily.body, fontSize: 13, lineHeight: 19, color: colors.textMuted },
    pressed: { opacity: 0.7 },
    footnote: {
      fontFamily: fontFamily.body,
      fontSize: 12,
      lineHeight: 18,
      color: colors.textFaint,
      marginTop: 6,
    },
  });
