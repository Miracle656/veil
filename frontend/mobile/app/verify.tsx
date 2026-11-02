/**
 * The one-time NIN check that stands in front of every naira rail.
 *
 * ## Why this is a route and not a step inside the airtime screen
 *
 * Airtime's Continue pushed `/verify` and nothing lived there (#1200): someone
 * who had never verified filled in a phone number and an amount, pressed
 * continue, and landed on an unmatched route — at the first moment they tried
 * to spend. The KYC step they needed was unreachable, and the app looked broken
 * because it was the navigation that was broken.
 *
 * A verification cannot belong to the flow that needs it. Linq enforces one
 * verified customer per NIN, ever, so this is the single most consequential
 * screen in the app: a rail that asks twice spends a registration that only
 * support can undo. Every naira rail therefore pushes here and comes back —
 * airtime today, and the web wallet's `bills` and `buy-ngn` screens already
 * push to this route with the same params. Three params, all optional so a
 * caller can pass as little as `bills` does:
 *
 *   - `returnTo` — the route to put the user back on once they are verified.
 *   - `label` — the name of the flow they left, used in the copy.
 *   - `summary` — what they were about to do, echoed so the ask has a reason.
 *
 * ## Three failures are three different screens
 *
 * They cost the user different things, so telling them apart is the whole job:
 *   - **Declined** — the number was checked and came back wrong. Nothing is
 *     used up, the digits can be retyped, and "check your 11 digits" is real
 *     advice.
 *   - **Already verified** — either this device already passed the check, or
 *     Linq has this NIN against a *different* customer reference. The first is
 *     a free pass; the second is terminal and needs support, not a retry.
 *   - **Provider unreachable** — wraith answered 503, or never answered. The
 *     number was never sent, so nothing was checked and nothing was spent.
 *
 * ## The NIN is personal data
 *
 * Under Nigeria's NDPA a NIN is personal data, and Linq allows exactly one
 * submission per person. So the digits are read out of state into the request,
 * cleared before the request is even awaited, and never written to storage,
 * never logged, never left in a component after the screen goes. The four
 * contact fields are different: Linq already holds them against this customer,
 * and a rejected NIN is common enough (a middle name, a different spelling)
 * that retyping them is how a fixable mistake becomes an abandoned signup — so
 * those are saved, by name, in `saveVerifyDetails`.
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
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
import { type Href, useLocalSearchParams, useRouter } from 'expo-router';

import { FlowHeader } from '../components/FlowHeader';
import { useNetwork } from '../hooks/useNetwork';
import { useTheme } from '../hooks/useTheme';
import { errorMessage } from '../lib/errorMessage';
import {
  getCustomerRef,
  isNairaKycMismatch,
  isNairaVerified,
  loadVerifyDetails,
  NairaTimeout,
  NairaUnavailable,
  provisionCustomer,
  saveVerifyDetails,
  setNairaKycMismatch,
  setNairaVerified,
  submitKyc,
} from '../lib/onramp';
import type { ThemeColors } from '../lib/theme';
import { fontFamily } from '../theme/typography';

const NIN_LENGTH = 11;

type Stage = 'who' | 'nin' | 'done' | 'declined' | 'details' | 'elsewhere' | 'unreachable';

/**
 * What the identity service said about the number itself.
 *
 * Keyed by wraith's `code`, not by its prose: the provider rewords messages and
 * this screen scrubs the provider's name out of them, so prose is not something
 * a branch may depend on. A code we do not know falls through to the generic
 * declined copy below — guessing is how a web screen came to tell people their
 * name was wrong when the name is never compared at all.
 */
const DECLINED: Record<string, { title: string; body: string }> = {
  invalid_nin_format: {
    title: 'That NIN is not 11 digits',
    body: 'A NIN is exactly 11 digits, with no spaces and no letters. Check it against your slip and enter it again.',
  },
  nin_verification_failed: {
    title: "That NIN didn't verify",
    body: 'The number was checked and came back unverified. Only the number is checked, so your name makes no difference — compare the 11 digits against your NIN slip and try again.',
  },
};

