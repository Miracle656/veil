/**
 * Notifications settings screen (#1287).
 *
 * Reached from Settings. Exposes the four notification categories:
 *   - Activity (default on)
 *   - Security (always on — rendered with an explicit badge, never a placebo switch)
 *   - Product  (default on)
 *   - Seasonal (default off until the user opts in)
 *
 * Also keeps the local transfer sub-switches (incoming vs outgoing) under
 * Activity, and states plainly on the same screen what Veil's push registry can
 * and cannot see.
 */

import { useMemo, useState, useSyncExternalStore } from 'react';
import { Pressable, ScrollView, StyleSheet, Switch, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { FlowHeader } from '../../components/FlowHeader';
import { NoticeModal } from '../../components/NoticeModal';
import { useTheme } from '../../hooks/useTheme';
import {
  areAllSwitchableCategoriesOff,
  getNotifIncomingSubpref,
  getNotifOutgoingSubpref,
  getNotificationCategory,
  NOTIFICATION_CAN_SEE,
  NOTIFICATION_CANNOT_SEE,
  NOTIFICATION_CATEGORY_META,
  setNotifIncoming,
  setNotifOutgoing,
  setNotificationCategory,
  subscribeToNotifPrefs,
  type NotificationBoundaryFact,
  type NotificationCategory,
} from '../../lib/notificationPrefs';
import { requestNotificationPermissions } from '../../lib/notifications';
import type { ThemeColors } from '../../lib/theme';
import { fontFamily, typography } from '../../theme/typography';

export default function NotificationsSettingsScreen() {
  const { colors } = useTheme();
  const styles = useMemo(() => createStyles(colors), [colors]);

  const activity = useSyncExternalStore(
    subscribeToNotifPrefs,
    () => getNotificationCategory('activity'),
    () => getNotificationCategory('activity')
  );
  const security = useSyncExternalStore(
    subscribeToNotifPrefs,
    () => getNotificationCategory('security'),
    () => getNotificationCategory('security')
  );
  const product = useSyncExternalStore(
    subscribeToNotifPrefs,
    () => getNotificationCategory('product'),
    () => getNotificationCategory('product')
  );
  const seasonal = useSyncExternalStore(
    subscribeToNotifPrefs,
    () => getNotificationCategory('seasonal'),
    () => getNotificationCategory('seasonal')
  );
  const incoming = useSyncExternalStore(
    subscribeToNotifPrefs,
    getNotifIncomingSubpref,
    getNotifIncomingSubpref
  );
  const outgoing = useSyncExternalStore(
    subscribeToNotifPrefs,
    getNotifOutgoingSubpref,
    getNotifOutgoingSubpref
  );

  const [notice, setNotice] = useState<{
    title: string;
    message: string;
    tone: 'neutral' | 'success' | 'error';
  } | null>(null);

  const categoryValues: Record<NotificationCategory, boolean> = {
    activity,
    security,
    product,
    seasonal,
  };

  const allSwitchableOff = areAllSwitchableCategoriesOff(categoryValues);

  const handleCategoryChange = (category: NotificationCategory, next: boolean) => {
    if (category === 'security') return;
    if (next) {
      void requestNotificationPermissions().then((granted) => {
        if (!granted) {
          setNotice({
            title: 'Notifications off',
            message: 'Enable notifications in your device settings to receive alerts.',
            tone: 'neutral',
          });
          return;
        }
        void setNotificationCategory(category, true);
      });
      return;
    }
    void setNotificationCategory(category, false);
  };

  const handleIncomingChange = (next: boolean) => {
    if (next) {
      void requestNotificationPermissions().then((granted) => {
        if (!granted) {
          setNotice({
            title: 'Notifications off',
            message: 'Enable notifications in your device settings to receive alerts.',
            tone: 'neutral',
          });
          return;
        }
        void setNotifIncoming(true);
      });
      return;
    }
    void setNotifIncoming(false);
  };

  return (
    <SafeAreaView style={styles.screen} edges={['top']} testID="notifications-settings-screen">
      <View style={styles.header}>
        <FlowHeader title="Notifications" />
      </View>

      <ScrollView showsVerticalScrollIndicator={false} contentContainerStyle={styles.content}>
        <View style={styles.card}>
          <Text style={styles.lead}>
            Payment alerts and seasonal greetings do not share a switch. Turn off anything you do
            not want without silencing your wallet, and Security stays on.
          </Text>
        </View>

        <Text style={styles.sectionLabel}>Categories</Text>
        <View style={styles.listCard}>
          {NOTIFICATION_CATEGORY_META.map((item, index) => {
            const enabled = categoryValues[item.key];
            if (!item.switchable) {
              return (
                <View
                  key={item.key}
                  testID={`notif-category-${item.key}`}
                  accessible
                  accessibilityLabel={`${item.title}: Always on`}
                  accessibilityState={{ disabled: true, checked: true }}
                  style={[styles.row, index > 0 && styles.rowDivider]}
                >
                  <View style={styles.rowText}>
                    <Text style={styles.rowTitle}>{item.title}</Text>
                    <Text style={styles.rowSubtitle}>{item.example}</Text>
                  </View>
                  <View style={styles.lockedBadge} testID="notif-security-locked-badge">
                    <Text style={styles.lockedBadgeText}>Always on</Text>
                  </View>
                </View>
              );
            }

            return (
              <Pressable
                key={item.key}
                testID={`notif-category-${item.key}`}
                accessibilityRole="switch"
                accessibilityLabel={item.title}
                accessibilityState={{ checked: enabled }}
                onPress={() => handleCategoryChange(item.key, !enabled)}
                style={({ pressed }) => [
                  styles.row,
                  index > 0 && styles.rowDivider,
                  pressed && styles.pressed,
                ]}
              >
                <View style={styles.rowText}>
                  <Text style={styles.rowTitle}>{item.title}</Text>
                  <Text style={styles.rowSubtitle}>{item.example}</Text>
                </View>
                <Switch
                  testID={`notif-switch-${item.key}`}
                  value={enabled}
                  onValueChange={(value) => handleCategoryChange(item.key, value)}
                  trackColor={{ false: colors.surfaceMd, true: 'rgba(253,218,36,0.45)' }}
                  thumbColor={enabled ? colors.accent : colors.textFaint}
                />
              </Pressable>
            );
          })}
        </View>

        {allSwitchableOff ? (
          <Text style={styles.deregisteredHint} testID="notif-deregistered-hint">
            Activity, Product, and Seasonal are all off — this device’s remote push token has been
            deregistered rather than kept on file. Local security alerts remain active on this
            phone.
          </Text>
        ) : null}

        {activity ? (
          <>
            <Text style={styles.sectionLabel}>Activity details (on this phone)</Text>
            <View style={styles.listCard}>
              <Pressable
                testID="notif-sub-incoming"
                accessibilityRole="switch"
                accessibilityState={{ checked: incoming }}
                onPress={() => handleIncomingChange(!incoming)}
                style={({ pressed }) => [styles.row, pressed && styles.pressed]}
              >
                <View style={styles.rowText}>
                  <Text style={styles.rowTitle}>Incoming transfers</Text>
                  <Text style={styles.rowSubtitle}>Notify when you receive a payment</Text>
                </View>
                <Switch
                  testID="notif-switch-incoming"
                  value={incoming}
                  onValueChange={handleIncomingChange}
                  trackColor={{ false: colors.surfaceMd, true: 'rgba(253,218,36,0.45)' }}
                  thumbColor={incoming ? colors.accent : colors.textFaint}
                />
              </Pressable>

              <Pressable
                testID="notif-sub-outgoing"
                accessibilityRole="switch"
                accessibilityState={{ checked: outgoing }}
                onPress={() => void setNotifOutgoing(!outgoing)}
                style={({ pressed }) => [styles.row, styles.rowDivider, pressed && styles.pressed]}
              >
                <View style={styles.rowText}>
                  <Text style={styles.rowTitle}>Outgoing confirmations</Text>
                  <Text style={styles.rowSubtitle}>Notify when a sent transaction confirms</Text>
                </View>
                <Switch
                  testID="notif-switch-outgoing"
                  value={outgoing}
                  onValueChange={(value) => void setNotifOutgoing(value)}
                  trackColor={{ false: colors.surfaceMd, true: 'rgba(253,218,36,0.45)' }}
                  thumbColor={outgoing ? colors.accent : colors.textFaint}
                />
              </Pressable>
            </View>
          </>
        ) : null}

        <Text style={styles.sectionLabel}>What Veil can see</Text>
        <View style={styles.card} testID="notif-what-we-can-see">
          {NOTIFICATION_CAN_SEE.map((fact) => (
            <BoundaryFactRow key={fact.key} fact={fact} styles={styles} />
          ))}
        </View>

        <Text style={styles.sectionLabel}>What Veil cannot see</Text>
        <View style={styles.card} testID="notif-what-we-cannot-see">
          {NOTIFICATION_CANNOT_SEE.map((fact) => (
            <BoundaryFactRow key={fact.key} fact={fact} styles={styles} />
          ))}
        </View>
      </ScrollView>

      {notice ? (
        <NoticeModal
          isOpen
          title={notice.title}
          message={notice.message}
          tone={notice.tone}
          onClose={() => setNotice(null)}
        />
      ) : null}
    </SafeAreaView>
  );
}

function BoundaryFactRow({
  fact,
  styles,
}: {
  fact: NotificationBoundaryFact;
  styles: ReturnType<typeof createStyles>;
}) {
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
    listCard: {
      backgroundColor: colors.surface,
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: colors.border,
      borderRadius: 16,
      overflow: 'hidden',
    },
    lead: {
      fontFamily: fontFamily.body,
      fontSize: 14,
      lineHeight: 21,
      color: colors.textPrimary,
    },
    row: {
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'space-between',
      gap: 14,
      paddingHorizontal: 16,
      paddingVertical: 14,
    },
    rowDivider: {
      borderTopWidth: StyleSheet.hairlineWidth,
      borderTopColor: colors.border,
    },
    rowText: {
      flex: 1,
      gap: 3,
    },
    rowTitle: {
      fontFamily: fontFamily.bodySemiBold,
      fontSize: 15,
      color: colors.textStrong,
    },
    rowSubtitle: {
      fontFamily: fontFamily.body,
      fontSize: 13,
      lineHeight: 18,
      color: colors.textMuted,
    },
    lockedBadge: {
      borderColor: colors.borderStrong,
      borderRadius: 999,
      borderWidth: 1,
      paddingHorizontal: 10,
      paddingVertical: 4,
    },
    lockedBadgeText: {
      fontFamily: fontFamily.bodySemiBold,
      fontSize: 11,
      color: colors.textSecondary,
    },
    deregisteredHint: {
      fontFamily: fontFamily.body,
      fontSize: 12,
      lineHeight: 18,
      color: colors.textMuted,
      paddingHorizontal: 4,
    },
    fact: { gap: 3 },
    factClaim: {
      fontFamily: fontFamily.bodySemiBold,
      fontSize: 15,
      color: colors.textStrong,
    },
    factDetail: {
      fontFamily: fontFamily.body,
      fontSize: 13,
      lineHeight: 19,
      color: colors.textMuted,
    },
    pressed: { opacity: 0.7 },
  });
