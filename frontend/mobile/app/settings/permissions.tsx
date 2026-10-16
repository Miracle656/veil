/**
 * Connected dApps & permissions — what each site has been allowed, and the
 * ability to take it back.
 *
 * The counterpart to WalletConnect's session list, for origins rather than
 * negotiated sessions. Two grants are tracked separately per origin — seeing
 * your address and asking you to sign are different permissions, and revoking
 * one must not silently revoke the other.
 *
 * Every revoke here takes effect at once, in any page already open: the list
 * this screen renders is the same live store the dApp bridge consults on every
 * request, so there is no "reload the page to make it stick" step and no
 * separate cached copy that can disagree with what is shown.
 */

import { useCallback, useMemo, useState } from 'react';
import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { ConfirmModal } from '../../components/ConfirmModal';
import { FlowHeader } from '../../components/FlowHeader';
import { useOriginPermissions } from '../../hooks/useOriginPermissions';
import { useTheme } from '../../hooks/useTheme';
import {
  formatGrantedAt,
  PERMISSION_SCOPES,
  PERMISSION_SCOPE_DESCRIPTIONS,
  PERMISSION_SCOPE_LABELS,
  type OriginGrant,
  type PermissionScope,
} from '../../lib/permissions';
import type { ThemeColors } from '../../lib/theme';

type PendingRevoke =
  | { kind: 'origin'; origin: string; name?: string }
  | { kind: 'scope'; origin: string; name?: string; scope: PermissionScope }
  | { kind: 'all'; count: number };

export default function OriginPermissionsScreen() {
  const { colors } = useTheme();
  const styles = useMemo(() => createStyles(colors), [colors]);
  const { grants, isHydrated, revoke, revokeAll } = useOriginPermissions();
  const [pending, setPending] = useState<PendingRevoke | null>(null);

  const confirmRevoke = useCallback(() => {
    if (!pending) return;
    const target = pending;
    setPending(null);
    if (target.kind === 'all') {
      void revokeAll();
    } else {
      void revoke(target.origin, target.kind === 'scope' ? target.scope : undefined);
    }
  }, [pending, revoke, revokeAll]);

  const confirmMessage = useMemo(() => {
    if (!pending) return '';
    if (pending.kind === 'all') {
      return pending.count === 1
        ? 'This site will have to ask you for everything again.'
        : `These ${pending.count} sites will have to ask you for everything again.`;
    }
    if (pending.kind === 'scope') {
      return `${pending.name ?? pending.origin} will have to ask you for ${
        PERMISSION_SCOPE_LABELS[pending.scope].toLowerCase()
      } again the next time it asks.`;
    }
    return `${pending.name ?? pending.origin} will have to ask you for everything again.`;
  }, [pending]);

  return (
    <SafeAreaView style={styles.screen} edges={['top']} testID="permissions-screen">
      <View style={styles.header}>
        <FlowHeader title="Connected dApps" />
      </View>

      <ScrollView showsVerticalScrollIndicator={false} contentContainerStyle={styles.content}>
        <Text style={styles.hint}>
          Sites you have given permission to. Revoking takes effect straight away — a page you
          have open will ask you again the next time it needs that permission.
        </Text>

        {!isHydrated ? null : grants.length === 0 ? (
          <View style={styles.card}>
            <Text style={styles.cardTitle}>No permissions given</Text>
            <Text style={styles.hint}>
              When a site asks to show your address or request a signature, it will appear here
              with what you allowed and when.
            </Text>
          </View>
        ) : (
          <>
            {grants.map((grant) => (
              <OriginCard
                key={grant.origin}
                grant={grant}
                onRevokeScope={(scope) =>
                  setPending({ kind: 'scope', origin: grant.origin, name: grant.name, scope })
                }
                onRevokeAll={() =>
                  setPending({ kind: 'origin', origin: grant.origin, name: grant.name })
                }
              />
            ))}

            <Pressable
              accessibilityRole="button"
              accessibilityLabel="Revoke all site permissions"
              onPress={() => setPending({ kind: 'all', count: grants.length })}
              style={({ pressed }) => [styles.revokeAll, pressed && styles.pressed]}
            >
              <Text style={styles.revokeAllText}>Revoke all</Text>
            </Pressable>
          </>
        )}
      </ScrollView>

      <ConfirmModal
        isOpen={pending !== null}
        title={
          pending?.kind === 'all'
            ? 'Revoke every site?'
            : pending?.kind === 'scope'
              ? 'Revoke this permission?'
              : 'Revoke this site?'
        }
        message={confirmMessage}
        confirmLabel="Revoke"
        destructive
        onConfirm={confirmRevoke}
        onCancel={() => setPending(null)}
      />
    </SafeAreaView>
  );
}

