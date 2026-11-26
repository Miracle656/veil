/**
 * The approval sheet for a dApp page loaded in Veil's own browser.
 *
 * WalletConnect has this already: `WalletConnectApprovalModal` shows the decoded
 * request and nothing gets signed until the user approves it. The dApp browser
 * needs the same gate, and it needs it to say the same thing — a signature that
 * looks different depending on which door the dApp came in through is a signature
 * the user cannot compare. So this sheet renders the same {@link RequestDetails}
 * the WalletConnect sheet renders, from the same decoder.
 *
 * Three things it never does:
 *
 * - It never shows only the dApp's self-reported name. A page can call itself
 *   anything, so the origin is always on screen beside it.
 * - It never describes a payload it could not decode as harmless. An undecodable
 *   request says "review carefully", which is the same rule the decoder follows.
 * - It never implies approval is the signature. Approval lets Veil *ask the
 *   device* to sign; the passkey ceremony is a second, separate act.
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import { ActivityIndicator, Modal, Platform, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';

import { useTheme } from '../hooks/useTheme';
import { PERMISSION_SCOPE_DESCRIPTIONS, PERMISSION_SCOPE_LABELS } from '../lib/permissions';
import { REQUEST_TYPE_LABELS } from '../lib/transactionRequestDetails';
import type { PermissionRequest } from '../lib/dappBridge';
import type { ThemeColors } from '../lib/theme';
import { fontFamily } from '../theme/typography';

export type DappApprovalModalProps = {
  /** The request being approved, or null to render nothing. */
  request: PermissionRequest | null;
  /** The network the request would be signed for, shown so a wrong-network request is visible. */
  networkName: string;
  /** The user's answer. The caller resolves the pending prompt with it. */
  onDecision: (approved: boolean) => void;
};

export function DappApprovalModal({ request, networkName, onDecision }: DappApprovalModalProps) {
  const { colors } = useTheme();
  const styles = useMemo(() => createStyles(colors), [colors]);
  const [isBusy, setIsBusy] = useState(false);

  const decide = useCallback(
    (approved: boolean) => {
      // Guard against a double tap firing the promise resolver twice; the second
      // answer would be ignored anyway, and a sheet that stays visible while the
      // app works is worse than one that reads as disabled.
      if (isBusy) return;
      setIsBusy(true);
      onDecision(approved);
    },
    [isBusy, onDecision],
  );

  // A new request — or the sheet closing — always starts from an untapped state.
  // The parent reuses this component across prompts, so without this the buttons
  // of the second request would still read as busy from the first.
  useEffect(() => setIsBusy(false), [request]);

  if (!request) return null;

  const isSigning = request.scope === 'transaction_signing';
  const details = request.details;
  const displayName = request.name || request.origin;

  return (
    <Modal
      visible
      animationType="slide"
      transparent
      // Back must be a decline, never a way to leave the request pending.
      onRequestClose={() => decide(false)}
      statusBarTranslucent
    >
      <View style={styles.backdrop} />

      <View style={styles.sheetWrapper} pointerEvents="box-none">
        <View
          accessibilityViewIsModal
          accessibilityLabel={isSigning ? 'Signature approval' : 'Connect approval'}
          style={styles.sheet}
          testID="dapp-approval-modal"
        >
          <Text style={styles.title}>{isSigning ? 'Sign this request?' : 'Connect to this dApp?'}</Text>

          <ScrollView showsVerticalScrollIndicator={false}>
            <View style={styles.card}>
              <Text style={styles.dappName}>{displayName}</Text>
              {/* The origin is the identity; the name above it is only what the
                  page chose to be called. */}
              <Text style={styles.dappOrigin} testID="dapp-approval-origin">
                {request.origin}
              </Text>
            </View>

            <View style={styles.card}>
              <Field styles={styles} label="Asking for" value={PERMISSION_SCOPE_LABELS[request.scope]} strong />
              <Text style={styles.scopeNote}>{PERMISSION_SCOPE_DESCRIPTIONS[request.scope]}</Text>
              {request.grantedAt !== null && isSigning ? (
                <Text style={styles.scopeNote}>
                  You already allow this site to ask. Veil shows you every request anyway.
                </Text>
              ) : null}
            </View>

            {isSigning ? (
              <View style={styles.card} testID="dapp-approval-details">
                <Field
                  styles={styles}
                  label="Operation type"
                  value={REQUEST_TYPE_LABELS[details?.operationType ?? 'unknown']}
                  strong
                />

                {details?.operationType === 'payment' ? (
                  <>
                    <Field styles={styles} label="Amount" value={details.amount || 'Unknown'} />
                    {details.destination ? (
                      <Field styles={styles} label="Destination" value={details.destination} mono />
                    ) : null}
                  </>
                ) : null}

                {details && (details.operationType === 'contract' || details.operationType === 'authEntry') ? (
                  <>
                    {/* A full address, always: an elided one is a string the user
                        cannot compare against anything, so it shows nothing. */}
                    {details.contractAddress ? (
                      <Field styles={styles} label="Contract address" value={details.contractAddress} mono />
                    ) : null}
                    {details.functionName ? <Field styles={styles} label="Function" value={details.functionName} /> : null}
                  </>
                ) : null}

                {details?.operationCount && details.operationCount > 1 ? (
                  <Field styles={styles} label="Operations in this request" value={String(details.operationCount)} />
                ) : null}

                {/* The same rule the decoder follows: a request that could not be
                    read is presented as one to review carefully, never as a
                    request that looks safe. */}
                {!details ||
                details.undecodable ||
                details.operationType === 'unknown' ||
                ((details.operationType === 'contract' || details.operationType === 'authEntry') &&
                  !details.functionName) ? (
                  <Text style={styles.warning}>
                    Veil could not read what this request does. Only approve it if you know where it came from.
                  </Text>
                ) : null}

                <Field styles={styles} label="Network" value={networkName} />
              </View>
            ) : null}

            <Text style={styles.passkeyNote}>
              {isSigning
                ? 'Approving lets Veil ask your passkey to sign. The signature itself is a separate step on this device.'
                : 'This shares your wallet address only. It does not let this site move anything.'}
            </Text>

            <Pressable
              accessibilityRole="button"
              accessibilityState={{ disabled: isBusy, busy: isBusy }}
              disabled={isBusy}
              onPress={() => decide(true)}
              testID="dapp-approval-approve"
              style={({ pressed }) => [
                styles.primaryButton,
                pressed && styles.pressed,
                isBusy && styles.disabled,
              ]}
            >
              {isBusy ? <ActivityIndicator color={colors.onAccent} size="small" /> : null}
              <Text style={styles.primaryLabel}>
                {isBusy ? 'Working' : isSigning ? 'Approve' : 'Allow'}
              </Text>
            </Pressable>

            <Pressable
              accessibilityRole="button"
              accessibilityState={{ disabled: isBusy }}
              disabled={isBusy}
              onPress={() => decide(false)}
              testID="dapp-approval-reject"
              style={({ pressed }) => [styles.ghostButton, pressed && styles.pressed, isBusy && styles.disabled]}
            >
              <Text style={styles.ghostLabel}>{isSigning ? 'Reject' : 'Decline'}</Text>
            </Pressable>
          </ScrollView>
        </View>
      </View>
    </Modal>
  );
}