/** Codes that mean the service itself failed, so nothing was ever checked. */
const PROVIDER_CODES = ['kyc_provider_error', 'kyc_internal_error'];

/** Codes that mean this NIN is already bound to another customer reference. */
const SPENT_CODES = ['nin_already_used'];

/**
 * The route to hand the user back to, or null when the param is not a route.
 *
 * It arrives from a navigation param, which means it can be anything a deep
 * link put there. Returning `//host.example` or `https://…` to the navigator
 * would send them out of the app instead of back to their airtime purchase, so
 * anything that is not a plain in-app path is dropped and the screen falls back
 * to going back the way it came.
 */
function inAppPath(raw: string | string[] | undefined): Href | null {
  const value = Array.isArray(raw) ? raw[0] : raw;
  if (!value || !value.startsWith('/')) return null;
  if (value.includes('//') || value.includes('\\') || value.includes(':')) return null;
  return value as Href;
}

/** A param meant to be read as one string, whatever a deep link put in its place. */
function one(raw: string | string[] | undefined): string | null {
  const value = Array.isArray(raw) ? raw[0] : raw;
  return typeof value === 'string' && value.trim() ? value : null;
}

export default function VerifyScreen() {
  const router = useRouter();
  const { colors } = useTheme();
  const styles = useMemo(() => createStyles(colors), [colors]);

  const params = useLocalSearchParams<{ returnTo?: string; label?: string; summary?: string }>();
  const returnTo = inAppPath(params.returnTo);
  const label = one(params.label);
  const summary = one(params.summary);

  const { networkName } = useNetwork();
  // A NIN verifies once, ever, against a reference derived from the wallet
  // address — and the address differs per network. Verifying from testnet would
  // spend the one permanent registration on a wallet their mainnet account can
  // never produce.
  const mainnetOnly = networkName !== 'mainnet';

  const [stage, setStage] = useState<Stage>('who');
  const [firstName, setFirstName] = useState('');
  const [lastName, setLastName] = useState('');
  const [email, setEmail] = useState('');
  const [phone, setPhone] = useState('');
  const [nin, setNin] = useState('');
  const [busy, setBusy] = useState(false);
  const [customerRef, setCustomerRef] = useState<string | null>(null);
  /** The message the service sent, shown under the fixed copy — never instead of it. */
  const [detail, setDetail] = useState<string | null>(null);
  /**
   * The provider's own code from the failure that set the current stage.
   *
   * Kept apart from `detail` because prose is scrubbed of the provider's name
   * and gets reworded, while the code is stable — and because the copy is
   * chosen from it, never from a match against the message.
   */
  const [failureCode, setFailureCode] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const [ref, details, verified, mismatch] = await Promise.all([
        getCustomerRef().catch(() => null),
        loadVerifyDetails().catch(() => null),
        isNairaVerified().catch(() => false),
        isNairaKycMismatch().catch(() => false),
      ]);
      if (cancelled) return;
      setCustomerRef(ref);
      if (details) {
        setFirstName(details.firstName);
        setLastName(details.lastName);
        setEmail(details.email);
        setPhone(details.phone);
      }
      // Order matters: a stranded person gets the explanation, not a form.
      if (mismatch) setStage('elsewhere');
      // Already verified on this device. Asking again cannot work — the NIN is
      // spent — and reaching Linq with a spent number is how a verified person
      // gets told they are not one.
      else if (verified) setStage('done');
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const whoReady =
    firstName.trim().length > 0 &&
    lastName.trim().length > 0 &&
    /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email.trim()) &&
    phone.trim().length >= 10;

  const goToNin = useCallback(() => {
    void saveVerifyDetails({
      firstName: firstName.trim(),
      lastName: lastName.trim(),
      email: email.trim(),
      phone: phone.trim(),
    });
    setStage('nin');
  }, [firstName, lastName, email, phone]);

  const verify = useCallback(async () => {
    if (!customerRef || nin.length !== NIN_LENGTH || mainnetOnly || busy) return;

    // Out of state and into a local before anything else, so the digits cannot
    // outlive this call — not through a re-render, not through the failure
    // paths below, not on the screen that follows.
    const digits = nin;
    setNin('');
    setBusy(true);
    setDetail(null);
    setFailureCode(null);

    // Provisioning runs before the NIN is sent, so a failure there is not a
    // rejection of the number: it was never checked and nothing was used up.
    let phase: 'provision' | 'kyc' = 'provision';
    try {
      // Read what Linq already thinks of this reference before spending a NIN
      // attempt on it. Provisioning is idempotent, so this is a call we were
      // making anyway — and it finishes someone whose reference support has
      // just re-bound, without asking for their NIN again.
      const customer = await provisionCustomer({
        customerRef,
        firstName: firstName.trim(),
        lastName: lastName.trim(),
        email: email.trim(),
        phone: phone.trim(),
      });
      phase = 'kyc';

      if (customer.verified) {
        await setNairaVerified(true);
        await setNairaKycMismatch(false);
        setStage('done');
        return;
      }

      const result = await submitKyc(customerRef, digits);
      // Only ever Linq's own answer. A device that believes it is verified when
      // Linq disagrees cannot recover: the one NIN that would verify it is gone.
      if (result.verified) {
        await setNairaVerified(true);
        await setNairaKycMismatch(false);
        setStage('done');
        return;
      }
      setStage('declined');
    } catch (err) {
      const code = one((err as { code?: string }).code)?.toLowerCase() ?? null;
      // The message goes through `errorMessage`, which scrubs the provider's
      // name — shown as a detail line only, never as the branch.
      const message = errorMessage(err);

      // The service being down is not the number being wrong, and saying so is
      // what stops someone checking a slip for a digit that is already right.
      if (err instanceof NairaUnavailable || err instanceof NairaTimeout) {
        setDetail(message);
        setStage('unreachable');
        return;
      }
      if (code && PROVIDER_CODES.includes(code)) {
        setDetail(message);
        setStage('unreachable');
        return;
      }
      if (code && SPENT_CODES.includes(code)) {
        // Both halves are now known and together they are conclusive: this
        // reference is unverified, and this NIN is spent against another one.
        // Retrying here cannot reach it, so it is its own terminal state rather
        // than a rejection to try again from.
        await setNairaKycMismatch(true);
        setStage('elsewhere');
        return;
      }
      if (phase === 'provision') {
        // The details were refused, before the number ever left the device.
        setDetail(message);
        setStage('details');
        return;
      }
      setFailureCode(code);
      // No usable code, and prose is not something to branch on: the generic
      // declined copy is honest about what happened and nothing more.
      setDetail(code ? null : message);
      setStage('declined');
    } finally {
      setNin('');
      setBusy(false);
    }
  }, [customerRef, nin, mainnetOnly, busy, firstName, lastName, email, phone]);

  const finish = useCallback(() => {
    if (returnTo) {
      // `dismissTo`, not `replace`. The rail that pushed here is still on the
      // stack with the form half-filled: replacing would lay a second, empty
      // `/airtime` on top of it, and the purchase they came to finish would be
      // gone — the exact loss this screen exists to prevent. When `/verify` was
      // entered cold there is nothing to dismiss, and expo-router replaces the
      // current screen with the target, which is the other thing wanted.
      router.dismissTo(returnTo);
      return;
    }
    // `/verify` can be reached with no caller — a stale deep link, a bookmarked
    // route. Go back the way they came rather than inventing a destination.
    if (router.canGoBack()) router.back();
    else router.replace('/');
  }, [returnTo, router]);

  /** Leave a failure screen without carrying its message or code into the next attempt. */
  const clearFailure = useCallback(() => {
    setDetail(null);
    setFailureCode(null);
  }, []);

  const declinedCopy = failureCode ? DECLINED[failureCode] ?? null : null;

  return (
    <SafeAreaView style={styles.screen} edges={['top']}>
      <View style={styles.header}>
        <FlowHeader title="Verify once" />
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
          {mainnetOnly && stage !== 'done' ? (
            <View style={styles.card}>
              <Text style={styles.eyebrow}>MAINNET ONLY</Text>
              <Text style={styles.question}>Switch to mainnet to verify</Text>
              <Text style={styles.hint}>
                Your NIN can be verified once, ever, and it gets tied to the wallet you verify
                from. Doing that on testnet would spend it on a wallet that only exists there, and
                your real one could never be verified afterwards. Switch network in Settings, then
                come back.
              </Text>
            </View>
          ) : null}

          {summary && (stage === 'who' || stage === 'nin') ? (
            <View style={styles.noteCard}>
              <Text style={styles.eyebrow}>YOU WERE ABOUT TO</Text>
              <Text style={styles.rowValue}>{summary}</Text>
              <Text style={styles.hint}>
                {label
                  ? `${label} needs a one-time identity check before it can be paid for. When it is done you go straight back.`
                  : 'This one-time identity check stands in front of paying with naira. When it is done you go straight back.'}
              </Text>
            </View>
          ) : null}

          {stage === 'who' ? (
            <>
              <View style={styles.card}>
                <Text style={styles.eyebrow}>YOUR DETAILS</Text>
                <Text style={styles.hint}>
                  These go to our naira partner so they can match your NIN. Use the name exactly as
                  it appears on your NIN record.
                </Text>
                <View style={styles.field}>
                  <Text style={styles.label}>FIRST NAME</Text>
                  <TextInput
                    style={styles.input}
                    value={firstName}
                    onChangeText={setFirstName}
                    autoCapitalize="words"
                    autoCorrect={false}
                  />
                </View>
                <View style={styles.field}>
                  <Text style={styles.label}>LAST NAME</Text>
                  <TextInput
                    style={styles.input}
                    value={lastName}
                    onChangeText={setLastName}
                    autoCapitalize="words"
                    autoCorrect={false}
                  />
                </View>
                <View style={styles.field}>
                  <Text style={styles.label}>EMAIL</Text>
                  <TextInput
                    style={styles.input}
                    value={email}
                    onChangeText={setEmail}
                    keyboardType="email-address"
                    autoCapitalize="none"
                    autoCorrect={false}
                  />
                </View>
                <View style={styles.field}>
                  <Text style={styles.label}>PHONE</Text>
                  <TextInput
                    style={styles.input}
                    value={phone}
                    onChangeText={setPhone}
                    keyboardType="phone-pad"
                    autoCorrect={false}
                  />
                </View>
              </View>

              {!customerRef ? (
                <View style={styles.noteCard}>
                  <Text style={styles.hint}>
                    This wallet does not have a verification reference yet, so there is nothing for
                    your NIN to bind to. Open your wallet once, then come back here.
                  </Text>
                </View>
              ) : null}

              <Pressable
                onPress={goToNin}
                disabled={!whoReady || mainnetOnly || !customerRef}
                style={({ pressed }) => [
                  styles.primaryBtn,
                  (!whoReady || mainnetOnly || !customerRef) && styles.disabled,
                  pressed && styles.pressed,
                ]}
              >
                <Text style={styles.primaryText}>Continue</Text>
              </Pressable>
            </>
          ) : null}

          {stage === 'nin' ? (
            <>
              <View style={styles.card}>
                <Text style={styles.eyebrow}>NATIONAL IDENTIFICATION NUMBER</Text>
                <Text style={styles.hint}>
                  Eleven digits. It is sent once to verify you and is never stored by Veil.
                </Text>
                <TextInput
                  style={styles.ninInput}
                  value={nin}
                  // Nothing else reads this: it goes into the request and is
                  // cleared as the request starts.
                  onChangeText={(t) => setNin(t.replace(/\D/g, '').slice(0, NIN_LENGTH))}
                  keyboardType="number-pad"
                  autoComplete="off"
                  autoCorrect={false}
                  editable={!busy}
                  placeholder="00000000000"
                  placeholderTextColor={colors.textMuted}
                />
                {busy ? (
                  <View style={styles.waitRow}>
                    <ActivityIndicator color={colors.accent} />
                    <Text style={styles.hint}>Checking with the identity service…</Text>
                  </View>
                ) : null}
              </View>

              <Pressable
                onPress={() => void verify()}
                disabled={busy || nin.length !== NIN_LENGTH || mainnetOnly}
                style={({ pressed }) => [
                  styles.primaryBtn,
                  (busy || nin.length !== NIN_LENGTH || mainnetOnly) && styles.disabled,
                  pressed && styles.pressed,
                ]}
              >
                <Text style={styles.primaryText}>{busy ? 'Checking…' : 'Verify'}</Text>
              </Pressable>

              <Pressable onPress={() => setStage('who')} disabled={busy}>
                <Text style={styles.linkText}>Edit my name</Text>
              </Pressable>
            </>
          ) : null}

          {stage === 'declined' ? (
            <View style={styles.errorCard}>
              <Text style={styles.question}>
                {declinedCopy?.title ?? "That NIN didn't verify"}
              </Text>
              <Text style={styles.hint}>
                {declinedCopy?.body ??
                  'Check the 11 digits against your NIN slip. Only the number is checked, so your name, its order and any middle names make no difference here.'}
              </Text>
              {detail ? <Text style={styles.faint}>{detail}</Text> : null}
              <Text style={styles.hint}>Nothing was saved and your NIN has not been used up.</Text>
              <Pressable
                onPress={() => {
                  clearFailure();
                  setStage('nin');
                }}
                style={({ pressed }) => [styles.primaryBtn, pressed && styles.pressed]}
              >
                <Text style={styles.primaryText}>Try again</Text>
              </Pressable>
              <Pressable
                onPress={() => {
                  clearFailure();
                  setStage('who');
                }}
                style={({ pressed }) => [styles.secondaryBtn, pressed && styles.pressed]}
              >
                <Text style={styles.secondaryText}>Edit my details</Text>
              </Pressable>
            </View>
          ) : null}

          {stage === 'details' ? (
            // This failed before the NIN was sent, so the number on the next
            // screen is not in question and "check your digits" is advice about
            // a step that did not happen.
            <View style={styles.errorCard}>
              <Text style={styles.question}>Couldn&apos;t set up your details</Text>
              <Text style={styles.hint}>
                This failed before your NIN was sent, so it was never checked and nothing has been
                used up. The naira service would not accept the details on the previous screen —
                most often the email or the phone number.
              </Text>
              <Text style={styles.hint}>
                Check the email is one you can receive at, and try the phone in full international
                form, for example +2348030000000.
              </Text>
              {detail ? <Text style={styles.faint}>{detail}</Text> : null}
              <Pressable
                onPress={() => {
                  clearFailure();
                  setStage('who');
                }}
                style={({ pressed }) => [styles.primaryBtn, pressed && styles.pressed]}
              >
                <Text style={styles.primaryText}>Edit my details</Text>
              </Pressable>
            </View>
          ) : null}

          {stage === 'elsewhere' ? (
            // Not a rejection at all: the digits are right and the name matches.
            // Linq holds this NIN against another reference, so there is nothing
            // to correct and nothing to retry.
            <View style={styles.errorCard}>
              <Text style={styles.question}>This NIN is already verified elsewhere</Text>
              <Text style={styles.hint}>
                Your NIN is fine. It is verified against a different customer reference — most
                likely one from an earlier wallet — and a NIN can only ever verify one. Retrying
                here cannot reach it.
              </Text>
              <Text style={styles.reference}>Reference: {customerRef ?? '—'}</Text>
              <Text style={styles.hint}>
                Send that reference to support. Once they have re-bound it, come back and this
                screen will finish without asking for your NIN again.
              </Text>
              <Pressable
                onPress={finish}
                style={({ pressed }) => [styles.secondaryBtn, pressed && styles.pressed]}
              >
                <Text style={styles.secondaryText}>Go back</Text>
              </Pressable>
            </View>
          ) : null}

          {stage === 'unreachable' ? (
            <View style={styles.card}>
              <Text style={styles.question}>The identity service could not be reached</Text>
              <Text style={styles.hint}>
                This is their side, not your number. Nothing was checked and nothing has been used
                up — wait a minute and try the same NIN again.
              </Text>
              {detail ? <Text style={styles.faint}>{detail}</Text> : null}
              <Pressable
                onPress={() => {
                  clearFailure();
                  setStage('nin');
                }}
                style={({ pressed }) => [styles.primaryBtn, pressed && styles.pressed]}
              >
                <Text style={styles.primaryText}>Try again</Text>
              </Pressable>
              <Pressable
                onPress={() => {
                  clearFailure();
                  finish();
                }}
                style={({ pressed }) => [styles.secondaryBtn, pressed && styles.pressed]}
              >
                <Text style={styles.secondaryText}>Not now</Text>
              </Pressable>
            </View>
          ) : null}

          {stage === 'done' ? (
            <>
              <View style={styles.card}>
                <Text style={styles.question}>You&apos;re verified</Text>
                <Text style={styles.hint}>
                  This is a one-time check. You will not be asked again on this wallet.
                </Text>
                {summary ? (
                  <View style={styles.row}>
                    <Text style={styles.rowLabel}>Waiting for you</Text>
                    <Text style={styles.rowValue}>{summary}</Text>
                  </View>
                ) : null}
              </View>

              <Pressable
                onPress={finish}
                style={({ pressed }) => [styles.primaryBtn, pressed && styles.pressed]}
              >
                <Text style={styles.primaryText}>
                  {label ? `Continue with ${label}` : 'Continue'}
                </Text>
              </Pressable>
            </>
          ) : null}
        </ScrollView>
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}

