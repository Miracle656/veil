/**
 * Link Discord — prove this wallet is yours and get your roles in the Veil
 * Discord server.
 *
 * Reached two ways: the link the bot gives (`…/link-discord?code=…`, which
 * arrives with the code filled in) and Settings → Link Discord (where the code
 * is typed).
 *
 * The screen never signs straight away. It first asks the backend whose code
 * this is and shows that Discord name, because the one thing a stranger could
 * try is handing someone their own code: "tap this to get your roles" would
 * then put the victim's roles on the stranger's account. Seeing the wrong name
 * is the user's chance to stop.
 *
 * Nothing here sends a transaction or spends anything; the copy says so, since
 * a fingerprint prompt in a wallet otherwise reads as a payment.
 */

import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react';
import {
  ActivityIndicator,
  KeyboardAvoidingView,
  Platform,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useLocalSearchParams, useRouter } from 'expo-router';

import { FlowHeader } from '../components/FlowHeader';
import { Button } from '../components/ui/Button';
import { useTheme } from '../hooks/useTheme';
import {
  canLinkOnThisNetwork,
  formatLinkCode,
  getLinkableAccounts,
  linkDiscord,
  lookUpLinkCode,
  normalizeLinkCode,
  type LinkableAccounts,
  type LinkCodeInfo,
  type LinkResult,
} from '../lib/discordLink';
import { errorMessage } from '../lib/errorMessage';
import { isPasskeyCancellation } from '../lib/passkeyOutcome';
import type { ThemeColors } from '../lib/theme';
import { fontFamily } from '../theme/typography';

function short(address: string): string {
  return `${address.slice(0, 6)}…${address.slice(-6)}`;
}

