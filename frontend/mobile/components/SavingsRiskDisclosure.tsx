import { useMemo } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';

import { useTheme } from '../hooks/useTheme';
import { explorerAddressUrl, openExternalUrl } from '../lib/about';
import { BLEND_FIXED_V2_MAINNET_POOL_ID } from '../lib/blend';
import { getNetwork, type VeilNetwork } from '../lib/network';
import type { ThemeColors } from '../lib/theme';
import { fontFamily } from '../theme/typography';

export interface SavingsRiskItem {
  id: 'protocol-exploit' | 'variable-rate' | 'pool-utilization';
  title: string;
  description: string;
}

export const SAVINGS_DISCLOSURE = {
  protocolName: 'Blend Protocol',
  poolName: 'Blend Fixed V2',
  poolContractId: BLEND_FIXED_V2_MAINNET_POOL_ID,
  notABankNotice:
    'This is not a bank deposit and nothing is insured — not by the FDIC, NDIC, SIPC, or any government agency.',
  exploitContext:
    'In February 2026 the Blend YieldBlox pool was drained of roughly $10 million by oracle manipulation (an attacker moved the price of USTRY on the Stellar DEX, the Reflector oracle reported the inflated price, and they borrowed against the overvalued collateral). Veil points at Blend Fixed V2, which is not the pool that was hit, but the failure was a design property of lending against oracle prices rather than a bug unique to one pool.',
  risks: [
    {
      id: 'protocol-exploit',
      title: 'Protocol & Oracle Exploit Risk',
      description:
        'The protocol can be exploited — smart contract bugs or oracle price manipulation can drain supplied funds.',
    },
    {
      id: 'variable-rate',
      title: 'Variable Rate (Never Promised)',
      description:
        'The rate is variable and not promised — it moves continuously with borrower demand and is only an observation at a point in time, never an annual guarantee.',
    },
    {
      id: 'pool-utilization',
      title: 'Liquidity & Full Utilization Risk',
      description:
        'A fully utilised pool cannot pay out immediately — if borrowers have drawn the available liquidity, withdrawals wait until loans are repaid or new supply arrives.',
    },
  ] satisfies readonly SavingsRiskItem[],
} as const;

/**
 * Format an observed lending rate with the timestamp it was read at, never as
 * an annual promise or projection.
 */
export function formatObservedRate(rateFraction: number, observedAt: Date | number | string | null): string {
  const pct = Number.isFinite(rateFraction) ? `${(rateFraction * 100).toFixed(2)}%` : '0.00%';
  if (observedAt === null || observedAt === undefined) {
    return `${pct} observed now (variable, not promised)`;
  }
  const date = observedAt instanceof Date ? observedAt : new Date(observedAt);
  if (Number.isNaN(date.getTime())) {
    return `${pct} observed now (variable, not promised)`;
  }
  const iso = date.toISOString().replace(/\.\d{3}Z$/, 'Z');
  return `${pct} observed at ${iso} (variable, not promised)`;
}

export interface SavingsRiskDisclosureProps {
  /** Override the pool name when a loaded pool metadata name is available. */
  poolName?: string;
  /** Override the pool contract ID; defaults to Blend Fixed V2 on mainnet. */
  poolId?: string;
  /** Active network used to build the contract explorer link. */
  network?: VeilNetwork;
  /** Optional acknowledgment state when gating a deposit button directly. */
  acknowledged?: boolean;
  /** Optional callback to toggle acknowledgment before depositing. */
  onToggleAcknowledge?: () => void;
}

/**
 * Shared risk panel for every savings / lending entry point (#1281).
 *
 * Follows the pattern established in `app/token/usdy.tsx`: short, specific, no
 * legal boilerplate. Names the protocol and the exact pool contract ID, links
 * to the pool on the ledger explorer and protocol docs, states the three real
 * risks in one line each, and states plainly that this is not a bank deposit
 * and nothing is insured.
 */
