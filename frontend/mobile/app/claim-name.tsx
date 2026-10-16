import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ActivityIndicator,
  KeyboardAvoidingView,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useRouter, useLocalSearchParams } from 'expo-router';

import { useTheme } from '../hooks/useTheme';
import type { ThemeColors } from '../lib/theme';
import { fontFamily } from '../theme/typography';
import { FlowHeader } from '../components/FlowHeader';
import { getWalletAddress } from '../lib/walletStore';
import { getMasqueradeFigureForOrder, type MasqueradeFigure } from '../lib/masquerade';

export const CLAIM_PRICE_USDC = '5 USDC';

export default function ClaimNameScreen() {
  const router = useRouter();
  const params = useLocalSearchParams<{ name?: string }>();
  const { colors } = useTheme();
  const styles = useMemo(() => createStyles(colors), [colors]);

  const [name, setName] = useState(params.name || '');
  const [walletAddress, setWalletAddress] = useState<string | null>(null);
  const [isChecking, setIsChecking] = useState(false);
  const [available, setAvailable] = useState<boolean | null>(null);
  const [reason, setReason] = useState<string | null>(null);
  const [nextClaimOrder, setNextClaimOrder] = useState<number>(1);
  const [figure, setFigure] = useState<MasqueradeFigure | null>(null);
  const [hasFigure, setHasFigure] = useState(true);
  const [figureWarning, setFigureWarning] = useState<string | null>(null);
  const [figureNote, setFigureNote] = useState<string | null>(null);

  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState(false);

  const debounceTimerRef = useRef<NodeJS.Timeout | null>(null);

  useEffect(() => {
    getWalletAddress().then(setWalletAddress).catch(() => undefined);
  }, []);

  const checkAvailability = useCallback(async (candidate: string) => {
    const trimmed = candidate.trim().toLowerCase();
    if (!trimmed) {
      setAvailable(null);
      setReason(null);
      setIsChecking(false);
      return;
    }

    setIsChecking(true);
    setReason(null);

    try {
      const baseUrl = process.env['EXPO_PUBLIC_API_URL'] || 'https://app.useveilapp.xyz';
      const res = await fetch(`${baseUrl}/api/names/available?name=${encodeURIComponent(trimmed)}`);
      if (res.ok) {
        const data = await res.json();
        setAvailable(data.available);
        setReason(data.reason || null);
        setNextClaimOrder(data.nextClaimOrder || 1);
        setHasFigure(data.hasFigure !== false);
        setFigure(data.figure || null);
        setFigureWarning(data.figureWarning || null);
        setFigureNote(data.figureNote || null);
      } else {
        // Fallback local normalization if offline/unreachable
        const VALID_REGEX = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
        if (trimmed.length < 3 || trimmed.length > 32 || !VALID_REGEX.test(trimmed)) {
          setAvailable(false);
          setReason('Names must be 3-32 characters: lowercase alphanumeric and hyphens');
        } else {
          setAvailable(true);
          const fig = getMasqueradeFigureForOrder(1);
          setHasFigure(fig.hasFigure);
          setFigure(fig.figure);
        }
      }
    } catch {
      // Local fallback
      const VALID_REGEX = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
      if (trimmed.length < 3 || trimmed.length > 32 || !VALID_REGEX.test(trimmed)) {
        setAvailable(false);
        setReason('Names must be 3-32 characters: lowercase alphanumeric and hyphens');
      } else {
        setAvailable(true);
        const fig = getMasqueradeFigureForOrder(1);
        setHasFigure(fig.hasFigure);
        setFigure(fig.figure);
      }
    } finally {
      setIsChecking(false);
    }
  }, []);

  useEffect(() => {
    if (debounceTimerRef.current) clearTimeout(debounceTimerRef.current);
    if (!name.trim()) {
      setAvailable(null);
      return;
    }

    debounceTimerRef.current = setTimeout(() => {
      void checkAvailability(name);
    }, 250);

    return () => {
      if (debounceTimerRef.current) clearTimeout(debounceTimerRef.current);
    };
  }, [name, checkAvailability]);

  const handleClaim = async () => {
    if (busy || !available || !name.trim()) return;
    setBusy(true);
    setError(null);

    try {
      // Mock payment and registration flow on mobile
      await new Promise((resolve) => setTimeout(resolve, 800));
      setSuccess(true);
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Payment or claim failed.');
    } finally {
      setBusy(false);
    }
  };

  if (success) {
    return (
      <SafeAreaView style={styles.safeArea}>
        <FlowHeader title="Claim Name" />
        <View style={styles.successContainer}>
          <Text style={styles.successEmoji}>🎉</Text>
          <Text style={styles.successTitle}>{name.trim()}*useveilapp.xyz</Text>
          <Text style={styles.successSubtitle}>Permanently bound to your Veil wallet</Text>
          {figure && (
            <View style={styles.figureCard}>
              <Text style={styles.figureHeader}>Early Claimant Collectible</Text>
              <Text style={styles.figureName}>{figure.name}</Text>
              <Text style={styles.figureTraits}>
                {figure.crown} · {figure.aperture} · {figure.palette}
              </Text>
            </View>
          )}
          <Pressable style={styles.primaryButton} onPress={() => router.back()}>
            <Text style={styles.primaryButtonText}>Done</Text>
          </Pressable>
        </View>
      </SafeAreaView>
    );
  }

  return (
    <SafeAreaView style={styles.safeArea}>
      <FlowHeader title="Claim Name" />
      <KeyboardAvoidingView
        behavior={Platform.OS === 'ios' ? 'padding' : undefined}
        style={styles.keyboardContainer}
      >
        <ScrollView contentContainerStyle={styles.scrollContent}>
          {/* Price displayed before keyboard/typing */}
          <View style={styles.priceCard}>
            <View>
              <Text style={styles.priceLabel}>REGISTRATION FEE</Text>
              <Text style={styles.priceSubtext}>Permanent ownership · SEP-2 federation</Text>
            </View>
            <Text style={styles.priceValue}>{CLAIM_PRICE_USDC}</Text>
          </View>

          {/* Name input */}
          <View style={styles.inputCard}>
            <Text style={styles.inputLabel}>CHOOSE YOUR NAME</Text>
            <View style={styles.inputWrapper}>
              <TextInput
                style={styles.input}
                value={name}
                onChangeText={setName}
                placeholder="alice"
                placeholderTextColor={colors.textSecondary}
                autoCapitalize="none"
                autoCorrect={false}
              />
              <Text style={styles.suffix}>*useveilapp.xyz</Text>
            </View>

            {/* Live availability feedback */}
            {name.trim() !== '' && (
              <View style={styles.statusRow}>
                {isChecking ? (
                  <ActivityIndicator size="small" color={colors.gold} />
                ) : available === true ? (
                  <Text style={styles.availableText}>✓ {name.trim().toLowerCase()} is available</Text>
                ) : reason ? (
                  <Text style={styles.unavailableText}>✕ {reason}</Text>
                ) : null}
              </View>
            )}
          </View>

          {/* Figure Preview Card - shown before payment */}
          {hasFigure && figure && (
            <View style={styles.figureCard}>
              <View style={styles.figureTitleRow}>
                <Text style={styles.figureHeader}>EARLY CLAIMANT REWARD</Text>
                <Text style={styles.figureCounter}>Figure #{nextClaimOrder} of 20</Text>
              </View>
              <Text style={styles.figureName}>{figure.name}</Text>
              <View style={styles.traitsGrid}>
                <Text style={styles.traitText}>Crown: {figure.crown}</Text>
                <Text style={styles.traitText}>Aperture: {figure.aperture}</Text>
                <Text style={styles.traitText}>Ornament: {figure.ornament}</Text>
                <Text style={styles.traitText}>Palette: {figure.palette}</Text>
              </View>
              {figureNote && <Text style={styles.figureNote}>✦ {figureNote}</Text>}
            </View>
          )}

          {/* Claimant 21+ notice */}
          {!hasFigure && (
            <View style={styles.warningCard}>
              <Text style={styles.warningTitle}>Collectible Allocation Finished</Text>
              <Text style={styles.warningText}>
                {figureWarning ||
                  'All 20 Veil Masquerade figures have been allocated. You will receive your name, but no Masquerade figure token.'}
              </Text>
            </View>
          )}

          {error && <Text style={styles.errorText}>{error}</Text>}

          {/* Double-tap protected claim button */}
          <Pressable
            style={[styles.primaryButton, (!available || busy) && styles.disabledButton]}
            onPress={handleClaim}
            disabled={!available || busy}
          >
            {busy ? (
              <ActivityIndicator color={colors.background} />
            ) : (
              <Text style={styles.primaryButtonText}>
                Pay 5 USDC & Claim {name.trim() ? `${name.trim()}*useveilapp.xyz` : 'Name'}
              </Text>
            )}
          </Pressable>
        </ScrollView>
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}

function createStyles(colors: ThemeColors) {
  return StyleSheet.create({
    safeArea: {
      flex: 1,
      backgroundColor: colors.background,
    },
    keyboardContainer: {
      flex: 1,
    },
    scrollContent: {
      padding: 16,
      gap: 16,
    },
    priceCard: {
      backgroundColor: 'rgba(212, 175, 55, 0.08)',
      borderColor: 'rgba(212, 175, 55, 0.3)',
      borderWidth: 1,
      borderRadius: 16,
      padding: 16,
      flexDirection: 'row',
      justifyContent: 'space-between',
      alignItems: 'center',
    },
    priceLabel: {
      fontFamily: fontFamily.sansBold,
      fontSize: 11,
      letterSpacing: 1.2,
      color: colors.gold,
    },
    priceSubtext: {
      fontSize: 12,
      color: colors.textSecondary,
      marginTop: 2,
    },
    priceValue: {
      fontFamily: fontFamily.sansBold,
      fontSize: 20,
      color: colors.gold,
    },
    inputCard: {
      backgroundColor: colors.cardBackground,
      borderColor: colors.cardBorder,
      borderWidth: 1,
      borderRadius: 16,
      padding: 16,
    },
    inputLabel: {
      fontFamily: fontFamily.sansBold,
      fontSize: 11,
      letterSpacing: 1.2,
      color: colors.textSecondary,
      marginBottom: 8,
    },
    inputWrapper: {
      flexDirection: 'row',
      alignItems: 'center',
      borderWidth: 1,
      borderColor: colors.cardBorder,
      borderRadius: 12,
      paddingHorizontal: 12,
      backgroundColor: colors.background,
    },
    input: {
      flex: 1,
      height: 48,
      color: colors.text,
      fontSize: 15,
      fontFamily: fontFamily.mono,
    },
    suffix: {
      color: colors.textSecondary,
      fontSize: 12,
      fontFamily: fontFamily.mono,
    },
    statusRow: {
      marginTop: 8,
    },
    availableText: {
      color: colors.primary,
      fontSize: 13,
      fontWeight: '600',
    },
    unavailableText: {
      color: '#f87171',
      fontSize: 13,
    },
    figureCard: {
      backgroundColor: 'rgba(212, 175, 55, 0.05)',
      borderColor: 'rgba(212, 175, 55, 0.25)',
      borderWidth: 1,
      borderRadius: 16,
      padding: 16,
    },
    figureTitleRow: {
      flexDirection: 'row',
      justifyContent: 'space-between',
      alignItems: 'center',
      marginBottom: 6,
    },
    figureHeader: {
      fontFamily: fontFamily.sansBold,
      fontSize: 11,
      letterSpacing: 1.2,
      color: colors.gold,
    },
    figureCounter: {
      fontSize: 11,
      color: colors.textSecondary,
      fontFamily: fontFamily.mono,
    },
    figureName: {
      fontSize: 16,
      fontWeight: 'bold',
      color: colors.text,
      marginBottom: 8,
    },
    traitsGrid: {
      flexDirection: 'row',
      flexWrap: 'wrap',
      gap: 8,
      backgroundColor: 'rgba(0,0,0,0.2)',
      padding: 10,
      borderRadius: 10,
    },
    traitText: {
      fontSize: 11,
      color: colors.textSecondary,
      width: '48%',
    },
    figureNote: {
      fontSize: 11,
      color: colors.primary,
      marginTop: 8,
      fontWeight: '500',
    },
    warningCard: {
      backgroundColor: 'rgba(255, 255, 255, 0.05)',
      borderColor: colors.cardBorder,
      borderWidth: 1,
      borderRadius: 16,
      padding: 16,
    },
    warningTitle: {
      fontSize: 14,
      fontWeight: 'bold',
      color: colors.text,
      marginBottom: 4,
    },
    warningText: {
      fontSize: 12,
      color: colors.textSecondary,
      lineHeight: 18,
    },
    primaryButton: {
      backgroundColor: colors.gold,
      borderRadius: 24,
      height: 50,
      justifyContent: 'center',
      alignItems: 'center',
      marginTop: 8,
    },
    disabledButton: {
      opacity: 0.4,
    },
    primaryButtonText: {
      color: colors.background,
      fontSize: 15,
      fontWeight: 'bold',
    },
    errorText: {
      color: '#f87171',
      fontSize: 13,
      textAlign: 'center',
    },
    successContainer: {
      flex: 1,
      padding: 24,
      alignItems: 'center',
      justifyContent: 'center',
    },
    successEmoji: {
      fontSize: 48,
      marginBottom: 16,
    },
    successTitle: {
      fontSize: 22,
      fontWeight: 'bold',
      color: colors.text,
      marginBottom: 8,
    },
    successSubtitle: {
      fontSize: 14,
      color: colors.textSecondary,
      marginBottom: 24,
    },
  });
}