export default function LinkDiscordScreen() {
  const router = useRouter();
  const { colors } = useTheme();
  const styles = useMemo(() => createStyles(colors), [colors]);
  const params = useLocalSearchParams<{ code?: string }>();

  const [accounts, setAccounts] = useState<LinkableAccounts | undefined>(undefined);
  const [typed, setTyped] = useState('');
  const [info, setInfo] = useState<LinkCodeInfo | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<LinkResult | null>(null);

  useEffect(() => {
    let alive = true;
    getLinkableAccounts()
      .then((found) => alive && setAccounts(found))
      .catch(() => alive && setAccounts({ wallet: null, spending: null }));
    return () => {
      alive = false;
    };
  }, []);

  const lookUp = useCallback(async (raw: string) => {
    const code = normalizeLinkCode(raw);
    if (!code) {
      setError('That does not look like a code from the Veil bot. It is eight letters and digits.');
      return;
    }
    setBusy(true);
    setError(null);
    try {
      setInfo(await lookUpLinkCode(code));
    } catch (caught) {
      setError(errorMessage(caught) || 'That code could not be checked. Try again.');
    } finally {
      setBusy(false);
    }
  }, []);

  // A code that came with the link is looked up at once; the user still has
  // to read the name and approve.
  const linkedCode = typeof params.code === 'string' ? params.code : '';
  useEffect(() => {
    if (!linkedCode) return;
    setTyped(linkedCode);
    void lookUp(linkedCode);
  }, [linkedCode, lookUp]);

  const approve = useCallback(async () => {
    if (!info || !accounts) return;
    setBusy(true);
    setError(null);
    try {
      setResult(await linkDiscord(info, accounts));
    } catch (caught) {
      if (isPasskeyCancellation(caught)) {
        setError('Cancelled. Nothing was linked.');
      } else {
        setError(errorMessage(caught) || 'Could not link. Nothing was changed.');
      }
    } finally {
      setBusy(false);
    }
  }, [accounts, info]);

  const hasWallet = Boolean(accounts?.wallet || accounts?.spending);
  const onMainnet = canLinkOnThisNetwork();

  let body: ReactNode;
  if (accounts === undefined) {
    body = <ActivityIndicator style={styles.loading} color={colors.accent} />;
  } else if (!hasWallet) {
    body = (
      <>
        <Text style={styles.lead}>There is no wallet on this phone yet.</Text>
        <Text style={styles.body}>Create or sign in to your wallet first, then come back to link Discord.</Text>
        <Button label="Create a wallet" onPress={() => router.replace('/create-wallet')} style={styles.action} />
      </>
    );
  } else if (!onMainnet) {
    body = (
      <>
        <Text style={styles.lead}>Roles are for mainnet wallets.</Text>
        <Text style={styles.body}>
          This phone is on the test network. Switch to mainnet in Settings, then open the link from Discord again.
        </Text>
        <Button label="Open settings" variant="ghost" onPress={() => router.replace('/settings')} style={styles.action} />
      </>
    );
  } else if (result) {
    body = (
      <>
        <Text style={styles.lead}>Linked to {info?.discordUsername ?? 'your Discord account'}.</Text>
        {!result.inServer ? (
          <Text style={styles.body}>
            That Discord account is not in the Veil server yet. Join the server and your roles will be added at the
            next daily check, or press Refresh roles there.
          </Text>
        ) : result.roles.length > 0 ? (
          <>
            <Text style={styles.sectionLabel}>Your roles</Text>
            <View style={styles.card}>
              {result.roles.map((role) => (
                <Text key={role} style={styles.role}>
                  {role}
                </Text>
              ))}
            </View>
          </>
        ) : (
          <Text style={styles.body}>
            No roles yet. They are given for a Veil wallet, a Veil name, a Veil-ian and for using your wallet.
          </Text>
        )}
        {result.incomplete ? (
          <Text style={styles.note}>Some checks could not be finished just now. They will be tried again.</Text>
        ) : null}
        <Text style={styles.note}>
          Your roles are checked again every day. To undo this, use /unlink in the Veil server.
        </Text>
        <Button label="Done" onPress={() => (router.canGoBack() ? router.back() : router.replace('/dashboard'))} style={styles.action} />
      </>
    );
  } else if (info) {
    body = (
      <>
        <Text style={styles.sectionLabel}>Discord account</Text>
        <View style={styles.card}>
          <Text style={styles.discordName}>{info.discordUsername}</Text>
          <Text style={styles.cardHint}>Check this is your own account. If it is not, go back.</Text>
        </View>

        <Text style={styles.sectionLabel}>What will be linked</Text>
        <View style={styles.card}>
          {accounts.wallet ? (
            <View>
              <Text style={styles.rowTitle}>Your wallet</Text>
              <Text style={styles.address}>{short(accounts.wallet)}</Text>
            </View>
          ) : null}
          {accounts.spending ? (
            <View>
              <Text style={styles.rowTitle}>Your spending account</Text>
              <Text style={styles.address}>{short(accounts.spending)}</Text>
            </View>
          ) : null}
        </View>

        <Text style={styles.body}>
          Approving proves these are yours. Nothing is sent and nothing is spent. Only Veil keeps the link; your
          address is not posted in Discord.
        </Text>
        {error ? <Text style={styles.error}>{error}</Text> : null}
        {busy ? (
          <ActivityIndicator style={styles.loading} color={colors.accent} />
        ) : (
          <>
            <Button
              label={accounts.wallet ? 'Approve with fingerprint' : 'Approve'}
              onPress={() => void approve()}
              style={styles.action}
            />
            <Button
              label="Use a different code"
              variant="ghost"
              onPress={() => {
                setInfo(null);
                setError(null);
              }}
            />
          </>
        )}
      </>
    );
  } else {
    body = (
      <>
        <Text style={styles.lead}>Get your roles in the Veil Discord server.</Text>
        <Text style={styles.body}>
          In Discord, press Verify wallet. The bot gives you a code. Type it here.
        </Text>
        <TextInput
          value={typed}
          onChangeText={(value) => {
            setTyped(value);
            setError(null);
          }}
          placeholder="ABCD-2345"
          placeholderTextColor={colors.textFaint}
          autoCapitalize="characters"
          autoCorrect={false}
          maxLength={12}
          style={styles.input}
          accessibilityLabel="Code from the Veil Discord bot"
          onSubmitEditing={() => void lookUp(typed)}
          returnKeyType="go"
        />
        {normalizeLinkCode(typed) ? (
          <Text style={styles.note}>Code {formatLinkCode(normalizeLinkCode(typed) as string)}</Text>
        ) : null}
        {error ? <Text style={styles.error}>{error}</Text> : null}
        {busy ? (
          <ActivityIndicator style={styles.loading} color={colors.accent} />
        ) : (
          <Button label="Continue" onPress={() => void lookUp(typed)} disabled={!typed.trim()} style={styles.action} />
        )}
        <Text style={styles.note}>
          Veil will never message you first, and will never ask for a key, a recovery code or a payment.
        </Text>
      </>
    );
  }

  return (
    <SafeAreaView style={styles.screen} edges={['top', 'bottom']}>
      <KeyboardAvoidingView style={styles.flex} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
        <ScrollView contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled">
          <FlowHeader title="Link Discord" />
          {body}
        </ScrollView>
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}

const createStyles = (colors: ThemeColors) =>
  StyleSheet.create({
    screen: { backgroundColor: colors.background, flex: 1 },
    flex: { flex: 1 },
    content: { gap: 8, paddingHorizontal: 24, paddingTop: 16, paddingBottom: 48 },
    loading: { marginTop: 24 },
    lead: {
      color: colors.textStrong,
      fontFamily: fontFamily.heading,
      fontSize: 22,
      lineHeight: 29,
      marginTop: 24,
    },
    body: {
      color: colors.textSecondary,
      fontFamily: fontFamily.body,
      fontSize: 14,
      lineHeight: 21,
      marginTop: 10,
    },
    note: {
      color: colors.textMuted,
      fontFamily: fontFamily.body,
      fontSize: 12.5,
      lineHeight: 18,
      marginTop: 12,
    },
    sectionLabel: {
      color: colors.textFaint,
      fontFamily: fontFamily.bodySemiBold,
      fontSize: 11,
      letterSpacing: 1.4,
      marginTop: 20,
      textTransform: 'uppercase',
    },
    card: {
      backgroundColor: colors.surface,
      borderColor: colors.border,
      borderRadius: 16,
      borderWidth: 1,
      gap: 12,
      marginTop: 8,
      padding: 16,
    },
    cardHint: { color: colors.textMuted, fontFamily: fontFamily.body, fontSize: 12.5, lineHeight: 18 },
    discordName: { color: colors.textStrong, fontFamily: fontFamily.bodySemiBold, fontSize: 18 },
    rowTitle: { color: colors.textMuted, fontFamily: fontFamily.body, fontSize: 12.5 },
    address: { color: colors.textPrimary, fontFamily: fontFamily.address, fontSize: 15, marginTop: 3 },
    role: { color: colors.textPrimary, fontFamily: fontFamily.bodySemiBold, fontSize: 15 },
    input: {
      backgroundColor: colors.surface,
      borderColor: colors.borderStrong,
      borderRadius: 14,
      borderWidth: 1,
      color: colors.textStrong,
      fontFamily: fontFamily.address,
      fontSize: 22,
      letterSpacing: 3,
      marginTop: 18,
      paddingHorizontal: 16,
      paddingVertical: 14,
      textAlign: 'center',
    },
    error: {
      color: colors.danger,
      fontFamily: fontFamily.body,
      fontSize: 13.5,
      lineHeight: 20,
      marginTop: 12,
    },
    action: { marginTop: 20 },
  });
