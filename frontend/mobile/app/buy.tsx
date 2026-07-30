import { ScreenScaffold, ComingSoonBadge, NavRow, colors } from '@/components/ScreenScaffold';
import { View, Text, StyleSheet } from 'react-native';

export default function BuyRoute() {
  return (
    <ScreenScaffold
      eyebrow="Buy"
      title="Buy crypto"
      description="Fund your spending wallet via Transak (card / bank) or any SEP-24 anchor."
      backHref="/dashboard"
      backLabel="Dashboard"
    >
      <View style={styles.grid}>
        <NavRow href="/withdraw" label="Withdraw" hint="Fiat off-ramp" />
        <NavRow href="/dashboard" label="Dashboard" hint="Back to wallet" />
      </View>
      <ComingSoonBadge note="Transak + SEP-24 flows land in the buy-screen issue" />
    </ScreenScaffold>
  );
}

const styles = StyleSheet.create({
  grid: { gap: 8 },
});
