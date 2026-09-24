import React from 'react';
import { StyleSheet, Text, TouchableOpacity, View } from 'react-native';

import { openExternalUrl } from '../lib/about';
import { theme } from '../theme/colors';

export interface PrivateBalanceCardProps {
  xlmBalance?: string;
  eurcBalance?: string;
  hidden?: boolean;
  syncState?: 'syncing' | 'up-to-date' | 'needs-history';
  onShield?: () => void;
  onPrivateSend?: () => void;
  onUnshield?: () => void;
}

export function PrivateBalanceCard({
  xlmBalance = '0.00',
  eurcBalance = '0.00',
  hidden = false,
  syncState = 'up-to-date',
  onShield,
  onPrivateSend,
  onUnshield,
}: PrivateBalanceCardProps) {
  const syncLabel = {
    syncing: 'Syncing…',
    'up-to-date': 'Synced',
    'needs-history': 'Connecting…',
  }[syncState];

  const handleOpenGuide = () => {
    void openExternalUrl('https://docs.useveilapp.xyz/privacy');
  };

  return (
    <View style={styles.card}>
      {/* Header */}
      <View style={styles.headerRow}>
        <View style={styles.badgeRow}>
          <Text style={styles.shieldIcon}>🛡️</Text>
          <Text style={styles.title}>PRIVATE BALANCE</Text>
          <View style={styles.tag}>
            <Text style={styles.tagText}>TESTNET</Text>
          </View>
        </View>

        <TouchableOpacity
          onPress={handleOpenGuide}
          style={styles.infoButton}
          accessibilityLabel="Learn how privacy works in Veil"
          accessibilityRole="link"
        >
          <Text style={styles.infoButtonText}>?</Text>
        </TouchableOpacity>
      </View>

      {/* Balance Grid */}
      <View style={styles.balanceGrid}>
        <View style={styles.balanceCol}>
          <Text style={styles.balanceLabel}>Shielded XLM</Text>
          <Text style={styles.balanceValue}>{hidden ? '••••••' : `${xlmBalance} XLM`}</Text>
        </View>
        <View style={styles.balanceCol}>
          <Text style={styles.balanceLabel}>Shielded EURC</Text>
          <Text style={styles.balanceValue}>{hidden ? '••••••' : `${eurcBalance} EURC`}</Text>
        </View>
      </View>

      {/* Notice & Guide Link */}
      <TouchableOpacity
        onPress={handleOpenGuide}
        style={styles.noticeBanner}
        accessibilityRole="link"
      >
        <Text style={styles.noticeText}>
          Inside pool: hidden. Deposits &amp; withdrawals: public.
        </Text>
        <Text style={styles.linkText}>Guide ↗</Text>
      </TouchableOpacity>

      {/* Actions */}
      <View style={styles.actionsRow}>
        <TouchableOpacity
          style={styles.actionBtn}
          onPress={onShield}
          accessibilityLabel="Shield funds"
        >
          <Text style={styles.actionBtnText}>🛡️ Shield</Text>
        </TouchableOpacity>
        <TouchableOpacity
          style={styles.actionBtn}
          onPress={onPrivateSend}
          accessibilityLabel="Private send"
        >
          <Text style={styles.actionBtnText}>↗ Send</Text>
        </TouchableOpacity>
        <TouchableOpacity
          style={styles.actionBtn}
          onPress={onUnshield}
          accessibilityLabel="Unshield funds"
        >
          <Text style={styles.actionBtnText}>↘ Unshield</Text>
        </TouchableOpacity>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  card: {
    backgroundColor: '#16181b',
    borderRadius: 16,
    borderWidth: 1,
    borderColor: 'rgba(197, 160, 89, 0.25)',
    padding: 16,
    marginBottom: 16,
  },
  headerRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: 12,
  },
  badgeRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
  },
  shieldIcon: {
    fontSize: 14,
  },
  title: {
    color: '#c5a059',
    fontSize: 12,
    fontWeight: '700',
    letterSpacing: 0.5,
  },
  tag: {
    backgroundColor: 'rgba(197, 160, 89, 0.15)',
    paddingHorizontal: 6,
    paddingVertical: 2,
    borderRadius: 4,
  },
  tagText: {
    color: '#c5a059',
    fontSize: 10,
    fontWeight: '600',
  },
  infoButton: {
    width: 24,
    height: 24,
    borderRadius: 12,
    backgroundColor: 'rgba(246, 247, 248, 0.1)',
    alignItems: 'center',
    justifyContent: 'center',
  },
  infoButtonText: {
    color: '#f6f7f8',
    fontSize: 12,
    fontWeight: '600',
  },
  balanceGrid: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    marginBottom: 12,
  },
  balanceCol: {
    flex: 1,
  },
  balanceLabel: {
    color: 'rgba(246, 247, 248, 0.5)',
    fontSize: 11,
    marginBottom: 2,
  },
  balanceValue: {
    color: '#f6f7f8',
    fontSize: 16,
    fontWeight: '700',
  },
  noticeBanner: {
    backgroundColor: 'rgba(0, 0, 0, 0.3)',
    borderRadius: 8,
    paddingHorizontal: 10,
    paddingVertical: 8,
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: 12,
  },
  noticeText: {
    color: 'rgba(246, 247, 248, 0.7)',
    fontSize: 11,
    flex: 1,
  },
  linkText: {
    color: '#c5a059',
    fontSize: 11,
    fontWeight: '600',
    marginLeft: 6,
  },
  actionsRow: {
    flexDirection: 'row',
    gap: 8,
  },
  actionBtn: {
    flex: 1,
    backgroundColor: 'rgba(246, 247, 248, 0.08)',
    borderRadius: 8,
    paddingVertical: 8,
    alignItems: 'center',
    justifyContent: 'center',
  },
  actionBtnText: {
    color: '#f6f7f8',
    fontSize: 12,
    fontWeight: '600',
  },
});
