import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Pressable,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import * as Clipboard from 'expo-clipboard';

import { useTheme } from '../hooks/useTheme';
import type { ThemeColors } from '../lib/theme';
import { fontFamily } from '../theme/typography';
import {
  AirtimeIcon,
  BettingIcon,
  CheckIcon,
  CopyIcon,
  DataIcon,
  PowerIcon,
  TVIcon,
} from './icons';
import {
  isTerminalStatus,
  type PersistedBillOrder,
} from '../lib/billOrders';

interface RecentBillOrdersProps {
  orders: PersistedBillOrder[];
  onRecheck?: () => Promise<void>;
  isRechecking?: boolean;
}

function getCategoryIcon(category: string, color: string) {
  switch (category) {
    case 'electricity':
      return <PowerIcon size={18} color={color} />;
    case 'data':
      return <DataIcon size={18} color={color} />;
    case 'cabletv':
      return <TVIcon size={18} color={color} />;
    case 'betting':
      return <BettingIcon size={18} color={color} />;
    case 'airtime':
    default:
      return <AirtimeIcon size={18} color={color} />;
  }
}

function formatRelativeTime(timestamp: number): string {
  const diffMs = Date.now() - timestamp;
  const diffMins = Math.floor(diffMs / 60_000);
  if (diffMins < 1) return 'Just now';
  if (diffMins < 60) return `${diffMins}m ago`;
  const diffHours = Math.floor(diffMins / 60);
  if (diffHours < 24) return `${diffHours}h ago`;
  const diffDays = Math.floor(diffHours / 24);
  if (diffDays < 7) return `${diffDays}d ago`;
  return new Date(timestamp).toLocaleDateString('en-NG', { month: 'short', day: 'numeric' });
}

