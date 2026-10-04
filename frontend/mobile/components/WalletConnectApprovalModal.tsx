import { errorMessage } from '../lib/errorMessage';
import { Address, scValToNative, TransactionBuilder } from '@stellar/stellar-sdk';
import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  ActivityIndicator,
  Image,
  Modal,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from 'react-native';

import { useWalletConnect } from '../hooks/useWalletConnect';
import { getNetwork } from '../lib/network';
import { registerPasskeySigner } from '../lib/passkey';
import {
  approveWalletConnectRequest,
  rejectWalletConnectRequest,
  type WalletConnectRequest,
} from '../lib/walletConnect';
import { extractRequestXdr, isUserRejection } from '../lib/walletConnectHelpers';

export type ParsedOperation = {
  type: string;
  label: string;
  destination?: string;
  asset?: string;
  amount?: string;
  contractAddress?: string;
  functionName?: string;
  arguments: string[];
  depth: number;
};

export type ParsedRequestDetails = { operations: ParsedOperation[] };

/**
 * Decode enough of the request for the user to judge it. Everything here is
 * best-effort: a request we cannot decode is presented as an unknown contract
 * interaction to review carefully, never as though it were safe.
 */
function safeStringify(value: unknown): string {
  try {
    return JSON.stringify(value, (_, item) => {
      if (typeof item === 'bigint') return item.toString();
      if (item instanceof Uint8Array) return `0x${Array.from(item).map((byte) => byte.toString(16).padStart(2, '0')).join('')}`;
      if (item instanceof Map) return Object.fromEntries(item);
      return item;
    });
  } catch {
    return String(value);
  }
}

function scValText(value: any): string {
  try {
    return safeStringify(scValToNative(value));
  } catch {
    return value?.toString?.() || 'Unable to decode argument';
  }
}

function contractInvocation(invocation: any, depth: number): ParsedOperation[] {
  if (!invocation) return [];
  let functionName: string | undefined;
  let contractAddress: string | undefined;
  let args: string[] = [];
  try {
    const func = invocation.function?.();
    const contract = func?.contractFn?.() ?? func?.invokeContract?.();
    contractAddress = contract?.contractAddress?.()?.toString?.();
    functionName = contract?.functionName?.()?.toString?.();
    args = (contract?.args?.() || []).map(scValText);
  } catch {
    // Keep a visible entry even when an SDK version cannot decode an arm.
  }
  const current: ParsedOperation = {
    type: 'invokeHostFunction',
    label: depth ? 'Sub-invocation' : 'Contract call',
    contractAddress,
    functionName,
    arguments: args,
    depth,
  };
  let children: ParsedOperation[] = [];
  try { children = (invocation.subInvocations?.() || []).flatMap((item: any) => contractInvocation(item, depth + 1)); } catch { /* Keep the parent. */ }
  return [current, ...children];
}

function hostFunctionOperation(operation: any, depth: number): ParsedOperation {
  let contractAddress: string | undefined;
  let functionName: string | undefined;
  let args: string[] = [];
  try {
    const contract = operation.func?.invokeContract?.();
    contractAddress = Address.fromScAddress(contract.contractAddress()).toString();
    functionName = contract.functionName().toString();
    args = (contract.args?.() || []).map(scValText);
  } catch {
    // Keep a visible contract entry when an SDK version cannot decode an arm.
  }
  return { type: 'invokeHostFunction', label: 'Contract call', contractAddress, functionName, arguments: args, depth };
}

function parseOperation(operation: any, depth = 0): ParsedOperation[] {
  const type = String(operation?.type || 'unknown');
  if (type === 'invokeHostFunction') {
    let children: ParsedOperation[] = [];
    try { children = (operation.auth || []).flatMap((entry: any) => contractInvocation(entry.rootInvocation?.(), depth + 1)); } catch { /* Keep the parent. */ }
    return [hostFunctionOperation(operation, depth), ...children];
  }
  const result: ParsedOperation = { type, label: type === 'payment' ? 'Payment' : type, arguments: [], depth };
  if (typeof operation?.destination === 'string') result.destination = operation.destination;
  if (typeof operation?.amount === 'string') result.amount = operation.amount;
  try { result.asset = operation?.asset?.isNative?.() ? 'XLM' : operation?.asset?.getCode?.() || operation?.asset?.toString?.(); } catch { /* Keep asset unknown. */ }
  return [result];
}

export function parseRequestDetails(request: WalletConnectRequest | null): ParsedRequestDetails {
  const xdrString = request ? extractRequestXdr(request.params) : null;
  if (!xdrString) return { operations: [] };

  try {
    const tx = TransactionBuilder.fromXDR(xdrString, getNetwork().networkPassphrase);
    return { operations: ((tx as any).operations || []).flatMap((operation: any) => parseOperation(operation)) };
  } catch {
    return { operations: [{ type: 'unknown', label: 'Unknown', arguments: [], depth: 0 }] };
  }
}

