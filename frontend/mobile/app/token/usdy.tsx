import { useMemo, useState } from 'react';
import {
  Linking,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useRouter } from 'expo-router';

import { useTheme } from '../../hooks/useTheme';
import type { ThemeColors } from '../../lib/theme';
import { fontFamily } from '../../theme/typography';
import { FlowHeader } from '../../components/FlowHeader';
import { USDY_MAINNET_ISSUER } from '../../lib/assets';

const USDY_INFO = {
  code: 'USDY',
  name: 'Ondo US Dollar Yield',
  issuerName: 'Ondo Finance (Ondo USDY LLC)',
  issuerAddress: USDY_MAINNET_ISSUER,
  homeDomain: 'ondo.finance',
  disclosuresUrl: 'https://ondo.finance/usdy',
  // See the note in frontend/wallet/lib/usdy.ts: there is no prospectus, so
  // this is the issuer-declared redemption route.
  redemptionUrl: 'https://app.ondo.finance/assets/usdy',
  whatItIs:
    'USDY is a tokenized note backed by short-term US Treasury bills and bank demand deposits. It is issued on Stellar with open transferability (auth_required is false).',
  howValueAccrues:
    'The price per token adjusts upward over time as interest on underlying US Treasury bills accrues. It does not pay out separate periodic cash distributions; each token simply reflects a higher unit value over time.',
  backedBy:
    'Bankruptcy-remote SPV holding short-term US Treasuries and bank deposits, with third-party daily attestations.',
  risks: [
    {
      id: 'issuer-risk',
      title: 'Issuer & Custodian Risk',
      description:
        'USDY is an obligation of Ondo USDY LLC and relies on their custody arrangements. If the issuer or banking partners experience insolvency, token value may be impaired. It is not an obligation of the US Government.',
    },
    {
      id: 'liquidity-risk',
      title: 'Secondary Market Liquidity',
      description:
        'Liquidity on the Stellar DEX may be thin. Converting USDY back to USDC or XLM may involve a wide bid-ask spread or price slippage for larger orders.',
    },
    {
      id: 'price-fluctuation',
      title: 'Price Fluctuations & Loss',
      description:
        'The market price of USDY can fluctuate based on interest rate shifts or DEX order book depth. The price can fall, and buyers may experience losses upon sale.',
    },
    {
      id: 'not-insured',
      title: 'Not Insured / Not a Bank Account',
      description:
        'USDY is not a bank deposit, not a savings account, and is not insured by the FDIC, SIPC, or any government agency. It carries risk of principal loss.',
    },
  ],
};