export function RecentBillOrders({
  orders,
  onRecheck,
  isRechecking = false,
}: RecentBillOrdersProps) {
  const { colors } = useTheme();
  const styles = useMemo(() => createStyles(colors), [colors]);
  const [copiedOrderId, setCopiedOrderId] = useState<string | null>(null);
  const timeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    return () => {
      if (timeoutRef.current) clearTimeout(timeoutRef.current);
    };
  }, []);

  const copyToken = useCallback(async (orderId: string, token: string) => {
    await Clipboard.setStringAsync(token);
    setCopiedOrderId(orderId);
    if (timeoutRef.current) clearTimeout(timeoutRef.current);
    timeoutRef.current = setTimeout(() => {
      setCopiedOrderId((prev) => (prev === orderId ? null : prev));
    }, 2500);
  }, []);

  if (orders.length === 0) return null;

  return (
    <View style={styles.container} testID="recent-bill-orders-section">
      <View style={styles.headerRow}>
        <Text style={styles.sectionTitle}>RECENT PURCHASES</Text>
        {onRecheck ? (
          <Pressable
            onPress={() => void onRecheck()}
            disabled={isRechecking}
            accessibilityRole="button"
            accessibilityLabel="Recheck pending bill orders"
            style={({ pressed }) => [styles.refreshBtn, pressed && styles.pressed]}
          >
            {isRechecking ? (
              <ActivityIndicator size="small" color={colors.accent} />
            ) : (
              <Text style={styles.refreshText}>Refresh</Text>
            )}
          </Pressable>
        ) : null}
      </View>

      <View style={styles.list}>
        {orders.map((order) => {
          const isPending = !isTerminalStatus(order.status);
          const isDone = /complete|success|delivered/i.test(order.status);
          const isFailed = /fail|refund|revers|cancel/i.test(order.status);
          const hasToken = Boolean(order.token);
          const isCopied = copiedOrderId === order.orderId;

          return (
            <View key={order.orderId} style={styles.orderCard} testID={`bill-order-${order.orderId}`}>
              <View style={styles.orderTopRow}>
                <View style={styles.categoryLeft}>
                  <View style={styles.iconWrap}>
                    {getCategoryIcon(order.category, colors.accent)}
                  </View>
                  <View style={styles.metaCol}>
                    <Text style={styles.providerText}>
                      {order.provider ? `${order.provider} · ` : ''}
                      {order.category.toUpperCase()}
                    </Text>
                    <Text style={styles.identifierText} numberOfLines={1}>
                      {order.identifier}
                    </Text>
                  </View>
                </View>

                <View style={styles.amountRight}>
                  <Text style={styles.amountNgn}>₦{order.amount.toLocaleString('en-NG')}</Text>
                  {order.amountCrypto ? (
                    <Text style={styles.amountCrypto}>
                      {order.amountCrypto.toFixed(order.asset === 'xlm' ? 4 : 2)} {order.asset.toUpperCase()}
                    </Text>
                  ) : null}
                </View>
              </View>

              <View style={styles.statusRow}>
                <View style={styles.statusBadgeWrap}>
                  <View
                    style={[
                      styles.statusDot,
                      isDone && styles.statusDotSuccess,
                      isPending && styles.statusDotPending,
                      isFailed && styles.statusDotFailed,
                    ]}
                  />
                  <Text
                    style={[
                      styles.statusText,
                      isDone && styles.statusTextSuccess,
                      isPending && styles.statusTextPending,
                      isFailed && styles.statusTextFailed,
                    ]}
                  >
                    {isDone ? 'Completed' : isPending ? 'Pending' : 'Failed'}
                  </Text>
                </View>
                <Text style={styles.timeText}>{formatRelativeTime(order.time)}</Text>
              </View>

              {/* Electricity Prepaid Token display & copy affordance */}
              {hasToken ? (
                <View style={styles.tokenContainer} testID={`token-card-${order.orderId}`}>
                  <View style={styles.tokenHeader}>
                    <Text style={styles.tokenEyebrow}>PREPAID TOKEN</Text>
                    <Pressable
                      onPress={() => void copyToken(order.orderId, order.token!)}
                      accessibilityRole="button"
                      accessibilityLabel="Copy prepaid token"
                      style={({ pressed }) => [styles.copyBtn, pressed && styles.pressed]}
                    >
                      {isCopied ? (
                        <>
                          <CheckIcon size={13} color={colors.accent} />
                          <Text style={styles.copyBtnTextSuccess}>Copied</Text>
                        </>
                      ) : (
                        <>
                          <CopyIcon size={13} color={colors.textSecondary} />
                          <Text style={styles.copyBtnText}>Copy</Text>
                        </>
                      )}
                    </Pressable>
                  </View>
                  <Text style={styles.tokenValue} selectable>
                    {order.token}
                  </Text>
                </View>
              ) : isPending && order.category === 'electricity' ? (
                <View style={styles.tokenWaitingContainer}>
                  <Text style={styles.tokenWaitingText}>
                    Prepaid token will appear here once confirmed by provider.
                  </Text>
                </View>
              ) : null}
            </View>
          );
        })}
      </View>
    </View>
  );
}