/**
 * The safety gate on WalletConnect: nothing a connected dApp asks for is signed
 * without the user seeing it and approving it here.
 *
 * Ported from `frontend/wallet/components/WalletConnectApprovalModal.tsx`.
 * Mount it once, high in the tree — it watches the pending-request queue in
 * `lib/walletConnect` and presents requests one at a time in arrival order.
 */
export function WalletConnectApprovalModal() {
  const { pendingRequests, sessions } = useWalletConnect();
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const request = pendingRequests[0] ?? null;

  // The signing pipeline asks for the passkey through an injected signer, so
  // register it for as long as an approval surface is mounted.
  useEffect(() => registerPasskeySigner(), []);

  // A new request must not inherit the previous one's error.
  useEffect(() => {
    setError(null);
  }, [request?.id, request?.topic]);

  const details = useMemo(() => parseRequestDetails(request), [request]);

  const dappMetadata = useMemo(() => {
    if (!request?.topic) return null;
    return sessions.find((session) => session.topic === request.topic)?.peer ?? null;
  }, [request?.topic, sessions]);

  const dappName = dappMetadata?.name || 'Unknown dApp';
  const dappIcon = dappMetadata?.icons?.[0];

  const handleApprove = useCallback(async () => {
    if (!request) return;
    setIsSubmitting(true);
    setError(null);
    try {
      await approveWalletConnectRequest(request);
    } catch (approveError: unknown) {
      // A decline is a normal outcome: the dApp has already been told, and the
      // request has left the queue, so there is nothing to report.
      if (!isUserRejection(approveError)) {
        const message =
          errorMessage(approveError);
        setError(message || 'Failed to approve the request.');
      }
    } finally {
      setIsSubmitting(false);
    }
  }, [request]);

  const handleReject = useCallback(async () => {
    if (!request) return;
    setIsSubmitting(true);
    setError(null);
    try {
      await rejectWalletConnectRequest(request);
    } catch (rejectError: unknown) {
      const message = errorMessage(rejectError);
      setError(message || 'Failed to reject the request.');
    } finally {
      setIsSubmitting(false);
    }
  }, [request]);

  if (!request) return null;

  return (
    <Modal visible animationType="slide" transparent onRequestClose={handleReject} statusBarTranslucent>
      <View style={styles.backdrop} />

      <View style={styles.sheetWrapper} pointerEvents="box-none">
        <View accessibilityViewIsModal accessibilityLabel="Transaction approval" style={styles.sheet}>
          <Text style={styles.title}>Transaction approval</Text>

          <ScrollView showsVerticalScrollIndicator={false}>
            <View style={styles.card}>
              <View style={styles.dappRow}>
                {dappIcon ? (
                  <Image source={{ uri: dappIcon }} style={styles.dappIcon} />
                ) : (
                  <View style={[styles.dappIcon, styles.dappIconFallback]}>
                    <Text style={styles.dappInitial}>{dappName.slice(0, 1).toUpperCase()}</Text>
                  </View>
                )}
                <View style={styles.dappText}>
                  <Text style={styles.dappName}>{dappName}</Text>
                  <Text style={styles.muted}>WalletConnect request</Text>
                </View>
              </View>
            </View>

            <View style={styles.card}>
              <Text style={styles.operationCount}>{details.operations.length} operation{details.operations.length === 1 ? '' : 's'}</Text>
              {details.operations.length ? details.operations.map((operation, index) => (
                <View key={`${operation.type}-${index}`} style={[styles.operation, operation.depth > 0 && styles.subInvocation]}>
                  <Field label={operation.label} value={operation.type} strong />
                  {operation.amount && <Field label="Amount" value={`${operation.amount}${operation.asset ? ` ${operation.asset}` : ''}`} />}
                  {operation.destination && <Field label="Destination" value={operation.destination} mono />}
                  {operation.contractAddress && <Field label="Contract" value={operation.contractAddress} mono />}
                  {operation.functionName && <Field label="Function" value={operation.functionName} />}
                  {operation.arguments.map((argument, argumentIndex) => <Field key={argumentIndex} label={`Argument ${argumentIndex + 1}`} value={argument} mono />)}
                  {!operation.amount && !operation.destination && !operation.contractAddress && !operation.functionName && !operation.arguments.length && <Text style={styles.warning}>Review this operation carefully</Text>}
                </View>
              )) : <Text style={styles.warning}>Unable to decode operations. Review carefully.</Text>}
              <Field label="Method" value={request.method} mono />
              <Field label="Network" value={getNetwork().displayName} />
            </View>

            {pendingRequests.length > 1 && (
              <Text style={styles.muted}>
                {pendingRequests.length - 1} more request
                {pendingRequests.length - 1 === 1 ? '' : 's'} waiting
              </Text>
            )}

            <Pressable
              accessibilityRole="button"
              accessibilityState={{ disabled: isSubmitting, busy: isSubmitting }}
              disabled={isSubmitting}
              onPress={handleApprove}
              style={({ pressed }) => [
                styles.primaryButton,
                pressed && styles.pressed,
                isSubmitting && styles.disabled,
              ]}
            >
              {isSubmitting ? <ActivityIndicator color="#0F0F0F" size="small" /> : null}
              <Text style={styles.primaryLabel}>{isSubmitting ? 'Approving' : 'Approve'}</Text>
            </Pressable>

            <Pressable
              accessibilityRole="button"
              accessibilityState={{ disabled: isSubmitting }}
              disabled={isSubmitting}
              onPress={handleReject}
              style={({ pressed }) => [
                styles.ghostButton,
                pressed && styles.pressed,
                isSubmitting && styles.disabled,
              ]}
            >
              <Text style={styles.ghostLabel}>Reject</Text>
            </Pressable>

            {error && <Text style={styles.error}>{error}</Text>}
          </ScrollView>
        </View>
      </View>
    </Modal>
  );
}

