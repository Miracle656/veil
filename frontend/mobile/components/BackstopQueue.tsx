import { useMemo } from 'react';
import { StyleSheet, Text, View } from 'react-native';

import { useTheme } from '../hooks/useTheme';
import {
  BACKSTOP_CANCEL_COPY,
  BACKSTOP_EXIT_TERMS,
  BACKSTOP_QUEUED_FACTS,
  formatAvailableDate,
  formatMaturedDate,
  getQueueStatus,
  type BackstopQueuedWithdrawal,
} from '../lib/blendBackstop';
import type { ThemeColors } from '../lib/theme';
import { fontFamily, typography } from '../theme/typography';
import { Button, Card } from './ui';

const STROOPS = 1e7;

function formatLpAmount(stroops: string): string {
  const value = Number(stroops) / STROOPS;
  if (!Number.isFinite(value)) return '0';
  return value.toLocaleString('en-US', { maximumFractionDigits: 4 });
}

/**
 * Exit terms stated before a user confirms a Blend backstop deposit.
 *
 * Kept distinct from vault timelock / savings copy: this 17-day queue is
 * imposed by the Blend protocol because backstop capital may be used to absorb
 * bad debt in the pool, not a lock the user chose for discipline.
 */
export function BackstopExitTerms() {
  const { colors } = useTheme();
  const styles = useMemo(() => createStyles(colors), [colors]);

  return (
    <Card style={styles.termsCard}>
      <View testID="backstop-exit-terms" style={styles.termsInner}>
        <Text testID="backstop-exit-terms-heading" style={[typography.accent, styles.termsLabel]}>
          {BACKSTOP_EXIT_TERMS.heading}
        </Text>
        <Text testID="backstop-exit-terms-summary" style={styles.termsBody}>
          {BACKSTOP_EXIT_TERMS.summary}
        </Text>
        <Text testID="backstop-exit-terms-detail" style={styles.termsMuted}>
          {BACKSTOP_EXIT_TERMS.queueDetail}
        </Text>
      </View>
    </Card>
  );
}

export interface BackstopWithdrawalCardProps {
  withdrawal: BackstopQueuedWithdrawal;
  nowSeconds?: number;
  mask?: (value: string) => string;
  onCancel: (withdrawal: BackstopQueuedWithdrawal) => void;
  onWithdraw: (withdrawal: BackstopQueuedWithdrawal) => void;
  busy?: boolean;
}

/**
 * Renders a queued or matured Blend backstop withdrawal.
 *
 * - While queued: displays the absolute availability date (never a day count),
 *   the two plain-language facts (emissions stopped, pool interest continues),
 *   and a single obvious, reversible-sounding cancel action.
 * - Once matured: displays the matured status and date, and makes claiming
 *   (`withdraw()`) the primary action while still allowing the user to put
 *   the shares back into the backstop.
 */
