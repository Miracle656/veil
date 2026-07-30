import { CameraView, useCameraPermissions } from 'expo-camera';
import * as Clipboard from 'expo-clipboard';
import { useCallback, useEffect, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Image,
  Modal,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';

import { useWalletConnect } from '../hooks/useWalletConnect';
import { isWalletConnectUri } from '../lib/walletConnectHelpers';
import { getWalletAddress } from '../lib/walletStore';

type ConnectDAppModalProps = {
  isOpen: boolean;
  onClose: () => void;
  onConnected?: (dappName: string) => void;
};

type Tab = 'scan' | 'paste';

/**
 * Connect-to-dApp sheet. Ported from
 * `frontend/wallet/components/ConnectDAppModal.tsx`, swapping the browser
 * camera/`jsQR` pipeline for `expo-camera`'s native QR scanner and adding a
 * clipboard shortcut for the paste flow.
 */
export function ConnectDAppModal({ isOpen, onClose, onConnected }: ConnectDAppModalProps) {
  const { isReady, error: clientError, pendingProposal, pair, approveSession, rejectSession } =
    useWalletConnect();

  const [tab, setTab] = useState<Tab>('scan');
  const [uriInput, setUriInput] = useState('');
  const [isPairing, setIsPairing] = useState(false);
  const [isApproving, setIsApproving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [walletAddress, setWalletAddress] = useState<string | null>(null);
  const [permission, requestPermission] = useCameraPermissions();

  // A single QR code fires `onBarcodeScanned` on every frame it stays in view.
  const hasScannedRef = useRef(false);

  const dappMetadata = pendingProposal?.proposer?.metadata;
  const dappName = dappMetadata?.name || 'dApp';
  const dappDescription = dappMetadata?.description || '';
  const dappIcon = dappMetadata?.icons?.[0] || '';

  useEffect(() => {
    if (!isOpen) return;
    setError(null);
    setUriInput('');
    setTab('scan');
    hasScannedRef.current = false;

    let mounted = true;
    getWalletAddress().then((address) => {
      if (mounted) setWalletAddress(address);
    });
    return () => {
      mounted = false;
    };
  }, [isOpen]);

  useEffect(() => {
    if (isOpen && tab === 'scan' && !pendingProposal && permission && !permission.granted) {
      void requestPermission();
    }
  }, [isOpen, pendingProposal, permission, requestPermission, tab]);

  // Re-arm the scanner if a pairing attempt failed and the user is back on the
  // scan tab with nothing pending.
  useEffect(() => {
    if (!pendingProposal && !isPairing) hasScannedRef.current = false;
  }, [isPairing, pendingProposal]);

  const handlePair = useCallback(
    async (uri: string) => {
      setIsPairing(true);
      setError(null);
      try {
        await pair(uri);
      } catch (pairError: unknown) {
        setError(pairError instanceof Error ? pairError.message : 'Failed to pair with the dApp.');
        hasScannedRef.current = false;
      } finally {
        setIsPairing(false);
      }
    },
    [pair]
  );

  const handleBarcodeScanned = useCallback(
    ({ data }: { data: string }) => {
      if (hasScannedRef.current || !isWalletConnectUri(data)) return;
      hasScannedRef.current = true;
      void handlePair(data);
    },
    [handlePair]
  );

  const handlePasteFromClipboard = useCallback(async () => {
    const text = await Clipboard.getStringAsync();
    if (text) setUriInput(text.trim());
  }, []);

  const handleApprove = useCallback(async () => {
    if (!pendingProposal) return;
    if (!walletAddress) {
      setError('No wallet found on this device. Create or unlock your wallet first.');
      return;
    }

    setIsApproving(true);
    setError(null);
    try {
      await approveSession(pendingProposal, walletAddress);
      onConnected?.(dappName);
      onClose();
    } catch (approveError: unknown) {
      setError(
        approveError instanceof Error ? approveError.message : 'Failed to approve the session.'
      );
    } finally {
      setIsApproving(false);
    }
  }, [approveSession, dappName, onClose, onConnected, pendingProposal, walletAddress]);

  const handleReject = useCallback(async () => {
    if (!pendingProposal) return;
    try {
      await rejectSession(pendingProposal);
      hasScannedRef.current = false;
    } catch (rejectError: unknown) {
      setError(
        rejectError instanceof Error ? rejectError.message : 'Failed to reject the session.'
      );
    }
  }, [pendingProposal, rejectSession]);

  const visibleError = error ?? clientError;

  return (
    <Modal
      visible={isOpen}
      animationType="slide"
      transparent
      onRequestClose={onClose}
      statusBarTranslucent
    >
      <Pressable style={styles.backdrop} onPress={onClose} accessibilityLabel="Close" />

      <View style={styles.sheetWrapper} pointerEvents="box-none">
        <View
          accessibilityViewIsModal
          accessibilityLabel="Connect dApp"
          style={styles.sheet}
          pointerEvents="auto"
        >
          <View style={styles.header}>
            <Text style={styles.title}>Connect dApp</Text>
            <Pressable accessibilityRole="button" accessibilityLabel="Close" onPress={onClose}>
              <Text style={styles.close}>×</Text>
            </Pressable>
          </View>

          <ScrollView keyboardShouldPersistTaps="handled">
            {!pendingProposal ? (
              <>
                <View style={styles.tabs}>
                  <TabButton label="Scan QR" active={tab === 'scan'} onPress={() => setTab('scan')} />
                  <TabButton
                    label="Paste URI"
                    active={tab === 'paste'}
                    onPress={() => setTab('paste')}
                  />
                </View>

                {tab === 'scan' ? (
                  <ScannerPane
                    granted={permission?.granted ?? false}
                    canAskAgain={permission?.canAskAgain ?? true}
                    onRequestPermission={requestPermission}
                    onScanned={handleBarcodeScanned}
                  />
                ) : (
                  <View>
                    <Text style={styles.label}>WalletConnect URI</Text>
                    <TextInput
                      style={styles.input}
                      placeholder="wc:..."
                      placeholderTextColor="#64748b"
                      value={uriInput}
                      onChangeText={setUriInput}
                      autoCapitalize="none"
                      autoCorrect={false}
                      multiline
                    />
                    <Pressable
                      accessibilityRole="button"
                      onPress={handlePasteFromClipboard}
                      style={styles.ghostButton}
                    >
                      <Text style={styles.ghostLabel}>Paste from clipboard</Text>
                    </Pressable>
                    <PrimaryButton
                      label={isPairing ? 'Connecting' : 'Connect'}
                      loading={isPairing}
                      disabled={uriInput.trim().length === 0}
                      onPress={() => handlePair(uriInput)}
                    />
                  </View>
                )}

                <Text style={styles.hint}>
                  {isPairing
                    ? 'Waiting for the dApp session proposal...'
                    : 'Scan or paste a WalletConnect URI to start.'}
                </Text>
                {!isReady && !clientError && (
                  <Text style={styles.hint}>Starting WalletConnect...</Text>
                )}
              </>
            ) : (
              <View>
                <Text style={styles.hint}>Session proposal received</Text>

                <View style={styles.dappCard}>
                  {dappIcon ? (
                    <Image source={{ uri: dappIcon }} style={styles.dappIcon} />
                  ) : (
                    <View style={[styles.dappIcon, styles.dappIconFallback]}>
                      <Text style={styles.dappInitial}>{dappName.slice(0, 1).toUpperCase()}</Text>
                    </View>
                  )}
                  <View style={styles.dappText}>
                    <Text style={styles.dappName}>{dappName}</Text>
                    <Text style={styles.dappDescription}>
                      {dappDescription || 'No description provided.'}
                    </Text>
                  </View>
                </View>

                <View style={styles.permissionsCard}>
                  <Text style={styles.permissionsTitle}>This dApp will be able to</Text>
                  <Text style={styles.permissionsItem}>
                    Ask you to sign Stellar transactions. Every request still needs your explicit
                    approval and passkey.
                  </Text>
                  <Text style={styles.permissionsLabel}>Account</Text>
                  <Text style={styles.mono}>{walletAddress ?? 'No wallet on this device'}</Text>
                </View>

                <PrimaryButton
                  label={isApproving ? 'Approving' : 'Approve'}
                  loading={isApproving}
                  disabled={!walletAddress}
                  onPress={handleApprove}
                />
                <Pressable
                  accessibilityRole="button"
                  onPress={handleReject}
                  disabled={isApproving}
                  style={styles.ghostButton}
                >
                  <Text style={styles.ghostLabel}>Reject</Text>
                </Pressable>
              </View>
            )}

            {visibleError && <Text style={styles.error}>{visibleError}</Text>}
          </ScrollView>
        </View>
      </View>
    </Modal>
  );
}

function ScannerPane({
  granted,
  canAskAgain,
  onRequestPermission,
  onScanned,
}: {
  granted: boolean;
  canAskAgain: boolean;
  onRequestPermission: () => void;
  onScanned: (result: { data: string }) => void;
}) {
  if (!granted) {
    return (
      <View style={styles.scannerFallback}>
        <Text style={styles.hint}>
          {canAskAgain
            ? 'Camera access is needed to scan a WalletConnect QR code.'
            : 'Camera access is blocked. Enable it in system settings, or paste the URI instead.'}
        </Text>
        {canAskAgain && (
          <PrimaryButton label="Allow camera" onPress={onRequestPermission} />
        )}
      </View>
    );
  }

  return (
    <View>
      <View style={styles.scanner}>
        <CameraView
          style={StyleSheet.absoluteFill}
          facing="back"
          barcodeScannerSettings={{ barcodeTypes: ['qr'] }}
          onBarcodeScanned={onScanned}
        />
      </View>
      <Text style={styles.hint}>Point the camera at a WalletConnect QR code.</Text>
    </View>
  );
}

function TabButton({
  label,
  active,
  onPress,
}: {
  label: string;
  active: boolean;
  onPress: () => void;
}) {
  return (
    <Pressable
      accessibilityRole="tab"
      accessibilityState={{ selected: active }}
      onPress={onPress}
      style={[styles.tab, active && styles.tabActive]}
    >
      <Text style={[styles.tabLabel, active && styles.tabLabelActive]}>{label}</Text>
    </Pressable>
  );
}

function PrimaryButton({
  label,
  disabled = false,
  loading = false,
  onPress,
}: {
  label: string;
  disabled?: boolean;
  loading?: boolean;
  onPress: () => void;
}) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityState={{ disabled: disabled || loading, busy: loading }}
      disabled={disabled || loading}
      onPress={onPress}
      style={({ pressed }) => [
        styles.primaryButton,
        pressed && styles.pressed,
        (disabled || loading) && styles.disabled,
      ]}
    >
      {loading ? <ActivityIndicator color="#0F0F0F" size="small" /> : null}
      <Text style={styles.primaryLabel}>{label}</Text>
    </Pressable>
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
    paddingTop: 16,
    paddingBottom: 28,
  },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginBottom: 16,
  },
  title: {
    color: OFF_WHITE,
    fontSize: 20,
    fontWeight: '600',
    fontStyle: 'italic',
    fontFamily: Platform.select({ ios: 'Georgia', default: 'serif' }),
  },
  close: {
    color: OFF_WHITE,
    fontSize: 26,
    lineHeight: 26,
    paddingHorizontal: 8,
  },
  tabs: {
    flexDirection: 'row',
    gap: 8,
    marginBottom: 16,
  },
  tab: {
    borderRadius: 999,
    borderWidth: 1,
    borderColor: BORDER_DIM,
    paddingVertical: 7,
    paddingHorizontal: 16,
  },
  tabActive: {
    borderColor: GOLD,
    backgroundColor: 'rgba(253,218,36,0.12)',
  },
  tabLabel: {
    color: OFF_WHITE,
    fontSize: 14,
  },
  tabLabelActive: {
    color: GOLD,
    fontWeight: '600',
  },
  scanner: {
    aspectRatio: 1,
    borderRadius: 12,
    overflow: 'hidden',
    backgroundColor: '#000',
  },
  scannerFallback: {
    gap: 12,
    paddingVertical: 8,
  },
  label: {
    color: MUTED,
    fontSize: 12,
    marginBottom: 8,
  },
  input: {
    backgroundColor: '#1e293b',
    borderRadius: 10,
    borderWidth: 1,
    borderColor: '#334155',
    color: '#f1f5f9',
    fontSize: 15,
    minHeight: 76,
    padding: 12,
    textAlignVertical: 'top',
  },
  hint: {
    color: MUTED,
    fontSize: 13,
    lineHeight: 20,
    marginTop: 12,
  },
  dappCard: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    backgroundColor: 'rgba(255,255,255,0.04)',
    borderRadius: 12,
    borderWidth: 1,
    borderColor: BORDER_DIM,
    padding: 14,
    marginTop: 12,
    marginBottom: 12,
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
  dappDescription: {
    color: MUTED,
    fontSize: 13,
    marginTop: 2,
  },
  permissionsCard: {
    backgroundColor: 'rgba(255,255,255,0.04)',
    borderRadius: 12,
    borderWidth: 1,
    borderColor: BORDER_DIM,
    padding: 14,
    marginBottom: 16,
    gap: 6,
  },
  permissionsTitle: {
    color: OFF_WHITE,
    fontSize: 14,
    fontWeight: '600',
  },
  permissionsItem: {
    color: MUTED,
    fontSize: 13,
    lineHeight: 19,
  },
  permissionsLabel: {
    color: 'rgba(246,247,248,0.45)',
    fontSize: 12,
    marginTop: 6,
  },
  mono: {
    color: OFF_WHITE,
    fontSize: 12,
    fontFamily: Platform.select({ ios: 'Menlo', default: 'monospace' }),
  },
  primaryButton: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
    backgroundColor: GOLD,
    borderRadius: 999,
    paddingVertical: 13,
    marginTop: 14,
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
    opacity: 0.45,
  },
  error: {
    marginTop: 14,
    color: '#f87171',
    fontSize: 13,
    lineHeight: 19,
  },
});