export function SavingsRiskDisclosure({
  poolName = SAVINGS_DISCLOSURE.poolName,
  poolId = SAVINGS_DISCLOSURE.poolContractId,
  network,
  acknowledged,
  onToggleAcknowledge,
}: SavingsRiskDisclosureProps) {
  const { colors } = useTheme();
  const styles = useMemo(() => createStyles(colors), [colors]);

  const activeNetwork = network ?? getNetwork();
  const resolvedPoolId = poolId.trim() || SAVINGS_DISCLOSURE.poolContractId;
  const displayPoolName =
    poolName.trim() && !poolName.toLowerCase().includes('blend')
      ? `Blend ${poolName.trim()}`
      : poolName.trim() || SAVINGS_DISCLOSURE.poolName;

  const contractExplorerUrl =
    explorerAddressUrl(resolvedPoolId, activeNetwork) ??
    `https://stellar.expert/explorer/public/contract/${resolvedPoolId}`;

  return (
    <View style={styles.riskCard} testID="savings-risk-disclosure">
      <View style={styles.riskHeader}>
        <Text style={styles.warningIcon}>⚠</Text>
        <Text style={styles.riskLabel}>KEY RISKS · NOT A BANK ACCOUNT</Text>
      </View>

      <View style={styles.notBankBox} testID="savings-not-a-bank-banner">
        <Text style={styles.notBankTitle}>Not a Bank Deposit · Nothing Is Insured</Text>
        <Text style={styles.notBankText}>{SAVINGS_DISCLOSURE.notABankNotice}</Text>
      </View>

      <View style={styles.protocolBox}>
        <Text style={styles.protocolText}>
          Protocol: <Text style={styles.protocolHighlight}>{SAVINGS_DISCLOSURE.protocolName}</Text> · Pool:{' '}
          <Text style={styles.protocolHighlight} testID="savings-pool-name">
            {displayPoolName}
          </Text>
        </Text>
        <Text style={styles.contractIdText} selectable testID="savings-pool-contract-id">
          Pool contract: {resolvedPoolId}
        </Text>
        <Text style={styles.exploitContextText} testID="savings-exploit-context">
          {SAVINGS_DISCLOSURE.exploitContext}
        </Text>

        <View style={styles.linkRow}>
          <Pressable
            accessibilityRole="link"
            accessibilityLabel={`Inspect ${displayPoolName} contract on Stellar Expert`}
            testID="savings-pool-contract-link"
            style={styles.linkButton}
            onPress={() => void openExternalUrl(contractExplorerUrl)}
          >
            <Text style={styles.linkButtonText}>Inspect Pool Contract (stellar.expert) ↗</Text>
          </Pressable>
          <Pressable
            accessibilityRole="link"
            accessibilityLabel="Learn how Veil lending works and disclosures"
            testID="savings-disclosures-link"
            style={styles.linkButton}
            onPress={() => void openExternalUrl('https://docs.useveilapp.xyz/invest')}
          >
            <Text style={styles.linkButtonText}>Protocol &amp; Risk Disclosures ↗</Text>
          </Pressable>
        </View>
      </View>

      {SAVINGS_DISCLOSURE.risks.map((risk) => (
        <View key={risk.id} style={styles.riskItem} testID={`savings-risk-${risk.id}`}>
          <Text style={styles.riskItemTitle}>{risk.title}</Text>
          <Text style={styles.riskItemDesc}>{risk.description}</Text>
        </View>
      ))}

      <Text style={styles.disclaimerText}>
        • Veil is a self-custody wallet, not a bank or broker. Veil never takes custody, never insures deposits, and never gives investment advice.
      </Text>

      {typeof acknowledged === 'boolean' && onToggleAcknowledge ? (
        <Pressable
          accessibilityRole="checkbox"
          accessibilityState={{ checked: acknowledged }}
          testID="savings-risk-acknowledge"
          style={styles.ackRow}
          onPress={onToggleAcknowledge}
        >
          <View style={[styles.checkbox, acknowledged && styles.checkboxChecked]}>
            {acknowledged ? <Text style={styles.checkmark}>✓</Text> : null}
          </View>
          <Text style={styles.ackText}>
            I understand this is not a bank deposit, nothing is insured, the rate is variable and not promised, and the protocol or pool can lose funds or delay withdrawals.
          </Text>
        </Pressable>
      ) : null}
    </View>
  );
}

