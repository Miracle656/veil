/**
 * Veil names — buy one from the phone.
 *
 * A flow screen, built like Airtime and Send: `SafeAreaView` + `FlowHeader`
 * over a `ScrollView`, Anton labels, hairline cards, and `SlideToConfirm` for
 * the one action that spends money. Mobile could already *send* to a name
 * (`lib/federation.ts`); this is where one is bought.
 *
 * The lookup is debounced and sequence-guarded: a slow answer for an earlier
 * keystroke must never overwrite the answer for what is on screen now, or the
 * field ends up saying "available" about a name the user has edited away from.
 *
 * Three states kept apart, as on web:
 *
 *   1. Taken, free, and "could not ask". `unknown` is never rendered as
 *      available — saying a name is free when nothing can grant it is how
 *      somebody pays for nothing.
 *   2. The local price and the chain's price. The local one prices a name as it
 *      is typed; the chain's is what will be charged, and that is the number on
 *      the slider.
 *   3. Short of USDC, and could not read the balance. Only a balance that was
 *      read can say somebody is short.
 */

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
import { useRouter } from 'expo-router';

import { FlowHeader } from '../components/FlowHeader';
import { SlideToConfirm } from '../components/SlideToConfirm';
import { useTheme } from '../hooks/useTheme';
import type { ThemeColors } from '../lib/theme';
import { fontFamily } from '../theme/typography';
import { errorMessage } from '../lib/errorMessage';
import { isPasskeyCancellation } from '../lib/passkeyOutcome';
import { getOwnAddresses } from '../lib/ownAddresses';
import { namesContractId } from '../lib/veilIans';
import {
  MAX_NAME_LENGTH,
  MAX_TERM_YEARS,
  MIN_NAME_LENGTH,
  MIN_TERM_YEARS,
  SUFFIX,
  VALIDATION_MESSAGES,
  type NameState,
  formatUsdc,
  nameErrorMessage,
  nameState,
  normalizeName,
  pricePerYear,
  quoteFromChain,
  registerName,
  usdcBalance,
  validateName,
} from '../lib/names';

