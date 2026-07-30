import { useState, useCallback } from 'react';
import {
  View,
  Text,
  TextInput,
  TouchableOpacity,
  StyleSheet,
  Modal,
  Platform,
} from 'react-native';
import { CameraView, useCameraPermissions } from 'expo-camera';

import { isValidStellarAddress } from '../lib/address';
import { parseQrValue } from '../lib/sep7';

interface QrScannerProps {
  visible: boolean;
  onScan: (address: string) => void;
  onClose: () => void;
}

/**
 * Pull a destination out of a scanned value. Accepts a bare G…/C… address or a
 * SEP-7 `web+stellar:pay?...` URI — #468 requires both, and payment-request QR
 * codes are the SEP-7 form. Returns null for anything unrecognised so the
 * camera keeps scanning rather than latching onto junk.
 */
function destinationFromScan(value: string): string | null {
  const parsed = parseQrValue(value);
  const destination = parsed && 'destination' in parsed ? parsed.destination : undefined;
  if (destination && isValidStellarAddress(destination)) return destination;

  const trimmed = value.trim();
  return isValidStellarAddress(trimmed) ? trimmed : null;
}

export function QrScanner({ visible, onScan, onClose }: QrScannerProps) {
  const [permission, requestPermission] = useCameraPermissions();
  const [manualAddress, setManualAddress] = useState('');
  const [manualError, setManualError] = useState<string | null>(null);
  const [scanEnabled, setScanEnabled] = useState(true);

  const isPermissionGranted = permission?.granted ?? false;
  const isPermissionUndetermined = permission === null;

  const handleBarcodeScanned = useCallback(
    ({ data }: { data: string }) => {
      if (!scanEnabled) return;
      const addr = destinationFromScan(data);
      if (addr) {
        setScanEnabled(false);
        onScan(addr);
      }
    },
    [scanEnabled, onScan]
  );

  const handleRequestPermission = useCallback(async () => {
    await requestPermission();
  }, [requestPermission]);

  const handleManualSubmit = useCallback(() => {
    const addr = destinationFromScan(manualAddress);
    if (!addr) {
      setManualError(
        'Enter a valid Stellar address (G... or C..., 56 characters).'
      );
      return;
    }
    setManualError(null);
    onScan(addr);
  }, [manualAddress, onScan]);

  // Reset scan throttle when modal opens
  const handleModalShow = useCallback(() => {
    setScanEnabled(true);
    setManualAddress('');
    setManualError(null);
  }, []);

  return (
    <Modal
      visible={visible}
      animationType="slide"
      transparent={false}
      onShow={handleModalShow}
      onRequestClose={onClose}
    >
      <View style={styles.container}>
        {/* Camera view */}
        {isPermissionUndetermined || !isPermissionGranted ? (
          <View style={styles.permissionContainer}>
            <Text style={styles.permissionTitle}>Camera Access Required</Text>
            <Text style={styles.permissionText}>
              Veil needs camera access to scan Stellar QR codes for recipient
              addresses.
            </Text>
            <TouchableOpacity
              style={styles.permissionButton}
              onPress={handleRequestPermission}
            >
              <Text style={styles.permissionButtonText}>
                {isPermissionUndetermined
                  ? 'Grant Camera Access'
                  : 'Open Settings'}
              </Text>
            </TouchableOpacity>
          </View>
        ) : (
          <CameraView
            style={StyleSheet.absoluteFill}
            facing="back"
            barcodeScannerSettings={{
              barcodeTypes: ['qr'],
            }}
            onBarcodeScanned={handleBarcodeScanned}
          >
            {/* Viewfinder overlay */}
            <View style={styles.overlay}>
              <View style={styles.viewfinder}>
                {(['topLeft', 'topRight', 'bottomLeft', 'bottomRight'] as const).map(
                  (corner) => (
                    <View
                      key={corner}
                      style={[
                        styles.corner,
                        corner === 'topLeft' && styles.cornerTopLeft,
                        corner === 'topRight' && styles.cornerTopRight,
                        corner === 'bottomLeft' && styles.cornerBottomLeft,
                        corner === 'bottomRight' && styles.cornerBottomRight,
                      ]}
                    />
                  )
                )}
              </View>
              <Text style={styles.hint}>
                Point camera at a Stellar address QR code (G... or C...)
              </Text>
            </View>
          </CameraView>
        )}

        {/* Overlay UI */}
        <View style={styles.uiOverlay}>
          {/* Header */}
          <View style={styles.header}>
            <Text style={styles.headerTitle}>Scan Recipient QR</Text>
            <TouchableOpacity onPress={onClose} style={styles.closeButton}>
              <Text style={styles.closeText}>×</Text>
            </TouchableOpacity>
          </View>
        </View>

        {/* Bottom sheet: manual address entry */}
        <View style={styles.bottomSheet}>
          <View style={styles.dividerRow}>
            <View style={styles.divider} />
            <Text style={styles.dividerText}>or type / paste address</Text>
            <View style={styles.divider} />
          </View>

          <Text style={styles.inputLabel}>Stellar address</Text>
          <TextInput
            style={[styles.input, manualError ? styles.inputError : null]}
            value={manualAddress}
            onChangeText={(text) => {
              setManualAddress(text);
              setManualError(null);
            }}
            placeholder="G... or C..."
            placeholderTextColor="rgba(246,247,248,0.3)"
            autoCorrect={false}
            autoCapitalize="none"
            spellCheck={false}
            aria-describedby={manualError ? 'qr-manual-error' : undefined}
            aria-invalid={manualError ? true : undefined}
          />
          {manualError && (
            <Text id="qr-manual-error" style={styles.errorText}>
              {manualError}
            </Text>
          )}

          <TouchableOpacity
            style={styles.actionButton}
            onPress={handleManualSubmit}
          >
            <Text style={styles.actionButtonText}>Use this address</Text>
          </TouchableOpacity>

          <TouchableOpacity style={styles.cancelButton} onPress={onClose}>
            <Text style={styles.cancelButtonText}>Cancel</Text>
          </TouchableOpacity>
        </View>
      </View>
    </Modal>
  );
}