function OriginCard({
  grant,
  onRevokeScope,
  onRevokeAll,
}: {
  grant: OriginGrant;
  onRevokeScope: (scope: PermissionScope) => void;
  onRevokeAll: () => void;
}) {
  const { colors } = useTheme();
  const styles = useMemo(() => createStyles(colors), [colors]);

  return (
    <View style={styles.card}>
      <Text style={styles.originName} numberOfLines={1}>
        {grant.name ?? grant.origin}
      </Text>
      {/* A page names itself whatever it likes, so the origin is always shown —
          it is what the grant is keyed on and what the user actually decides on. */}
      {grant.name ? (
        <Text style={styles.origin} numberOfLines={1}>
          {grant.origin}
        </Text>
      ) : null}

      {PERMISSION_SCOPES.filter((scope) =>
        grant.grants.some((held) => held.scope === scope)
      ).map((scope) => {
        const held = grant.grants.find((entry) => entry.scope === scope);
        return (
          <View key={scope} style={styles.scopeRow}>
            <View style={styles.scopeCopy}>
              <Text style={styles.scopeLabel}>{PERMISSION_SCOPE_LABELS[scope]}</Text>
              <Text style={styles.scopeMeta}>
                Granted {held ? formatGrantedAt(held.grantedAt) : ''}
              </Text>
              {/* What the grant actually permits, so the row is not just a
                  label the user has to interpret. */}
              <Text style={styles.scopeDescription}>{PERMISSION_SCOPE_DESCRIPTIONS[scope]}</Text>
            </View>
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={`Revoke ${PERMISSION_SCOPE_LABELS[scope].toLowerCase()} for ${
                grant.name ?? grant.origin
              }`}
              onPress={() => onRevokeScope(scope)}
              style={({ pressed }) => [styles.scopeRevoke, pressed && styles.pressed]}
            >
              <Text style={styles.scopeRevokeText}>Revoke</Text>
            </Pressable>
          </View>
        );
      })}

      <Pressable
        accessibilityRole="button"
        accessibilityLabel={`Revoke everything for ${grant.name ?? grant.origin}`}
        onPress={onRevokeAll}
        style={({ pressed }) => [styles.revokeOrigin, pressed && styles.pressed]}
      >
        <Text style={styles.revokeOriginText}>Revoke this site</Text>
      </Pressable>
    </View>
  );
}

const createStyles = (colors: ThemeColors) =>
  StyleSheet.create({
    screen: {
      backgroundColor: colors.background,
      flex: 1,
    },
    header: {
      paddingHorizontal: 8,
    },
    content: {
      gap: 12,
      padding: 24,
      paddingBottom: 48,
    },
    hint: {
      color: colors.textSecondary,
      fontSize: 13,
      lineHeight: 20,
    },
    card: {
      backgroundColor: colors.surface,
      borderColor: colors.border,
      borderRadius: 12,
      borderWidth: 1,
      gap: 4,
      padding: 16,
    },
    cardTitle: {
      color: colors.textPrimary,
      fontSize: 15,
      fontWeight: '600',
    },
    originName: {
      color: colors.textStrong,
      fontSize: 16,
      fontWeight: '700',
    },
    origin: {
      color: colors.textFaint,
      fontSize: 12,
    },
    scopeRow: {
      alignItems: 'center',
      borderTopColor: colors.border,
      borderTopWidth: 1,
      flexDirection: 'row',
      gap: 12,
      marginTop: 8,
      paddingTop: 12,
    },
    scopeCopy: {
      flex: 1,
      gap: 2,
    },
    scopeLabel: {
      color: colors.textPrimary,
      fontSize: 14,
      fontWeight: '600',
    },
    scopeMeta: {
      color: colors.textMuted,
      fontSize: 12,
    },
    scopeDescription: {
      color: colors.textFaint,
      fontSize: 12,
      lineHeight: 18,
    },
    scopeRevoke: {
      borderColor: colors.border,
      borderRadius: 8,
      borderWidth: 1,
      paddingHorizontal: 12,
      paddingVertical: 6,
    },
    scopeRevokeText: {
      color: colors.danger,
      fontSize: 13,
      fontWeight: '600',
    },
    revokeOrigin: {
      alignSelf: 'flex-start',
      marginTop: 12,
      paddingVertical: 4,
    },
    revokeOriginText: {
      color: colors.danger,
      fontSize: 13,
      fontWeight: '700',
    },
    revokeAll: {
      alignItems: 'center',
      borderColor: colors.danger,
      borderRadius: 12,
      borderWidth: 1,
      padding: 14,
    },
    revokeAllText: {
      color: colors.danger,
      fontSize: 15,
      fontWeight: '700',
    },
    pressed: {
      opacity: 0.6,
    },
  });