// The stylesheet is per-theme, so it is passed in rather than read from a module
// global — a cached light-mode sheet inside a dark app is the usual bug.
function Field({
  styles,
  label,
  value,
  mono = false,
  strong = false,
}: {
  styles: ReturnType<typeof createStyles>;
  label: string;
  value: string;
  mono?: boolean;
  strong?: boolean;
}) {
  return (
    <View style={styles.field}>
      <Text style={styles.fieldLabel}>{label}</Text>
      <Text style={[styles.fieldValue, mono && styles.monoText, strong && styles.strong]}>{value}</Text>
    </View>
  );
}

const createStyles = (colors: ThemeColors) =>
  StyleSheet.create({
    backdrop: {
      position: 'absolute',
      top: 0,
      right: 0,
      bottom: 0,
      left: 0,
      backgroundColor: 'rgba(0,0,0,0.72)',
    },
    sheetWrapper: { flex: 1, justifyContent: 'flex-end' },
    sheet: {
      maxHeight: '85%',
      backgroundColor: colors.surfaceRaised,
      borderTopLeftRadius: 20,
      borderTopRightRadius: 20,
      borderTopWidth: 1,
      borderColor: colors.border,
      paddingHorizontal: 20,
      paddingTop: 20,
      paddingBottom: 28,
    },
    title: {
      color: colors.textStrong,
      fontFamily: fontFamily.heading,
      fontSize: 20,
      marginBottom: 16,
    },
    card: {
      backgroundColor: colors.surface,
      borderRadius: 12,
      borderWidth: 1,
      borderColor: colors.border,
      padding: 14,
      marginBottom: 12,
    },
    dappName: { color: colors.textPrimary, fontSize: 15, fontWeight: '600' },
    dappOrigin: {
      color: colors.textMuted,
      fontFamily: fontFamily.address,
      fontSize: 13,
      marginTop: 4,
    },
    scopeNote: { color: colors.textMuted, fontSize: 13, lineHeight: 19, marginTop: 6 },
    field: { marginBottom: 10 },
    fieldLabel: { color: colors.textFaint, fontSize: 12, marginBottom: 3 },
    fieldValue: { color: colors.textPrimary, fontSize: 14 },
    strong: { fontWeight: '600', fontSize: 15 },
    monoText: {
      fontSize: 12,
      fontFamily: Platform.select({ ios: 'Menlo', default: 'monospace' }),
    },
    warning: {
      color: colors.danger,
      fontSize: 13,
      lineHeight: 19,
      marginBottom: 10,
    },
    passkeyNote: {
      color: colors.textSecondary,
      fontSize: 13,
      lineHeight: 19,
      marginBottom: 14,
    },
    primaryButton: {
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'center',
      gap: 8,
      backgroundColor: colors.accent,
      borderRadius: 999,
      paddingVertical: 13,
      marginTop: 8,
    },
    primaryLabel: { color: colors.onAccent, fontSize: 15, fontWeight: '700' },
    ghostButton: {
      alignItems: 'center',
      justifyContent: 'center',
      borderRadius: 999,
      borderWidth: 1,
      borderColor: colors.border,
      paddingVertical: 12,
      marginTop: 10,
    },
    ghostLabel: { color: colors.textPrimary, fontSize: 15, fontWeight: '600' },
    pressed: { opacity: 0.75 },
    disabled: { opacity: 0.5 },
  });