function createStyles(colors: ThemeColors) {
  return StyleSheet.create({
    container: {
      marginTop: 24,
      marginBottom: 32,
    },
    headerRow: {
      flexDirection: 'row',
      justifyContent: 'space-between',
      alignItems: 'center',
      marginBottom: 12,
    },
    sectionTitle: {
      fontFamily: fontFamily.mono,
      fontSize: 11,
      letterSpacing: 1.2,
      color: colors.textSecondary,
      fontWeight: '600',
    },
    refreshBtn: {
      paddingHorizontal: 8,
      paddingVertical: 4,
    },
    refreshText: {
      fontFamily: fontFamily.sans,
      fontSize: 12,
      color: colors.accent,
      fontWeight: '500',
    },
    list: {
      gap: 12,
    },
    orderCard: {
      backgroundColor: colors.surfaceSm,
      borderWidth: 1,
      borderColor: colors.borderDim,
      borderRadius: 14,
      padding: 14,
    },
    orderTopRow: {
      flexDirection: 'row',
      justifyContent: 'space-between',
      alignItems: 'center',
    },
    categoryLeft: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: 10,
      flex: 1,
    },
    iconWrap: {
      width: 32,
      height: 32,
      borderRadius: 8,
      backgroundColor: colors.surfaceMd,
      alignItems: 'center',
      justifyContent: 'center',
    },
    metaCol: {
      flex: 1,
    },
    providerText: {
      fontFamily: fontFamily.mono,
      fontSize: 11,
      color: colors.textSecondary,
      textTransform: 'uppercase',
      letterSpacing: 0.5,
    },
    identifierText: {
      fontFamily: fontFamily.mono,
      fontSize: 13,
      fontWeight: '600',
      color: colors.textPrimary,
      marginTop: 2,
    },
    amountRight: {
      alignItems: 'flex-end',
    },
    amountNgn: {
      fontFamily: fontFamily.sans,
      fontSize: 14,
      fontWeight: '700',
      color: colors.textPrimary,
    },
    amountCrypto: {
      fontFamily: fontFamily.mono,
      fontSize: 11,
      color: colors.accent,
      marginTop: 1,
    },
    statusRow: {
      flexDirection: 'row',
      justifyContent: 'space-between',
      alignItems: 'center',
      marginTop: 10,
      paddingTop: 8,
      borderTopWidth: StyleSheet.hairlineWidth,
      borderTopColor: colors.borderDim,
    },
    statusBadgeWrap: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: 6,
    },
    statusDot: {
      width: 6,
      height: 6,
      borderRadius: 3,
    },
    statusDotSuccess: {
      backgroundColor: colors.success,
    },
    statusDotPending: {
      backgroundColor: colors.accent,
    },
    statusDotFailed: {
      backgroundColor: colors.error,
    },
    statusText: {
      fontFamily: fontFamily.sans,
      fontSize: 11,
      fontWeight: '500',
    },
    statusTextSuccess: {
      color: colors.success,
    },
    statusTextPending: {
      color: colors.accent,
    },
    statusTextFailed: {
      color: colors.error,
    },
    timeText: {
      fontFamily: fontFamily.mono,
      fontSize: 11,
      color: colors.textMuted,
    },
    tokenContainer: {
      marginTop: 10,
      backgroundColor: colors.surfaceMd,
      borderRadius: 10,
      borderWidth: 1,
      borderColor: colors.borderMedium,
      padding: 10,
    },
    tokenHeader: {
      flexDirection: 'row',
      justifyContent: 'space-between',
      alignItems: 'center',
      marginBottom: 4,
    },
    tokenEyebrow: {
      fontFamily: fontFamily.mono,
      fontSize: 10,
      letterSpacing: 1,
      color: colors.textSecondary,
      fontWeight: '600',
    },
    copyBtn: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: 4,
      paddingHorizontal: 8,
      paddingVertical: 2,
      borderRadius: 6,
      backgroundColor: colors.surfaceSm,
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: colors.borderDim,
    },
    copyBtnText: {
      fontFamily: fontFamily.sans,
      fontSize: 11,
      color: colors.textSecondary,
      fontWeight: '500',
    },
    copyBtnTextSuccess: {
      fontFamily: fontFamily.sans,
      fontSize: 11,
      color: colors.accent,
      fontWeight: '600',
    },
    tokenValue: {
      fontFamily: fontFamily.mono,
      fontSize: 14,
      fontWeight: '700',
      color: colors.accent,
      letterSpacing: 1.2,
      marginTop: 2,
    },
    tokenWaitingContainer: {
      marginTop: 8,
      padding: 8,
      backgroundColor: colors.surfaceMd,
      borderRadius: 8,
    },
    tokenWaitingText: {
      fontFamily: fontFamily.sans,
      fontSize: 11,
      color: colors.textMuted,
      fontStyle: 'italic',
    },
    pressed: {
      opacity: 0.7,
    },
  });
}