export default function UsdyDetailScreen() {
  const router = useRouter();
  const { colors } = useTheme();
  const styles = useMemo(() => createStyles(colors), [colors]);

  const [acknowledged, setAcknowledged] = useState(false);

  return (
    <SafeAreaView style={styles.safe} edges={['top', 'bottom']}>
      <FlowHeader title="ASSET DETAIL · USDY" onBack={() => router.back()} />

      <ScrollView
        style={styles.scroll}
        contentContainerStyle={styles.content}
        showsVerticalScrollIndicator={false}
      >
        {/* Token Header */}
        <View style={styles.headerBox}>
          <View style={styles.avatar}>
            <Text style={styles.avatarText}>$</Text>
          </View>
          <Text style={styles.tokenName}>{USDY_INFO.name}</Text>
          <View style={styles.tagRow}>
            <View style={styles.codeTag}>
              <Text style={styles.codeTagText}>{USDY_INFO.code}</Text>
            </View>
            <Text style={styles.categoryText}>Tokenized Real-World Asset</Text>
          </View>
        </View>

        {/* Section 1: What is USDY */}
        <View style={styles.card}>
          <Text style={styles.sectionLabel}>WHAT IS USDY?</Text>
          <Text style={styles.bodyText}>{USDY_INFO.whatItIs}</Text>
          <View style={styles.backingBox}>
            <Text style={styles.backingLabel}>Backing:</Text>
            <Text style={styles.backingText}>{USDY_INFO.backedBy}</Text>
          </View>
        </View>

        {/* Section 2: Issuer & Disclosures */}
        <View style={styles.card}>
          <Text style={styles.sectionLabel}>ISSUER & DISCLOSURES</Text>
          <Text style={styles.issuerText}>
            Issued by <Text style={styles.issuerHighlight}>{USDY_INFO.issuerName}</Text>
          </Text>
          <Text style={styles.addressText}>Issuer: {USDY_INFO.issuerAddress}</Text>

          <View style={styles.linkRow}>
            <Pressable
              style={styles.linkButton}
              onPress={() => Linking.openURL(USDY_INFO.disclosuresUrl)}
            >
              <Text style={styles.linkButtonText}>Official Disclosures (ondo.finance) ↗</Text>
            </Pressable>
            <Pressable
              style={styles.linkButton}
              onPress={() => Linking.openURL(USDY_INFO.redemptionUrl)}
            >
              <Text style={styles.linkButtonText}>How to Redeem (Ondo) ↗</Text>
            </Pressable>
          </View>
        </View>

        {/* Section 3: How Value Accrues */}
        <View style={styles.card}>
          <Text style={styles.sectionLabel}>HOW VALUE ACCRUES</Text>
          <Text style={styles.bodyText}>{USDY_INFO.howValueAccrues}</Text>
        </View>

        {/* Section 4: Key Risks (Stated before buy) */}
        <View style={styles.riskCard}>
          <View style={styles.riskHeader}>
            <Text style={styles.warningIcon}>⚠</Text>
            <Text style={styles.riskLabel}>KEY RISKS (WHAT CAN GO WRONG)</Text>
          </View>

          {USDY_INFO.risks.map((risk) => (
            <View key={risk.id} style={styles.riskItem}>
              <Text style={styles.riskItemTitle}>{risk.title}</Text>
              <Text style={styles.riskItemDesc}>{risk.description}</Text>
            </View>
          ))}

          <Text style={styles.disclaimerText}>
            • Veil does not take custody of your assets, does not provide investment advice, and is not a broker or dealer.{'\n'}
            • You are interacting directly with the Stellar decentralized network.
          </Text>
        </View>

        {/* Section 5: Acknowledgement & Action */}
        <Pressable
          style={styles.ackRow}
          onPress={() => setAcknowledged((prev) => !prev)}
        >
          <View style={[styles.checkbox, acknowledged && styles.checkboxChecked]}>
            {acknowledged && <Text style={styles.checkmark}>✓</Text>}
          </View>
          <Text style={styles.ackText}>
            I have read the disclosures, understand how USDY functions, and acknowledge the associated risks.
          </Text>
        </Pressable>

        <Pressable
          style={[styles.buyButton, !acknowledged && styles.buyButtonDisabled]}
          disabled={!acknowledged}
          onPress={() => {
            router.push(`/swap?to=USDY&issuer=${USDY_INFO.issuerAddress}` as any);
          }}
        >
          <Text style={styles.buyButtonText}>Swap / Buy USDY on DEX</Text>
        </Pressable>
      </ScrollView>
    </SafeAreaView>
  );
}

/**
 * `colors: any` was hiding a screen that did not theme at all.
 *
 * Every lookup here named a token that does not exist on `ThemeColors` —
 * `colors.primary`, `colors.text` — so each one was `undefined` and each `||`
 * fell through to the hardcoded dark value beside it. The screen looked
 * correct in dark mode and stayed dark in light mode, and because the
 * parameter was `any`, nothing in the typechecker had an opinion about it.
 * That is the whole reason the annotation matters: with `ThemeColors` in
 * place, a misnamed role is a build error rather than a silent fallback.
 *
 * The roles are now the real ones: `accent` for fills and `accentText` for
 * gold-on-background text (light mode darkens the gold so it keeps contrast
 * on white), `positive` for the backing note, `danger`/`dangerSurface` for the
 * risk panel, and no literal colours left.
 */