export function BackstopWithdrawalCard({
  withdrawal,
  nowSeconds = Math.floor(Date.now() / 1_000),
  mask = (value) => value,
  onCancel,
  onWithdraw,
  busy = false,
}: BackstopWithdrawalCardProps) {
  const { colors } = useTheme();
  const styles = useMemo(() => createStyles(colors), [colors]);

  const status = getQueueStatus(withdrawal, nowSeconds);
  const amountText = `${mask(formatLpAmount(withdrawal.tokens))} BLND-USDC LP`;

  if (status === 'matured') {
    return (
      <Card variant="md" style={styles.card}>
        <View testID="backstop-withdrawal-matured" style={styles.inner}>
          <View style={styles.rowBetween}>
            <Text testID="backstop-status-label" style={[typography.accent, styles.readyBadge]}>
              Ready to withdraw
            </Text>
            <Text style={styles.poolLabel}>{withdrawal.poolName} backstop</Text>
          </View>

          <Text testID="backstop-available-date" style={[typography.heading, styles.dateTitle]}>
            {formatMaturedDate(withdrawal.availableAt, nowSeconds)}
          </Text>

          <Text testID="backstop-withdrawal-amount" style={styles.amount}>
            {amountText}
          </Text>

          <Text style={styles.muted}>
            Your 17-day queue is complete. Withdraw now or put it back in the backstop so you stop missing emissions.
          </Text>

          <Button
            testID="backstop-withdraw-button"
            label="Withdraw"
            disabled={busy}
            onPress={() => onWithdraw(withdrawal)}
          />
          <Button
            testID="backstop-cancel-button"
            label="Put back in backstop"
            variant="ghost"
            disabled={busy}
            onPress={() => onCancel(withdrawal)}
          />
        </View>
      </Card>
    );
  }

  return (
    <Card style={styles.card}>
      <View testID="backstop-withdrawal-queued" style={styles.inner}>
        <View style={styles.rowBetween}>
          <Text testID="backstop-status-label" style={[typography.accent, styles.queuedBadge]}>
            Withdrawal queued
          </Text>
          <Text style={styles.poolLabel}>{withdrawal.poolName} backstop</Text>
        </View>

        <Text testID="backstop-available-date" style={[typography.heading, styles.dateTitle]}>
          {formatAvailableDate(withdrawal.availableAt, nowSeconds)}
        </Text>

        <Text testID="backstop-withdrawal-amount" style={styles.amount}>
          {amountText}
        </Text>

        <View style={styles.factsBox}>
          <Text testID="backstop-fact-emissions" style={styles.factLine}>
            {BACKSTOP_QUEUED_FACTS.emissionsStopped}
          </Text>
          <Text testID="backstop-fact-interest" style={styles.factLine}>
            {BACKSTOP_QUEUED_FACTS.interestContinues}
          </Text>
        </View>

        <Button
          testID="backstop-cancel-button"
          label={BACKSTOP_CANCEL_COPY.actionLabel}
          variant="ghost"
          disabled={busy}
          onPress={() => onCancel(withdrawal)}
        />
        <Text testID="backstop-cancel-helper" style={styles.helper}>
          {BACKSTOP_CANCEL_COPY.helper}
        </Text>
      </View>
    </Card>
  );
}

const createStyles = (colors: ThemeColors) =>
  StyleSheet.create({
    termsCard: {
      padding: 16,
      borderColor: colors.borderStrong,
    },
    termsInner: {
      gap: 8,
    },
    termsLabel: {
      color: colors.accent,
      fontSize: 11,
    },
    termsBody: {
      fontFamily: fontFamily.bodyMedium,
      fontSize: 13,
      lineHeight: 19,
      color: colors.textPrimary,
    },
    termsMuted: {
      fontFamily: fontFamily.body,
      fontSize: 12,
      lineHeight: 18,
      color: colors.textMuted,
    },
    card: {
      padding: 18,
    },
    inner: {
      gap: 10,
    },
    rowBetween: {
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'space-between',
      gap: 12,
    },
    queuedBadge: {
      color: colors.accent,
      fontSize: 11,
    },
    readyBadge: {
      color: colors.positive,
      fontSize: 11,
    },
    poolLabel: {
      fontFamily: fontFamily.bodyMedium,
      fontSize: 12,
      color: colors.textMuted,
    },
    dateTitle: {
      color: colors.textStrong,
      fontSize: 22,
      lineHeight: 28,
    },
    amount: {
      fontFamily: fontFamily.bodySemiBold,
      fontSize: 16,
      color: colors.textPrimary,
    },
    factsBox: {
      gap: 6,
      paddingTop: 10,
      paddingBottom: 4,
      borderTopWidth: StyleSheet.hairlineWidth,
      borderTopColor: colors.border,
    },
    factLine: {
      fontFamily: fontFamily.body,
      fontSize: 13,
      lineHeight: 19,
      color: colors.textSecondary,
    },
    muted: {
      fontFamily: fontFamily.body,
      fontSize: 13,
      lineHeight: 19,
      color: colors.textMuted,
    },
    helper: {
      fontFamily: fontFamily.body,
      fontSize: 12,
      lineHeight: 17,
      color: colors.textMuted,
      textAlign: 'center',
    },
  });
