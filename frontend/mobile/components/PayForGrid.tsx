import { useMemo } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';

import { useTheme } from '../hooks/useTheme';
import type { ThemeColors } from '../lib/theme';
import { fontFamily } from '../theme/typography';
import {
  AirtimeIcon,
  BankIcon,
  BettingIcon,
  BillsIcon,
  DataIcon,
  GridIcon,
  PowerIcon,
  TVIcon,
  type IconProps,
} from './icons';

export type BillService = {
  id: string;
  label: string;
  hint: string;
  Icon: (props: IconProps) => React.JSX.Element;
  /**
   * Whether the flow behind this tile exists. Only 'live' services appear on
   * the dashboard; the rest are listed in the drawer behind a "soon" badge.
   */
  status: 'live' | 'soon';
  /** Highlight in gold. Reserved for a service we want to draw the eye to. */
  accent?: boolean;
};

/**
 * The everyday-money surface: airtime, data, bills, transfers — the things a
 * Nigerian user opens a wallet to do. Fiat on the face, USDC + sponsored fees
 * underneath.
 *
 * None of these are live yet, so none render on the dashboard. They are listed
 * in ServicesDrawer behind a "soon" badge instead, because a tile that does
 * nothing when tapped is worse than one the user was told is not ready.
 *
 * Flip a service to status: 'live' when its flow ships and it moves onto the
 * dashboard on its own — there is no second list to update.
 */
export const BILL_SERVICES: BillService[] = [
  { id: 'airtime', label: 'Airtime', hint: 'All networks', Icon: AirtimeIcon, status: 'soon' },
  { id: 'data', label: 'Data', hint: 'Bundles', Icon: DataIcon, status: 'soon' },
  { id: 'power', label: 'Power', hint: 'Prepaid', Icon: PowerIcon, status: 'soon' },
  { id: 'tv', label: 'TV', hint: 'DStv · GOtv', Icon: TVIcon, status: 'soon' },
  { id: 'bills', label: 'Bills', hint: 'Water · waste', Icon: BillsIcon, status: 'soon' },
  { id: 'transfer', label: 'Transfer', hint: 'To any bank', Icon: BankIcon, status: 'soon' },
  { id: 'betting', label: 'Betting', hint: 'Top up', Icon: BettingIcon, status: 'soon' },
];

export function PayForGrid({
  services = BILL_SERVICES,
  onSelect,
  onMore,
}: {
  services?: BillService[];
  onSelect?: (service: BillService) => void;
  /** Opens the services drawer. The "More" cell only renders when provided. */
  onMore?: () => void;
}) {
  const { colors } = useTheme();
  const styles = useMemo(() => createStyles(colors), [colors]);

  const live = useMemo(() => services.filter((s) => s.status === 'live'), [services]);

  // Nothing shipped yet means no card at all, rather than a grid of dead tiles.
  // The drawer behind the drape mark is the way in until the first flow lands.
  if (live.length === 0) return null;

  return (
    <View style={styles.card}>
      <Text style={styles.heading}>Pay for</Text>
      <View style={styles.grid}>
        {live.map((service) => (
          <Pressable
            key={service.id}
            onPress={() => onSelect?.(service)}
            accessibilityRole="button"
            accessibilityLabel={`${service.label} — ${service.hint}`}
            style={({ pressed }) => [styles.cell, pressed && styles.pressed]}
          >
            <View style={[styles.iconWrap, service.accent && styles.iconWrapAccent]}>
              <service.Icon size={20} color={service.accent ? colors.accent : colors.textPrimary} />
            </View>
            <Text style={[styles.cellLabel, service.accent && styles.cellLabelAccent]}>{service.label}</Text>
            <Text style={styles.cellHint} numberOfLines={1}>
              {service.hint}
            </Text>
          </Pressable>
        ))}

        {onMore ? (
          <Pressable
            onPress={onMore}
            accessibilityRole="button"
            accessibilityLabel="More — all services"
            style={({ pressed }) => [styles.cell, pressed && styles.pressed]}
          >
            <View style={[styles.iconWrap, styles.iconWrapAccent]}>
              <GridIcon size={20} color={colors.accent} />
            </View>
            <Text style={[styles.cellLabel, styles.cellLabelAccent]}>More</Text>
            <Text style={styles.cellHint} numberOfLines={1}>
              All services
            </Text>
          </Pressable>
        ) : null}
      </View>
    </View>
  );
}

const createStyles = (colors: ThemeColors) =>
  StyleSheet.create({
    card: {
      backgroundColor: colors.surface,
      borderWidth: 1,
      borderColor: colors.border,
      borderRadius: 20,
      paddingHorizontal: 14,
      paddingTop: 14,
      paddingBottom: 12,
    },
    heading: {
      color: colors.accent,
      fontFamily: fontFamily.bodySemiBold,
      fontSize: 11,
      letterSpacing: 1.4,
      textTransform: 'uppercase',
      paddingHorizontal: 4,
      paddingBottom: 6,
    },
    grid: {
      flexDirection: 'row',
      flexWrap: 'wrap',
    },
    cell: {
      width: '25%',
      alignItems: 'center',
      gap: 6,
      paddingVertical: 12,
    },
    iconWrap: {
      width: 44,
      height: 44,
      borderRadius: 14,
      alignItems: 'center',
      justifyContent: 'center',
      backgroundColor: colors.surfaceMd,
      borderWidth: 1,
      borderColor: colors.border,
    },
    iconWrapAccent: {
      backgroundColor: 'rgba(253,218,36,0.08)',
      borderColor: 'rgba(253,218,36,0.22)',
    },
    cellLabel: {
      color: colors.textPrimary,
      fontFamily: fontFamily.bodyMedium,
      fontSize: 13,
    },
    cellLabelAccent: {
      color: colors.accent,
    },
    cellHint: {
      color: colors.textFaint,
      fontFamily: fontFamily.body,
      fontSize: 10,
    },
    pressed: {
      opacity: 0.6,
    },
  });