function createStyles(colors: ThemeColors) {
  return StyleSheet.create({
    safe: {
      flex: 1,
      backgroundColor: colors.background,
    },
    scroll: {
      flex: 1,
    },
    content: {
      paddingHorizontal: 20,
      paddingBottom: 40,
    },
    headerBox: {
      alignItems: 'center',
      paddingVertical: 16,
      gap: 8,
    },
    avatar: {
      width: 56,
      height: 56,
      borderRadius: 28,
      backgroundColor: colors.surfaceMd,
      borderWidth: 1,
      borderColor: colors.borderStrong,
      alignItems: 'center',
      justifyContent: 'center',
    },
    avatarText: {
      fontSize: 24,
      color: colors.accentText,
      fontFamily: fontFamily.accent,
    },
    tokenName: {
      fontSize: 20,
      color: colors.textStrong,
      fontFamily: fontFamily.heading,
      textAlign: 'center',
    },
    tagRow: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: 8,
    },
    codeTag: {
      backgroundColor: colors.surfaceMd,
      borderWidth: 1,
      borderColor: colors.border,
      paddingHorizontal: 8,
      paddingVertical: 2,
      borderRadius: 6,
    },
    codeTagText: {
      fontSize: 12,
      fontFamily: fontFamily.address,
      color: colors.accentText,
    },
    categoryText: {
      fontSize: 13,
      fontFamily: fontFamily.body,
      color: colors.textMuted,
    },
    card: {
      backgroundColor: colors.surface,
      borderRadius: 14,
      padding: 16,
      marginBottom: 14,
      borderWidth: 1,
      borderColor: colors.border,
    },
    sectionLabel: {
      fontSize: 11,
      letterSpacing: 0.8,
      fontFamily: fontFamily.accent,
      color: colors.label,
      marginBottom: 8,
    },
    bodyText: {
      fontSize: 14,
      lineHeight: 21,
      fontFamily: fontFamily.body,
      color: colors.textPrimary,
    },
    backingBox: {
      marginTop: 10,
      padding: 10,
      backgroundColor: colors.surfaceMd,
      borderRadius: 8,
      borderWidth: 1,
      borderColor: colors.border,
    },
    backingLabel: {
      fontSize: 12,
      fontFamily: fontFamily.bodySemiBold,
      color: colors.positive,
      marginBottom: 2,
    },
    backingText: {
      fontSize: 12,
      fontFamily: fontFamily.body,
      color: colors.textSecondary,
      lineHeight: 18,
    },
    issuerText: {
      fontSize: 14,
      fontFamily: fontFamily.body,
      color: colors.textPrimary,
      marginBottom: 4,
    },
    issuerHighlight: {
      fontFamily: fontFamily.bodySemiBold,
      color: colors.accentText,
    },
    addressText: {
      fontSize: 11,
      fontFamily: fontFamily.address,
      color: colors.textFaint,
      marginBottom: 12,
    },
    linkRow: {
      gap: 8,
    },
    linkButton: {
      paddingVertical: 8,
      paddingHorizontal: 12,
      backgroundColor: colors.surfaceMd,
      borderRadius: 8,
      borderWidth: 1,
      borderColor: colors.border,
    },
    linkButtonText: {
      fontSize: 13,
      fontFamily: fontFamily.bodyMedium,
      color: colors.accentText,
    },
    riskCard: {
      backgroundColor: colors.dangerSurface,
      borderRadius: 14,
      padding: 16,
      marginBottom: 16,
      borderWidth: 1,
      borderColor: colors.danger,
    },
    riskHeader: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: 6,
      marginBottom: 12,
    },
    warningIcon: {
      fontSize: 14,
      color: colors.danger,
    },
    riskLabel: {
      fontSize: 11,
      letterSpacing: 0.8,
      fontFamily: fontFamily.accent,
      color: colors.danger,
    },
    riskItem: {
      backgroundColor: colors.surface,
      padding: 10,
      borderRadius: 8,
      borderWidth: 1,
      borderColor: colors.border,
      marginBottom: 8,
    },
    riskItemTitle: {
      fontSize: 13,
      fontFamily: fontFamily.bodySemiBold,
      color: colors.textStrong,
      marginBottom: 3,
    },
    riskItemDesc: {
      fontSize: 12,
      fontFamily: fontFamily.body,
      color: colors.textSecondary,
      lineHeight: 18,
    },
    disclaimerText: {
      fontSize: 11,
      fontFamily: fontFamily.body,
      color: colors.textFaint,
      lineHeight: 16,
      marginTop: 8,
    },
    ackRow: {
      flexDirection: 'row',
      alignItems: 'flex-start',
      gap: 10,
      marginBottom: 16,
    },
    checkbox: {
      width: 20,
      height: 20,
      borderRadius: 4,
      borderWidth: 1,
      // borderStrong: a checkbox nobody can see is a checkbox nobody ticks,
      // and this one gates the buy button.
      borderColor: colors.borderStrong,
      alignItems: 'center',
      justifyContent: 'center',
      marginTop: 2,
    },
    checkboxChecked: {
      backgroundColor: colors.accent,
      borderColor: colors.accent,
    },
    checkmark: {
      fontSize: 13,
      fontFamily: fontFamily.bodySemiBold,
      color: colors.onAccent,
    },
    ackText: {
      flex: 1,
      fontSize: 12,
      fontFamily: fontFamily.body,
      color: colors.textSecondary,
      lineHeight: 18,
    },
    buyButton: {
      backgroundColor: colors.accent,
      paddingVertical: 14,
      borderRadius: 100,
      alignItems: 'center',
      justifyContent: 'center',
    },
    buyButtonDisabled: {
      opacity: 0.4,
    },
    buyButtonText: {
      fontSize: 15,
      fontFamily: fontFamily.bodySemiBold,
      color: colors.onAccent,
    },
  });
}