const CORNER_SIZE = 20;
const CORNER_THICKNESS = 3;
const CORNER_COLOR = '#D4AF37';

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: '#0B0B0F',
  },
  permissionContainer: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
    padding: 32,
    gap: 16,
  },
  permissionTitle: {
    color: '#F6F7F8',
    fontSize: 20,
    fontWeight: '600',
    fontFamily: 'Lora, Georgia, serif',
    fontStyle: 'italic',
  },
  permissionText: {
    color: 'rgba(246,247,248,0.6)',
    fontSize: 14,
    textAlign: 'center',
    lineHeight: 20,
  },
  permissionButton: {
    backgroundColor: '#D4AF37',
    paddingHorizontal: 24,
    paddingVertical: 12,
    borderRadius: 8,
  },
  permissionButtonText: {
    color: '#0B0B0F',
    fontWeight: '600',
    fontSize: 14,
  },
  overlay: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
  },
  viewfinder: {
    width: 220,
    height: 220,
    position: 'relative',
  },
  corner: {
    position: 'absolute',
    width: CORNER_SIZE,
    height: CORNER_SIZE,
  },
  cornerTopLeft: {
    top: 0,
    left: 0,
    borderTopWidth: CORNER_THICKNESS,
    borderLeftWidth: CORNER_THICKNESS,
    borderColor: CORNER_COLOR,
    borderTopLeftRadius: 4,
  },
  cornerTopRight: {
    top: 0,
    right: 0,
    borderTopWidth: CORNER_THICKNESS,
    borderRightWidth: CORNER_THICKNESS,
    borderColor: CORNER_COLOR,
    borderTopRightRadius: 4,
  },
  cornerBottomLeft: {
    bottom: 0,
    left: 0,
    borderBottomWidth: CORNER_THICKNESS,
    borderLeftWidth: CORNER_THICKNESS,
    borderColor: CORNER_COLOR,
    borderBottomLeftRadius: 4,
  },
  cornerBottomRight: {
    bottom: 0,
    right: 0,
    borderBottomWidth: CORNER_THICKNESS,
    borderRightWidth: CORNER_THICKNESS,
    borderColor: CORNER_COLOR,
    borderBottomRightRadius: 4,
  },
  hint: {
    color: 'rgba(246,247,248,0.5)',
    fontSize: 12,
    textAlign: 'center',
    marginTop: 24,
    paddingHorizontal: 32,
  },
  uiOverlay: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    paddingTop: Platform.OS === 'ios' ? 60 : 40,
    paddingHorizontal: 20,
  },
  header: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
  },
  headerTitle: {
    color: '#F6F7F8',
    fontFamily: 'Lora, Georgia, serif',
    fontWeight: '600',
    fontStyle: 'italic',
    fontSize: 18,
  },
  closeButton: {
    width: 36,
    height: 36,
    borderRadius: 18,
    backgroundColor: 'rgba(246,247,248,0.1)',
    alignItems: 'center',
    justifyContent: 'center',
  },
  closeText: {
    color: '#F6F7F8',
    fontSize: 22,
    lineHeight: 24,
  },
  bottomSheet: {
    paddingHorizontal: 24,
    paddingBottom: Platform.OS === 'ios' ? 40 : 24,
    paddingTop: 16,
    gap: 10,
  },
  dividerRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    marginBottom: 4,
  },
  divider: {
    flex: 1,
    height: 1,
    backgroundColor: 'rgba(246,247,248,0.15)',
  },
  dividerText: {
    color: 'rgba(246,247,248,0.4)',
    fontSize: 11,
  },
  inputLabel: {
    color: 'rgba(246,247,248,0.5)',
    fontSize: 11,
    marginBottom: -4,
  },
  input: {
    backgroundColor: 'rgba(246,247,248,0.06)',
    borderWidth: 1,
    borderColor: 'rgba(246,247,248,0.15)',
    borderRadius: 8,
    color: '#F6F7F8',
    fontSize: 13,
    fontFamily: 'Inconsolata, monospace',
    padding: 12,
  },
  inputError: {
    borderColor: 'rgba(255,80,80,0.6)',
  },
  errorText: {
    color: 'rgba(255,100,100,0.9)',
    fontSize: 12,
  },
  actionButton: {
    backgroundColor: 'rgba(212,175,55,0.15)',
    borderWidth: 1,
    borderColor: 'rgba(212,175,55,0.3)',
    borderRadius: 8,
    paddingVertical: 12,
    alignItems: 'center',
  },
  actionButtonText: {
    color: '#D4AF37',
    fontWeight: '600',
    fontSize: 14,
  },
  cancelButton: {
    paddingVertical: 12,
    alignItems: 'center',
  },
  cancelButtonText: {
    color: 'rgba(246,247,248,0.5)',
    fontSize: 14,
  },
});