const createStyles = (colors: ThemeColors) =>
  StyleSheet.create({
    riskCard: {
      backgroundColor: 'rgba(255, 107, 107, 0.04)',
      borderRadius: 14,
      padding: 16,
      borderWidth: 1,
      borderColor: 'rgba(255, 107, 107, 0.3)',
      gap: 10,
    },
    riskHeader: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: 6,
    },
    warningIcon: {
      fontSize: 14,
      color: '#FF6B6B',
    },
    riskLabel: {
      fontSize: 11,
      letterSpacing: 0.8,
      fontFamily: fontFamily.accent,
      color: '#FF6B6B',
    },
    notBankBox: {
      backgroundColor: 'rgba(255, 107, 107, 0.1)',
      borderRadius: 8,
      padding: 10,
      borderWidth: 1,
      borderColor: 'rgba(255, 107, 107, 0.25)',
      gap: 3,
    },
    notBankTitle: {
      fontFamily: fontFamily.bodySemiBold,
      fontSize: 13,
      color: colors.textStrong,
    },
    notBankText: {
      fontFamily: fontFamily.body,
      fontSize: 12,
      lineHeight: 18,
      color: colors.textPrimary,
    },
    protocolBox: {
      backgroundColor: 'rgba(0,0,0,0.2)',
      borderRadius: 8,
      padding: 10,
      borderWidth: 1,
      borderColor: colors.border,
      gap: 6,
    },
    protocolText: {
      fontFamily: fontFamily.body,
      fontSize: 13,
      color: colors.textPrimary,
    },
    protocolHighlight: {
      fontFamily: fontFamily.bodySemiBold,
      color: colors.accentText,
    },
    contractIdText: {
      fontFamily: fontFamily.address,
      fontSize: 11,
      lineHeight: 16,
      color: colors.textSecondary,
    },
    exploitContextText: {
      fontFamily: fontFamily.body,
      fontSize: 12,
      lineHeight: 18,
      color: colors.textSecondary,
    },
    linkRow: {
      gap: 6,
      marginTop: 4,
    },
    linkButton: {
      paddingVertical: 8,
      paddingHorizontal: 12,
      backgroundColor: 'rgba(255,255,255,0.05)',
      borderRadius: 8,
      borderWidth: 1,
      borderColor: colors.border,
    },
    linkButtonText: {
      fontFamily: fontFamily.bodyMedium,
      fontSize: 12,
      color: colors.accentText,
    },
    riskItem: {
      backgroundColor: 'rgba(0,0,0,0.25)',
      padding: 10,
      borderRadius: 8,
      borderWidth: 1,
      borderColor: 'rgba(255,255,255,0.05)',
      gap: 3,
    },
    riskItemTitle: {
      fontFamily: fontFamily.bodySemiBold,
      fontSize: 13,
      color: colors.textStrong,
    },
    riskItemDesc: {
      fontFamily: fontFamily.body,
      fontSize: 12,
      color: colors.textSecondary,
      lineHeight: 18,
    },
    disclaimerText: {
      fontFamily: fontFamily.body,
      fontSize: 11,
      color: colors.textMuted,
      lineHeight: 16,
      marginTop: 2,
    },
    ackRow: {
      flexDirection: 'row',
      alignItems: 'flex-start',
      gap: 10,
      marginTop: 4,
      paddingTop: 10,
      borderTopWidth: StyleSheet.hairlineWidth,
      borderTopColor: 'rgba(255, 107, 107, 0.25)',
    },
    checkbox: {
      width: 20,
      height: 20,
      borderRadius: 4,
      borderWidth: 1,
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
      fontWeight: '700',
      color: colors.onAccent,
    },
    ackText: {
      flex: 1,
      fontFamily: fontFamily.body,
      fontSize: 12,
      color: colors.textPrimary,
      lineHeight: 18,
    },
  });

export default SavingsRiskDisclosure;
