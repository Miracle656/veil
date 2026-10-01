import React, { useState } from 'react';
import { ActivityIndicator, Modal, Pressable, StyleSheet, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { submitSep8Transaction, verifyRevisedTransaction, type Sep8Response } from '../../sdk';
import { useTheme } from '../hooks/useTheme';
import type { ThemeColors } from '../lib/theme';
import { fontFamily } from '../theme/typography';
import { FlowHeader } from './FlowHeader';

interface Asset {
  code: string;
  issuer: string;
  issuerName?: string;
}

interface Props {
  asset: Asset;
  approvalServerUrl: string;
  transactionXdr: string;
  onApprovalSuccess: (response: Sep8Response) => void;
  onApprovalError: (error: Error) => void;
  onCancel?: () => void;
}

type Step = 'pending' | 'action_required' | 'revised' | 'error' | 'success';

export function RegulatedAssetApproval({
  asset,
  approvalServerUrl,
  transactionXdr,
  onApprovalSuccess,
  onApprovalError,
  onCancel,
}: Props) {
  const { colors, isDark } = useTheme();
  const styles = useMemo(() => createStyles(colors), [colors]);

  const [step, setStep] = useState<Step>('pending');
  const [error, setError] = useState<string | null>(null);
  const [actionUrl, setActionUrl] = useState<string | null>(null);
  const [actionMethod, setActionMethod] = useState<'GET' | 'POST'>('GET');
  const [revisedMessage, setRevisedMessage] = useState<string | null>(null);
  const [revisedXdr, setRevisedXdr] = useState<string | null>(null);
  const [pendingTimeout, setPendingTimeout] = useState<number | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);

  // Initial submission
  React.useEffect(() => {
    submitForApproval();
  }, []);

  async function submitForApproval() {
    setIsSubmitting(true);
    setError(null);

    try {
      const response = await submitSep8Transaction({
        approvalServerUrl,
        transactionXdr,
      });

      switch (response.status) {
        case 'success':
          setStep('success');
          setTimeout(() => onApprovalSuccess(response), 500);
          break;

        case 'revised':
          // Verify the revised transaction before showing it to user
          const isValid = verifyRevisedTransaction(transactionXdr, response.tx);
          if (!isValid) {
            setError(
              'The issuer made substantial changes to your transaction. Please review carefully.',
            );
            setStep('error');
            return;
          }
          setRevisedMessage(response.message);
          setRevisedXdr(response.tx);
          setStep('revised');
          break;

        case 'pending':
          setPendingTimeout(response.timeout ?? 5000);
          setStep('pending');
          // Auto-retry after timeout
          setTimeout(() => {
            setStep('pending');
            submitForApproval();
          }, response.timeout ?? 5000);
          break;

        case 'action_required':
          setActionUrl(response.action_url);
          setActionMethod(response.action_method ?? 'GET');
          setStep('action_required');
          break;

        case 'rejected':
          setError(response.error);
          setStep('error');
          break;
      }
    } catch (err) {
      setError((err as Error).message);
      setStep('error');
      onApprovalError(err as Error);
    } finally {
      setIsSubmitting(false);
    }
  }

  function handleRetryAfterAction() {
    setStep('pending');
    submitForApproval();
  }

  function handleApproveRevised() {
    if (revisedXdr) {
      onApprovalSuccess({
        status: 'revised',
        tx: revisedXdr,
        message: revisedMessage || 'Transaction revised by issuer',
      });
    }
  }

  function handleOpenActionUrl() {
    if (actionUrl) {
      // In a real app, use Linking.openURL or open in WebView
      console.log('Opening action URL:', actionUrl);
      // Linking.openURL(actionUrl).catch(err => setError(err.message));
    }
  }

  function formatIssuerName() {
    return asset.issuerName || asset.issuer.slice(0, 10) + '...';
  }

  // Pending screen
  if (step === 'pending' && isSubmitting) {
    return (
      <Modal transparent animationType="fade" onRequestClose={onCancel}>
        <View style={styles.overlay}>
          <SafeAreaView style={styles.container} edges={['top', 'bottom']}>
            <FlowHeader
              title="Approval"
              onBack={onCancel}
            />
            <View style={styles.content}>
              <View style={styles.centerContent}>
                <ActivityIndicator size="large" color={colors.accent} />
                <Text style={styles.title}>Requesting Approval</Text>
                <Text style={styles.description}>
                  {asset.issuerName || 'Issuer'} is verifying your transaction...
                </Text>
                {pendingTimeout && pendingTimeout > 0 && (
                  <Text style={styles.hint}>
                    Checking again in {Math.ceil(pendingTimeout / 1000)} seconds
                  </Text>
                )}
              </View>
            </View>
          </SafeAreaView>
        </View>
      </Modal>
    );
  }

  // Action required screen (KYC, email verification, etc.)
  if (step === 'action_required') {
    return (
      <Modal transparent animationType="slide" onRequestClose={onCancel}>
        <View style={styles.overlay}>
          <SafeAreaView style={styles.container} edges={['top', 'bottom']}>
            <FlowHeader
              title="Action Required"
              onBack={onCancel}
            />
            <View style={styles.content}>
              <View style={styles.card}>
                <Text style={styles.title}>Complete Verification</Text>
                <Text style={styles.description}>
                  {asset.issuerName || 'The issuer'} requires additional information to approve your
                  transaction.
                </Text>

                <Pressable style={[styles.primaryBtn, { marginTop: 24 }]} onPress={handleOpenActionUrl}>
                  <Text style={styles.primaryText}>Open Verification</Text>
                </Pressable>

                <Text style={styles.hint}>
                  You'll be taken to {asset.issuerName || 'the issuer'}'s verification page.
                </Text>

                <Pressable
                  style={[styles.secondaryBtn, { marginTop: 12 }]}
                  onPress={handleRetryAfterAction}
                >
                  <Text style={styles.secondaryText}>I've Completed Verification</Text>
                </Pressable>
              </View>
            </View>
          </SafeAreaView>
        </View>
      </Modal>
    );
  }

  // Revised transaction screen
  if (step === 'revised') {
    return (
      <Modal transparent animationType="slide" onRequestClose={onCancel}>
        <View style={styles.overlay}>
          <SafeAreaView style={styles.container} edges={['top', 'bottom']}>
            <FlowHeader
              title="Transaction Modified"
              onBack={onCancel}
            />
            <View style={styles.content}>
              <View style={styles.card}>
                <Text style={styles.title}>Issuer Modified Your Transaction</Text>
                <Text style={styles.description}>{revisedMessage}</Text>

                <View style={styles.warningBox}>
                  <Text style={styles.warningIcon}>⚠️</Text>
                  <Text style={styles.warningText}>
                    Please review the changes before signing. The issuer added operations to make your
                    transaction compliant with their requirements.
                  </Text>
                </View>

                <Pressable style={[styles.primaryBtn, { marginTop: 24 }]} onPress={handleApproveRevised}>
                  <Text style={styles.primaryText}>Review and Sign</Text>
                </Pressable>

                <Pressable style={[styles.secondaryBtn, { marginTop: 12 }]} onPress={onCancel}>
                  <Text style={styles.secondaryText}>Cancel</Text>
                </Pressable>
              </View>
            </View>
          </SafeAreaView>
        </View>
      </Modal>
    );
  }

  // Success screen
  if (step === 'success') {
    return (
      <Modal transparent animationType="fade" onRequestClose={onCancel}>
        <View style={styles.overlay}>
          <SafeAreaView style={styles.container} edges={['top', 'bottom']}>
            <View style={styles.centerContent}>
              <Text style={styles.successIcon}>✓</Text>
              <Text style={styles.title}>Approved</Text>
              <Text style={styles.description}>
                {asset.issuerName || 'The issuer'} has approved your transaction.
              </Text>
            </View>
          </SafeAreaView>
        </View>
      </Modal>
    );
  }

  // Error screen
  if (step === 'error') {
    return (
      <Modal transparent animationType="slide" onRequestClose={onCancel}>
        <View style={styles.overlay}>
          <SafeAreaView style={styles.container} edges={['top', 'bottom']}>
            <FlowHeader
              title="Approval Failed"
              onBack={onCancel}
            />
            <View style={styles.content}>
              <View style={styles.card}>
                <Text style={styles.errorIcon}>✕</Text>
                <Text style={styles.title}>Cannot Approve</Text>
                <Text style={styles.errorText}>{error}</Text>

                <Pressable style={[styles.primaryBtn, { marginTop: 24 }]} onPress={onCancel}>
                  <Text style={styles.primaryText}>Back</Text>
                </Pressable>
              </View>
            </View>
          </SafeAreaView>
        </View>
      </Modal>
    );
  }

  return null;
}

