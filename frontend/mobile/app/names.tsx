/**
 * Veil names — buy one from the phone.
 *
 * The native counterpart of `frontend/wallet/app/names/page.tsx`, against the
 * same registry. Mobile could already *send* to a name (`lib/federation.ts`);
 * this is where one is bought.
 *
 * The lookup is debounced and sequence-guarded: a slow answer for an earlier
 * keystroke must never overwrite the answer for what is on screen now, or the
 * field ends up saying "available" about a name the user has already edited
 * away from.
 *
 * Three states kept apart, as on web:
 *
 * 1. **Taken, free, and "could not ask."** `unknown` is never rendered as
 *    available — telling somebody a name is free when nothing can grant it is
 *    how a person pays for nothing.
 * 2. **The local price and the chain's price.** The local one prices a name as
 *    it is typed; the chain's is what will actually be charged, and that is the
 *    number on the button.
 * 3. **Short of USDC, and could not read the balance.** Only a balance that was
 *    read can say someone is short.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Pressable,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import { useRouter } from 'expo-router';

import { ScreenScaffold } from '../components/ScreenScaffold';
import { useTheme } from '../hooks/useTheme';
import type { ThemeColors } from '../lib/theme';
import { fontFamily } from '../theme/typography';
import { errorMessage } from '../lib/errorMessage';
import { isPasskeyCancellation } from '../lib/passkeyOutcome';
import { getWalletAddress } from '../lib/walletStore';
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
  totalUsdc,
  usdcBalance,
  validateName,
} from '../lib/names';

export default function NamesScreen() {
  const router = useRouter();
  const { colors } = useTheme();
  const styles = useMemo(() => createStyles(colors), [colors]);

  const [walletAddress, setWalletAddress] = useState<string | null>(null);
  const [query, setQuery] = useState('');
  const [years, setYears] = useState(MIN_TERM_YEARS);
  const [state, setState] = useState<NameState | null>(null);
  const [checking, setChecking] = useState(false);
  const [quote, setQuote] = useState<bigint | null>(null);
  const [balance, setBalance] = useState<bigint | null>(null);

  const [busy, setBusy] = useState(false);
  const [buyError, setBuyError] = useState<string | null>(null);
  const [boughtHash, setBoughtHash] = useState<string | null>(null);

  const seq = useRef(0);
  const registryId = useMemo(() => namesContractId(), []);

  useEffect(() => {
    void getWalletAddress()
      .then(setWalletAddress)
      .catch(() => setWalletAddress(null));
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
    setBuyError(null);

    const mine = ++seq.current;
    const timer = setTimeout(() => {
      void Promise.all([
        nameState(name, walletAddress ?? undefined),
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
  }, [name, years, shapeOk, registryId, walletAddress]);

  const localTotal = shapeOk ? totalUsdc(name.length, years) : 0;
  const chargeText = quote !== null ? formatUsdc(quote) : String(localTotal);
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
    setBuyError(null);
    try {
      const hash = await registerName(walletAddress, name, years);
      setBoughtHash(hash);
      setState('yours');
      await refreshBalance();
    } catch (err: unknown) {
      if (isPasskeyCancellation(err)) {
        setBuyError('Cancelled. Nothing was charged.');
      } else {
        setBuyError(nameErrorMessage(err, registryId) ?? errorMessage(err));
      }
      // It may have gone while this was in flight.
      if (shapeOk) {
        const s = await nameState(name, walletAddress);
        setState(s);
      }
    } finally {
      setBusy(false);
    }
  };

  return (
    <ScreenScaffold
      eyebrow="VEIL NAMES"
      title="Get paid by name"
      description="A Veil name points to your wallet, so anyone can pay you without copying a 56-character address."
      testID="names-screen"
    >
      <View style={styles.field}>
        <TextInput
          value={query}
          onChangeText={setQuery}
          placeholder="yourname"
          placeholderTextColor={colors.textFaint}
          autoCapitalize="none"
          autoCorrect={false}
          maxLength={MAX_NAME_LENGTH}
          style={styles.input}
          accessibilityLabel="The name you want"
        />
        <Text style={styles.suffix}>{SUFFIX}</Text>
      </View>

      {problem && <Text style={styles.problem}>{VALIDATION_MESSAGES[problem]}</Text>}

      {shapeOk && (
        <View style={styles.statusRow}>
          {checking ? (
            <Text style={styles.statusChecking}>Checking…</Text>
          ) : (
            <Text style={styles.statusText(state)}>
              {state === 'available'
                ? `${name}${SUFFIX} is free`
                : state === 'yours'
                  ? 'You already hold this name'
                  : state === 'taken'
                    ? 'Somebody already holds this name'
                    : state === 'in_recovery'
                      ? 'Lapsed, but only its previous holder can take it for now'
                      : 'Could not reach the registry — this does not mean it is free'}
            </Text>
          )}
        </View>
      )}

      <Text style={styles.sectionLabel}>FOR HOW LONG</Text>
      <View style={styles.terms}>
        {Array.from({ length: MAX_TERM_YEARS }, (_, i) => i + MIN_TERM_YEARS).map((y) => (
          <Pressable
            key={y}
            onPress={() => setYears(y)}
            style={[styles.term, years === y && styles.termActive]}
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

      <View style={styles.priceBox}>
        <View style={styles.priceRow}>
          <Text style={styles.priceLabel}>
            {shapeOk ? `${pricePerYear(name.length)} USDC a year` : 'Price'}
          </Text>
          <Text style={styles.priceValue}>{shapeOk ? `${chargeText} USDC` : '—'}</Text>
        </View>
        {/* Names are rented, not sold. Saying so beside the price is the only
            place somebody is certain to read it. */}
        <Text style={styles.priceNote}>
          Names are rented, not bought outright. This covers {years}{' '}
          {years === 1 ? 'year' : 'years'}; renew any time before it lapses.
        </Text>
        {quote === null && shapeOk && !checking && (
          <Text style={styles.priceNote}>
            That is the published price — the registry did not answer, so it is an estimate rather
            than the charge.
          </Text>
        )}
      </View>

      {!registryId && (
        <Text style={styles.problem}>Veil names are not available on this network.</Text>
      )}
      {registryId && !walletAddress && (
        <Text style={styles.problem}>Open your wallet to buy a name.</Text>
      )}
      {short && (
        <Text style={styles.problem}>
          Not enough USDC in your wallet — you have {formatUsdc(balance ?? 0n)}.
        </Text>
      )}

      {boughtHash ? (
        <View style={styles.doneBox}>
          <Text style={styles.doneText}>
            {name}
            {SUFFIX} is yours. Anyone on Veil — and Lobstr — can now pay you by name.
          </Text>
          <Pressable style={styles.primaryButton} onPress={() => router.push('/veil-ians')}>
            <Text style={styles.primaryButtonText}>Now get a Veil-ian</Text>
          </Pressable>
        </View>
      ) : (
        <Pressable
          style={[styles.primaryButton, !canBuy && styles.buttonDisabled]}
          disabled={!canBuy}
          onPress={handleBuy}
          accessibilityRole="button"
        >
          {busy ? (
            <ActivityIndicator color={colors.onAccent} />
          ) : (
            <Text style={styles.primaryButtonText}>
              {shapeOk ? `Claim for ${chargeText} USDC` : 'Claim'}
            </Text>
          )}
        </Pressable>
      )}

      {busy && (
        <Text style={styles.mutedText}>
          Use your fingerprint, face or screen lock to sign. Nothing is charged until you do.
        </Text>
      )}
      {buyError && <Text style={styles.errorText}>{buyError}</Text>}
    </ScreenScaffold>
  );
}