export default function NamesScreen() {
  const router = useRouter();
  const { colors } = useTheme();
  const styles = useMemo(() => createStyles(colors), [colors]);

  const [walletAddress, setWalletAddress] = useState<string | null>(null);
  // The spending account (`G…`). A name bought on the web for a phone-made
  // wallet is held there, and it is still this user's name.
  const [spendingAddress, setSpendingAddress] = useState<string | null>(null);
  const [query, setQuery] = useState('');
  const [years, setYears] = useState(MIN_TERM_YEARS);
  const [state, setState] = useState<NameState | null>(null);
  const [checking, setChecking] = useState(false);
  const [quote, setQuote] = useState<bigint | null>(null);
  const [balance, setBalance] = useState<bigint | null>(null);

  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [boughtHash, setBoughtHash] = useState<string | null>(null);

  const seq = useRef(0);
  const registryId = useMemo(() => namesContractId(), []);

  useEffect(() => {
    void getOwnAddresses().then((own) => {
      setWalletAddress(own.wallet);
      setSpendingAddress(own.spending);
    });
  }, []);

  const refreshBalance = useCallback(async () => {
    if (!walletAddress) return;
    setBalance(await usdcBalance(walletAddress));
  }, [walletAddress]);

  useEffect(() => {
    void refreshBalance();
  }, [refreshBalance]);

  const name = useMemo(() => normalizeName(query), [query]);
  const problem = useMemo(() => validateName(query), [query]);
  const shapeOk = name.length >= MIN_NAME_LENGTH && problem === null;

  useEffect(() => {
    if (!shapeOk || !registryId) {
      setState(null);
      setQuote(null);
      return;
    }
    setChecking(true);
    setBoughtHash(null);
    setError(null);

    const mine = ++seq.current;
    const timer = setTimeout(() => {
      void Promise.all([
        // Both accounts: a name bought on the web is on the spending account.
        nameState(name, [walletAddress ?? '', spendingAddress ?? '']),
        quoteFromChain(name, years),
      ]).then(([s, q]) => {
        // A slow answer for an earlier keystroke must not overwrite what is on
        // screen now.
        if (mine !== seq.current) return;
        setState(s);
        setQuote(q);
        setChecking(false);
      });
    }, 350);

    return () => clearTimeout(timer);
  }, [name, years, shapeOk, registryId, walletAddress, spendingAddress]);

  const chargeText = quote !== null ? formatUsdc(quote) : null;
  const short = balance !== null && quote !== null && balance < quote;

  const canBuy =
    Boolean(walletAddress) &&
    Boolean(registryId) &&
    shapeOk &&
    state === 'available' &&
    !short &&
    !busy &&
    !boughtHash;

  const handleBuy = async () => {
    if (!walletAddress || !shapeOk) return;
    setBusy(true);
    setError(null);
    try {
      const hash = await registerName(walletAddress, name, years);
      setBoughtHash(hash);
      setState('yours');
      await refreshBalance();
    } catch (err: unknown) {
      if (isPasskeyCancellation(err)) {
        setError('Cancelled. Nothing was charged.');
      } else {
        setError(nameErrorMessage(err, registryId) ?? errorMessage(err));
      }
      if (shapeOk) setState(await nameState(name, [walletAddress, spendingAddress ?? '']));
    } finally {
      setBusy(false);
    }
  };

  return (
    <SafeAreaView style={styles.screen} edges={['top']}>
      <View style={styles.header}>
        <FlowHeader title="Veil name" />
      </View>

      <KeyboardAvoidingView
        style={styles.flex}
        behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
        keyboardVerticalOffset={16}
      >
        <ScrollView
          style={styles.flex}
          showsVerticalScrollIndicator={false}
          contentContainerStyle={styles.body}
          keyboardShouldPersistTaps="handled"
        >
          {!registryId ? (
            <View style={styles.card}>
              <Text style={styles.eyebrow}>MAINNET ONLY</Text>
              <Text style={styles.question}>Veil names are not on this network</Text>
              <Text style={styles.hint}>
                The registry lives on mainnet. Switch network in Settings, then come back.
              </Text>
            </View>
          ) : null}

          {error ? (
            <View style={styles.errorCard}>
              <Text style={styles.errorText}>{error}</Text>
            </View>
          ) : null}

          {boughtHash ? (
            <>
              <View style={styles.card}>
                <Text style={styles.eyebrow}>YOURS</Text>
                <Text style={styles.question}>
                  {name}
                  {SUFFIX}
                </Text>
                <Text style={styles.hint}>
                  Anyone on Veil — and Lobstr — can now pay you by name instead of a
                  56-character address.
                </Text>
              </View>
              <Pressable
                onPress={() => router.push('/veil-ians')}
                style={({ pressed }) => [styles.primaryBtn, pressed && styles.pressed]}
              >
                <Text style={styles.primaryText}>Now get a Veil-ian</Text>
              </Pressable>
              <Pressable
                onPress={() => router.back()}
                style={({ pressed }) => [styles.secondaryBtn, pressed && styles.pressed]}
              >
                <Text style={styles.secondaryText}>Done</Text>
              </Pressable>
            </>
          ) : (
            <>
              <View style={styles.field}>
                <Text style={styles.label}>YOUR NAME</Text>
                <View style={styles.nameRow}>
                  <TextInput
                    value={query}
                    onChangeText={setQuery}
                    placeholder="yourname"
                    placeholderTextColor={colors.textFaint}
                    autoCapitalize="none"
                    autoCorrect={false}
                    maxLength={MAX_NAME_LENGTH}
                    style={styles.nameInput}
                    accessibilityLabel="The name you want"
                  />
                  <Text style={styles.suffix}>{SUFFIX}</Text>
                </View>
                {problem ? (
                  <Text style={styles.hintWarn}>{VALIDATION_MESSAGES[problem]}</Text>
                ) : shapeOk ? (
                  checking ? (
                    <Text style={styles.hint}>Checking…</Text>
                  ) : (
                    <Text style={styles.statusText(state)}>
                      {state === 'available'
                        ? `${name}${SUFFIX} is free`
                        : state === 'yours'
                          ? 'You already hold this name'
                          : state === 'taken'
                            ? 'Somebody already holds this name'
                            : state === 'in_recovery'
                              ? 'Lapsed — only its previous holder can take it for now'
                              : 'Could not reach the registry. This does not mean it is free.'}
                    </Text>
                  )
                ) : null}
              </View>

              <View style={styles.field}>
                <Text style={styles.label}>FOR HOW LONG</Text>
                <View style={styles.termRow}>
                  {Array.from({ length: MAX_TERM_YEARS }, (_, i) => i + MIN_TERM_YEARS).map((y) => (
                    <Pressable
                      key={y}
                      onPress={() => setYears(y)}
                      style={({ pressed }) => [
                        styles.term,
                        years === y && styles.termActive,
                        pressed && styles.pressed,
                      ]}
                      accessibilityRole="button"
                      accessibilityState={{ selected: years === y }}
                    >
                      <Text style={[styles.termText, years === y && styles.termTextActive]}>
                        {y}
                        {y === 1 ? ' yr' : ' yrs'}
                      </Text>
                    </Pressable>
                  ))}
                </View>
              </View>

              <View style={styles.card}>
                <View style={styles.row}>
                  <Text style={styles.rowLabel}>
                    {shapeOk ? `${pricePerYear(name.length)} USDC a year` : 'Price'}
                  </Text>
                  <Text style={styles.money}>
                    {chargeText ? `${chargeText} USDC` : '—'}
                  </Text>
                </View>
                <Text style={styles.hint}>
                  Names are rented, not bought outright. This covers {years}{' '}
                  {years === 1 ? 'year' : 'years'}; renew any time before it lapses.
                </Text>
                {shapeOk && !checking && quote === null ? (
                  <Text style={styles.hint}>
                    The registry did not answer, so no price can be quoted yet.
                  </Text>
                ) : null}
              </View>

              {!walletAddress && registryId ? (
                <Text style={styles.hintWarn}>Open your wallet to buy a name.</Text>
              ) : null}
              {short ? (
                <Text style={styles.hintWarn}>
                  Not enough USDC in your wallet — you have {formatUsdc(balance ?? 0n)}.
                </Text>
              ) : null}

              {busy ? (
                <View style={styles.busyRow}>
                  <ActivityIndicator color={colors.accent} />
                  <Text style={styles.centeredHint}>Confirming on Stellar…</Text>
                </View>
              ) : (
                <>
                  <SlideToConfirm
                    testID="names-slide-to-claim"
                    label={chargeText ? `Slide to claim for ${chargeText} USDC` : 'Slide to claim'}
                    disabled={!canBuy}
                    onConfirm={() => void handleBuy()}
                  />
                  <Text style={styles.centeredHint}>Then confirm with your passkey</Text>
                </>
              )}
            </>
          )}
        </ScrollView>
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}

function createStyles(colors: ThemeColors) {
  const base = StyleSheet.create({
    screen: { flex: 1, backgroundColor: colors.background },
    flex: { flex: 1 },
    header: { paddingHorizontal: 20, paddingTop: 16 },
    body: { padding: 20, paddingBottom: 60, gap: 16 },

    card: {
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: colors.border,
      borderRadius: 16,
      padding: 16,
      gap: 8,
    },
    errorCard: {
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: colors.danger,
      borderRadius: 12,
      padding: 12,
      backgroundColor: colors.dangerSurface,
    },
    errorText: { color: colors.danger, fontFamily: fontFamily.body, fontSize: 13, lineHeight: 19 },

    eyebrow: { color: colors.textMuted, fontFamily: fontFamily.accent, fontSize: 11, letterSpacing: 0.8 },
    question: { color: colors.textStrong, fontFamily: fontFamily.heading, fontSize: 20 },
    hint: { color: colors.textMuted, fontFamily: fontFamily.body, fontSize: 13, lineHeight: 19 },
    hintWarn: { color: colors.danger, fontFamily: fontFamily.body, fontSize: 13, lineHeight: 19 },
    centeredHint: {
      color: colors.textMuted,
      fontFamily: fontFamily.body,
      fontSize: 13,
      textAlign: 'center',
    },
    money: { color: colors.textStrong, fontFamily: fontFamily.heading, fontSize: 28 },

    row: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', paddingVertical: 4, gap: 12 },
    rowLabel: { color: colors.textMuted, fontFamily: fontFamily.body, fontSize: 13, flexShrink: 1 },

    field: { gap: 6 },
    label: { color: colors.textMuted, fontFamily: fontFamily.accent, fontSize: 11, letterSpacing: 0.8 },

    // The name sits on a single underline with its suffix beside it, matching
    // how Airtime draws the phone number rather than a boxed field.
    nameRow: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: 8,
      paddingTop: 8,
      paddingBottom: 10,
      borderBottomWidth: 1.5,
      borderBottomColor: colors.borderStrong,
    },
    nameInput: {
      flex: 1,
      color: colors.textStrong,
      fontFamily: fontFamily.address,
      fontSize: 22,
      padding: 0,
    },
    suffix: { color: colors.textMuted, fontFamily: fontFamily.address, fontSize: 15 },

    termRow: { flexDirection: 'row', gap: 8 },
    term: {
      flex: 1,
      paddingVertical: 12,
      borderRadius: 999,
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: colors.border,
      alignItems: 'center',
    },
    termActive: { backgroundColor: colors.accent, borderColor: colors.accent },
    termText: { color: colors.textSecondary, fontFamily: fontFamily.bodySemiBold, fontSize: 13 },
    termTextActive: { color: colors.onAccent },

    busyRow: { gap: 10, paddingVertical: 12 },

    primaryBtn: {
      backgroundColor: colors.accent,
      borderRadius: 999,
      paddingVertical: 16,
      alignItems: 'center',
    },
    primaryText: { color: colors.onAccent, fontFamily: fontFamily.bodySemiBold, fontSize: 16 },
    secondaryBtn: {
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: colors.border,
      borderRadius: 999,
      paddingVertical: 16,
      alignItems: 'center',
    },
    secondaryText: { color: colors.textPrimary, fontFamily: fontFamily.bodySemiBold, fontSize: 16 },

    pressed: { opacity: 0.85 },
  });

  return {
    ...base,
    /** Status colour follows the answer, so it is a function rather than a key. */
    statusText: (state: NameState | null) => ({
      color:
        state === 'available'
          ? colors.positive
          : state === 'yours'
            ? colors.accentText
            : state === 'unknown' || state === null
              ? colors.textMuted
              : colors.textSecondary,
      fontFamily: fontFamily.body,
      fontSize: 13,
      lineHeight: 19,
    }),
  };
}