function createStyles(colors: ThemeColors) {
  return StyleSheet.create({
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
    noteCard: {
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: colors.border,
      borderRadius: 16,
      padding: 16,
      backgroundColor: colors.surface,
      gap: 6,
    },
    errorCard: {
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: colors.danger,
      borderRadius: 16,
      padding: 16,
      backgroundColor: colors.dangerSurface,
      gap: 8,
    },

    eyebrow: {
      color: colors.textMuted,
      fontFamily: fontFamily.accent,
      fontSize: 11,
      letterSpacing: 0.8,
    },
    question: { color: colors.textStrong, fontFamily: fontFamily.heading, fontSize: 20 },
    hint: { color: colors.textMuted, fontFamily: fontFamily.body, fontSize: 13, lineHeight: 19 },
    faint: { color: colors.textMuted, fontFamily: fontFamily.body, fontSize: 12, lineHeight: 17 },
    // A reference is handed to support, so it is shown in full and allowed to
    // wrap rather than shortened to fit the line.
    reference: {
      color: colors.accent,
      fontFamily: fontFamily.address,
      fontSize: 13,
      lineHeight: 20,
    },

    row: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', paddingVertical: 4, gap: 12 },
    rowLabel: { color: colors.textMuted, fontFamily: fontFamily.body, fontSize: 13, flexShrink: 1 },
    rowValue: { color: colors.textPrimary, fontFamily: fontFamily.body, fontSize: 13, flexShrink: 1 },

    field: { gap: 6 },
    label: { color: colors.textMuted, fontFamily: fontFamily.accent, fontSize: 11, letterSpacing: 0.8 },
    input: {
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: colors.border,
      borderRadius: 12,
      paddingHorizontal: 14,
      paddingVertical: 12,
      color: colors.textPrimary,
      fontFamily: fontFamily.body,
      fontSize: 16,
    },
    ninInput: {
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: colors.border,
      borderRadius: 12,
      paddingHorizontal: 14,
      paddingVertical: 12,
      color: colors.textStrong,
      fontFamily: fontFamily.address,
      fontSize: 21,
      letterSpacing: 3,
    },

    waitRow: { flexDirection: 'row', alignItems: 'center', gap: 10, paddingVertical: 4 },

    primaryBtn: { backgroundColor: colors.accent, borderRadius: 999, paddingVertical: 16, alignItems: 'center' },
    primaryText: { color: colors.onAccent, fontFamily: fontFamily.bodySemiBold, fontSize: 16 },
    secondaryBtn: {
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: colors.border,
      borderRadius: 999,
      paddingVertical: 16,
      alignItems: 'center',
    },
    secondaryText: { color: colors.textPrimary, fontFamily: fontFamily.bodySemiBold, fontSize: 16 },
    linkText: { color: colors.accent, fontFamily: fontFamily.body, fontSize: 13, paddingTop: 6, textAlign: 'center' },

    disabled: { opacity: 0.4 },
    pressed: { opacity: 0.85 },
  });
}