function useMemo<T>(fn: () => T, deps: unknown[]): T {
  const [value, setValue] = React.useState(fn);
  React.useEffect(() => {
    setValue(fn());
  }, deps);
  return value;
}

function createStyles(colors: ThemeColors) {
  return StyleSheet.create({
    overlay: {
      flex: 1,
      backgroundColor: colors.background,
    },
    container: {
      flex: 1,
    },
    content: {
      flex: 1,
      padding: 20,
      justifyContent: 'center',
    },
    centerContent: {
      flex: 1,
      justifyContent: 'center',
      alignItems: 'center',
      paddingHorizontal: 20,
    },
    card: {
      backgroundColor: colors.surface,
      borderRadius: 16,
      padding: 20,
      borderWidth: 1,
      borderColor: colors.border,
    },
    title: {
      fontSize: 18,
      fontWeight: '600',
      color: colors.textStrong,
      textAlign: 'center',
      marginBottom: 12,
    },
    description: {
      fontSize: 14,
      color: colors.textSecondary,
      textAlign: 'center',
      lineHeight: 20,
    },
    hint: {
      fontSize: 12,
      color: colors.textMuted,
      textAlign: 'center',
      marginTop: 12,
    },
    warningBox: {
      backgroundColor: 'rgba(255, 159, 0, 0.08)',
      borderRadius: 8,
      padding: 12,
      marginTop: 16,
      alignItems: 'center',
    },
    warningIcon: {
      fontSize: 24,
      marginBottom: 8,
    },
    warningText: {
      fontSize: 13,
      color: colors.text,
      lineHeight: 18,
    },
    errorIcon: {
      fontSize: 48,
      color: colors.danger,
      textAlign: 'center',
      marginBottom: 12,
    },
    errorText: {
      fontSize: 13,
      color: colors.textSecondary,
      textAlign: 'center',
      lineHeight: 18,
      marginTop: 8,
    },
    successIcon: {
      fontSize: 64,
      color: colors.positive,
      textAlign: 'center',
      marginBottom: 16,
    },
    primaryBtn: {
      backgroundColor: colors.accent,
      borderRadius: 8,
      paddingVertical: 12,
      alignItems: 'center',
    },
    primaryText: {
      color: colors.onAccent,
      fontFamily: fontFamily.bodySemiBold,
      fontSize: 15,
    },
    secondaryBtn: {
      backgroundColor: colors.border,
      borderRadius: 8,
      paddingVertical: 12,
      alignItems: 'center',
    },
    secondaryText: {
      color: colors.textPrimary,
      fontFamily: fontFamily.body,
      fontSize: 15,
    },
  });
}