const createStyles = (colors: ThemeColors) => {
  const base = StyleSheet.create({
    field: {
      flexDirection: 'row',
      alignItems: 'center',
      // borderStrong-equivalent: `border` is too faint to read as an input.
      borderWidth: 1,
      borderColor: colors.textFaint,
      backgroundColor: colors.surface,
      borderRadius: 999,
      paddingHorizontal: 18,
      height: 60,
      marginBottom: 10,
    },
    input: {
      flex: 1,
      color: colors.textStrong,
      fontFamily: fontFamily.address,
      fontSize: 18,
      padding: 0,
    },
    suffix: { color: colors.textMuted, fontFamily: fontFamily.address, fontSize: 15 },

    problem: { color: colors.danger, fontSize: 13, marginBottom: 10, lineHeight: 19 },
    statusRow: { marginBottom: 14 },
    statusChecking: { color: colors.textMuted, fontSize: 13 },

    sectionLabel: {
      fontFamily: fontFamily.accent,
      fontSize: 11,
      letterSpacing: 1.4,
      color: colors.label,
      marginBottom: 8,
    },
    terms: { flexDirection: 'row', gap: 8, marginBottom: 18 },
    term: {
      flex: 1,
      height: 44,
      borderRadius: 999,
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: colors.border,
      backgroundColor: colors.surface,
      alignItems: 'center',
      justifyContent: 'center',
    },
    termActive: { backgroundColor: colors.accent, borderColor: colors.accent },
    termText: { color: colors.textSecondary, fontSize: 13, fontWeight: '600' },
    termTextActive: { color: colors.onAccent },

    priceBox: {
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: colors.border,
      backgroundColor: colors.surface,
      borderRadius: 16,
      padding: 14,
      marginBottom: 16,
      gap: 8,
    },
    priceRow: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'baseline' },
    priceLabel: { color: colors.textMuted, fontSize: 13 },
    priceValue: {
      color: colors.textStrong,
      fontSize: 20,
      fontWeight: '700',
      fontVariant: ['tabular-nums'],
    },
    priceNote: { color: colors.textFaint, fontSize: 12, lineHeight: 17 },

    primaryButton: {
      backgroundColor: colors.accent,
      borderRadius: 999,
      height: 54,
      alignItems: 'center',
      justifyContent: 'center',
    },
    primaryButtonText: { fontSize: 15, fontWeight: '700', color: colors.onAccent },
    buttonDisabled: { opacity: 0.4 },

    doneBox: { gap: 12 },
    doneText: { color: colors.textPrimary, fontSize: 15, lineHeight: 22 },
    mutedText: { color: colors.textMuted, fontSize: 13, marginTop: 10, lineHeight: 19 },
    errorText: { color: colors.danger, fontSize: 13, marginTop: 10, lineHeight: 19 },
  });

  return {
    ...base,
    /** Status colour follows the answer, so it is a function rather than a key. */
    statusText: (state: NameState | null) => ({
      fontSize: 14,
      fontWeight: '600' as const,
      lineHeight: 20,
      color:
        state === 'available'
          ? colors.positive
          : state === 'yours'
            ? colors.accentText
            : state === 'unknown' || state === null
              ? colors.textMuted
              : colors.textSecondary,
    }),
  };
};