function Field({
  label,
  value,
  mono = false,
  strong = false,
}: {
  label: string;
  value: string;
  mono?: boolean;
  strong?: boolean;
}) {
  return (
    <View style={styles.field}>
      <Text style={styles.fieldLabel}>{label}</Text>
      <Text style={[styles.fieldValue, mono && styles.monoText, strong && styles.strong]}>
        {value}
      </Text>
    </View>
  );
}

const GOLD = '#FDDA24';
const OFF_WHITE = '#F6F7F8';
const BORDER_DIM = 'rgba(246,247,248,0.14)';
const MUTED = 'rgba(246,247,248,0.5)';

const styles = StyleSheet.create({
  backdrop: {
    position: 'absolute',
    top: 0,
    right: 0,
    bottom: 0,
    left: 0,
    backgroundColor: 'rgba(0,0,0,0.72)',
  },
  sheetWrapper: {
    flex: 1,
    justifyContent: 'flex-end',
  },
  sheet: {
    maxHeight: '85%',
    backgroundColor: '#141414',
    borderTopLeftRadius: 20,
    borderTopRightRadius: 20,
    borderTopWidth: 1,
    borderColor: BORDER_DIM,
    paddingHorizontal: 20,
    paddingTop: 20,
    paddingBottom: 28,
  },
  title: {
    color: OFF_WHITE,
    fontSize: 20,
    fontWeight: '600',
    fontStyle: 'italic',
    fontFamily: Platform.select({ ios: 'Georgia', default: 'serif' }),
    marginBottom: 16,
  },
  card: {
    backgroundColor: 'rgba(255,255,255,0.04)',
    borderRadius: 12,
    borderWidth: 1,
    borderColor: BORDER_DIM,
    padding: 14,
    marginBottom: 12,
  },
  operationCount: {
    color: MUTED,
    fontSize: 12,
    marginBottom: 10,
  },
  operation: {
    marginBottom: 10,
  },
  subInvocation: {
    borderLeftWidth: 1,
    borderLeftColor: BORDER_DIM,
    paddingLeft: 12,
  },
  dappRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
  },
  dappIcon: {
    width: 40,
    height: 40,
    borderRadius: 999,
  },
  dappIconFallback: {
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: 1,
    borderColor: BORDER_DIM,
  },
  dappInitial: {
    color: GOLD,
    fontWeight: '700',
    fontSize: 16,
  },
  dappText: {
    flex: 1,
  },
  dappName: {
    color: OFF_WHITE,
    fontSize: 15,
    fontWeight: '600',
  },
  muted: {
    color: MUTED,
    fontSize: 13,
    marginTop: 2,
  },
  field: {
    marginBottom: 10,
  },
  fieldLabel: {
    color: 'rgba(246,247,248,0.45)',
    fontSize: 12,
    marginBottom: 3,
  },
  fieldValue: {
    color: OFF_WHITE,
    fontSize: 14,
  },
  strong: {
    fontWeight: '600',
    fontSize: 15,
  },
  monoText: {
    fontSize: 12,
    fontFamily: Platform.select({ ios: 'Menlo', default: 'monospace' }),
  },
  warning: {
    color: 'rgba(246,247,248,0.65)',
    fontSize: 13,
    lineHeight: 19,
    marginBottom: 10,
  },
  primaryButton: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
    backgroundColor: GOLD,
    borderRadius: 999,
    paddingVertical: 13,
    marginTop: 8,
  },
  primaryLabel: {
    color: '#0F0F0F',
    fontSize: 15,
    fontWeight: '700',
  },
  ghostButton: {
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: 999,
    borderWidth: 1,
    borderColor: BORDER_DIM,
    paddingVertical: 12,
    marginTop: 10,
  },
  ghostLabel: {
    color: OFF_WHITE,
    fontSize: 15,
    fontWeight: '600',
  },
  pressed: {
    opacity: 0.75,
  },
  disabled: {
    opacity: 0.5,
  },
  error: {
    marginTop: 14,
    color: '#f87171',
    fontSize: 13,
    lineHeight: 19,
  },
});
