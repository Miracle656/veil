import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Animated,
  Easing,
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
import { useLocalSearchParams, useRouter, type Href } from 'expo-router';

import { FlowHeader } from '../components/FlowHeader';
import { useTheme } from '../hooks/useTheme';
import type { ThemeColors } from '../lib/theme';
import { fontFamily } from '../theme/typography';
import { errorMessage } from '../lib/errorMessage';
import { CheckIcon, InfoIcon, LockIcon } from '../components/icons';
import {
  getCustomerRef,
  loadVerifyDetails,
  provisionCustomer,
  saveVerifyDetails,
  setNairaVerified,
  submitKyc,
} from '../lib/onramp';

/**
 * Verify once — the one-time NIN check that stands in front of every naira flow.
 *
 * It is a route rather than a step inside Buy, because it belongs to neither
 * flow and blocks both. Airtime did not ask at all, so an unverified person
 * paying a bill met Linq's "customer … has not completed KYC" instead, which is
 * the worst possible place to learn that a rule exists. Buy asked inside itself,
 * which meant the same five fields would have had to be built again in Airtime.
 *
 * Callers pass where to go afterwards and a one-line description of what they
 * were doing, so the last screen can hand the person back to it by name instead
 * of dropping them somewhere and leaving them to find their way.
 *
 * Two screens of questions, deliberately: a name and contact details are
 * ordinary, and a national identification number is not. Putting the NIN on its
 * own screen is what makes room to say what it is for and that we do not keep
 * it — next to the field, where it is read, rather than in a policy nobody
 * opens.
 */

type Stage = 'who' | 'nin' | 'rejected' | 'done';

const NIN_LENGTH = 11;

export default function VerifyScreen() {
  const router = useRouter();
  const { colors } = useTheme();
  const styles = useMemo(() => createStyles(colors), [colors]);

  const params = useLocalSearchParams<{ returnTo?: string; summary?: string; label?: string }>();
  const returnTo = (params.returnTo as Href) || ('/dashboard' as Href);
  const summary = params.summary ?? '';
  const label = params.label ?? 'where you were';

  const [stage, setStage] = useState<Stage>('who');
  const [busy, setBusy] = useState(false);
  const [customerRef, setCustomerRef] = useState<string | null>(null);

  const [firstName, setFirstName] = useState('');
  const [lastName, setLastName] = useState('');
  const [email, setEmail] = useState('');
  const [phone, setPhone] = useState('');

  // The NIN lives here and nowhere else: not in storage, not in a log, not in
  // any state that outlives this screen. It is personal data under the NDPA,
  // and it is cleared the moment the check comes back either way.
  const [nin, setNin] = useState('');
  const [rejection, setRejection] = useState<string | null>(null);

  const ninInput = useRef<TextInput>(null);

  useEffect(() => {
    let cancelled = false;
    getCustomerRef()
      .then((ref) => {
        if (!cancelled) setCustomerRef(ref);
      })
      .catch(() => undefined);

    // Come back with what they typed last time. A rejected NIN is the common
    // case — Linq matches it against the name, so a middle name or a different
    // spelling fails a number that is correct — and retyping four fields to try
    // again is how a fixable mistake becomes an abandoned signup.
    loadVerifyDetails()
      .then((d) => {
        if (cancelled || !d) return;
        setFirstName(d.firstName);
        setLastName(d.lastName);
        setEmail(d.email);
        setPhone(d.phone);
      })
      .catch(() => undefined);

    return () => {
      cancelled = true;
    };
  }, []);

  const fullName = `${firstName} ${lastName}`.trim();
  const whoReady =
    firstName.trim() !== '' && lastName.trim() !== '' && email.trim() !== '' && phone.trim() !== '';

  const goToNin = useCallback(() => {
    void saveVerifyDetails({
      firstName: firstName.trim(),
      lastName: lastName.trim(),
      email: email.trim(),
      phone: phone.trim(),
    });
    setStage('nin');
    // The digit boxes are a display of one hidden field; focus it so the
    // keyboard is already up when the screen arrives.
    setTimeout(() => ninInput.current?.focus(), 120);
  }, [firstName, lastName, email, phone]);

  const verify = useCallback(async () => {
    if (!customerRef || nin.length !== NIN_LENGTH) return;
    setBusy(true);
    setRejection(null);
    try {
      await provisionCustomer({
        customerRef,
        firstName: firstName.trim(),
        lastName: lastName.trim(),
        email: email.trim(),
        phone: phone.trim(),
      });
      const result = await submitKyc(customerRef, nin);
      // Cleared whichever way it went. A rejected NIN is still a NIN.
      setNin('');
      if (result.verified) {
        await setNairaVerified(true);
        setStage('done');
      } else {
        setRejection(null);
        setStage('rejected');
      }
    } catch (err) {
      setNin('');
      const message = errorMessage(err);

      // "Already used" is not a rejection, and telling someone to check their
      // eleven digits when the digits are right is the worst answer available.
      //
      // Linq allows one verified customer per NIN, forever. So this is the
      // expected reply for someone who verified before and lost local state —
      // a reinstall, cleared storage, a network switch — and the one NIN that
      // would verify them is the one being refused. There is no self-service
      // way out of that, so treating it as failure strands them here.
      //
      // The reference is unchanged in that case, since it is seeded from the
      // wallet address and a recovered wallet reproduces it. So move on and let
      // Linq be the authority at order time: if the reference really is
      // unverified, order creation says so in its own words rather than this
      // screen guessing.
      //
      // This was in `buy-ngn` before verification moved to its own route, and
      // dropping it on the way is why that screen handled this better.
      if (/already|duplicate|exists|in use|verified/i.test(message)) {
        await setNairaVerified(true);
        setStage('done');
        return;
      }

      setRejection(message);
      setStage('rejected');
    } finally {
      setBusy(false);
    }
  }, [customerRef, nin, firstName, lastName, email, phone]);

  const finish = useCallback(() => {
    router.replace(returnTo);
  }, [router, returnTo]);

  const stepOfTwo = stage === 'who' ? 1 : 2;

  return (
    <SafeAreaView style={styles.screen} edges={['top', 'bottom']}>
      <KeyboardAvoidingView
        style={styles.flex}
        // 'height' on Android, matching the other naira screens. `undefined`
        // there means no avoidance at all, so the phone field — the last one on
        // the screen — sat underneath the keyboard with nothing to scroll.
        behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
        keyboardVerticalOffset={16}
      >
        <ScrollView
          contentContainerStyle={styles.body}
          keyboardShouldPersistTaps="handled"
          showsVerticalScrollIndicator={false}
        >
          {stage !== 'done' ? (
            <>
              <View style={styles.headerRow}>
                <View style={styles.flex}>
                  <FlowHeader
                    title="Verify once"
                    onBack={
                      stage === 'who'
                        ? undefined
                        : () => {
                            setNin('');
                            setStage('who');
                          }
                    }
                  />
                </View>
                <Text style={styles.stepCount}>{stepOfTwo} / 2</Text>
              </View>

              {/* Two segments, not one filling bar: there are two questions and
                  the second is the one people hesitate over. Seeing it is the
                  last one is worth the pixels. */}
              <View style={styles.segments}>
                <View style={[styles.segment, styles.segmentOn]} />
                <View style={[styles.segment, stepOfTwo === 2 && styles.segmentOn]} />
              </View>
            </>
          ) : null}

          {stage === 'who' ? (
            <View style={styles.stageBody}>
              <Text style={styles.eyebrow}>BEFORE YOUR FIRST BUY OR BILL</Text>
              <Text style={styles.title}>Tell us who you are</Text>
              <Text style={styles.lede}>
                Naira can only move to a verified person. You do this once.
              </Text>

              <View style={styles.nameRow}>
                <View style={styles.flex}>
                  <Text style={styles.label}>First name</Text>
                  <TextInput
                    style={styles.input}
                    value={firstName}
                    onChangeText={setFirstName}
                    autoCapitalize="words"
                    autoComplete="given-name"
                    returnKeyType="next"
                  />
                </View>
                <View style={styles.flex}>
                  <Text style={styles.label}>Last name</Text>
                  <TextInput
                    style={styles.input}
                    value={lastName}
                    onChangeText={setLastName}
                    autoCapitalize="words"
                    autoComplete="family-name"
                    returnKeyType="next"
                  />
                </View>
              </View>

              <View style={styles.field}>
                <Text style={styles.label}>Email</Text>
                <TextInput
                  style={styles.input}
                  value={email}
                  onChangeText={setEmail}
                  autoCapitalize="none"
                  autoComplete="email"
                  keyboardType="email-address"
                />
                <Text style={styles.help}>
                  This is the address of record for your money. Receipts and anything about a
                  stuck payment go here, so use one you check.
                </Text>
              </View>

              <View style={styles.field}>
                <Text style={styles.label}>Phone</Text>
                <TextInput
                  style={styles.input}
                  value={phone}
                  onChangeText={setPhone}
                  keyboardType="phone-pad"
                  autoComplete="tel"
                  placeholder="+234 803 512 4471"
                  placeholderTextColor={colors.textFaint}
                />
              </View>

              <Pressable
                onPress={goToNin}
                disabled={!whoReady}
                accessibilityRole="button"
                accessibilityLabel="Continue"
                style={({ pressed }) => [
                  styles.cta,
                  !whoReady && styles.ctaOff,
                  pressed && styles.pressed,
                ]}
              >
                <Text style={styles.ctaText}>Continue</Text>
              </Pressable>
            </View>
          ) : null}

          {stage === 'nin' || stage === 'rejected' ? (
            <View style={styles.stageBody}>
              <Text style={styles.eyebrow}>NATIONAL IDENTIFICATION NUMBER</Text>
              <Text style={styles.title}>Enter your NIN</Text>
              {stage === 'nin' ? (
                <Text style={styles.lede}>
                  It has to belong to {fullName || 'you'}, the name you just gave us.
                </Text>
              ) : null}

              <NinBoxes
                value={nin}
                onChange={setNin}
                inputRef={ninInput}
                colors={colors}
                styles={styles}
                error={stage === 'rejected'}
              />

              {stage === 'nin' ? (
                <>
                  <Text style={styles.help}>
                    Don’t know it? Dial *346# from the phone number linked to your NIN.
                  </Text>

                  {/* Both answers to "why are you asking", next to the field
                      rather than in a policy page. The second one is the reason
                      most people hesitate, and it is a fact about what we do,
                      not a reassurance: there is no field for a NIN on any
                      stored shape in wraith. */}
                  <View style={styles.infoCard}>
                    <View style={styles.infoRow}>
                      <InfoIcon size={16} color={colors.textMuted} />
                      <View style={styles.flex}>
                        <Text style={styles.infoTitle}>What it’s for</Text>
                        <Text style={styles.infoBody}>
                          Confirming you’re the person named on this wallet. Payment rules in
                          Nigeria require it before naira can move.
                        </Text>
                      </View>
                    </View>
                    <View style={styles.infoRow}>
                      <LockIcon size={16} color={colors.textMuted} />
                      <View style={styles.flex}>
                        <Text style={styles.infoTitle}>We don’t keep it</Text>
                        <Text style={styles.infoBody}>
                          Veil checks the number once and doesn’t store it. We save only the
                          result.
                        </Text>
                      </View>
                    </View>
                  </View>

                  <Pressable
                    onPress={() => void verify()}
                    disabled={busy || nin.length !== NIN_LENGTH}
                    accessibilityRole="button"
                    accessibilityLabel="Verify"
                    style={({ pressed }) => [
                      styles.cta,
                      (busy || nin.length !== NIN_LENGTH) && styles.ctaOff,
                      pressed && styles.pressed,
                    ]}
                  >
                    {busy ? (
                      <ActivityIndicator color={colors.onAccent} />
                    ) : (
                      <Text style={styles.ctaText}>Verify</Text>
                    )}
                  </Pressable>
                  <Text style={styles.ctaFoot}>Checked instantly. There’s no code to wait for.</Text>
                </>
              ) : null}

              {stage === 'rejected' ? (
                <>
                  {/* A rejection has to say what to do next, and the likeliest
                      cause is not a typo — it is the name. Linq matches the NIN
                      against the name given on the previous screen, so a middle
                      name or a different spelling fails a NIN that is correct. */}
                  <View style={styles.errorCard}>
                    <View style={styles.infoRow}>
                      <InfoIcon size={16} color={colors.danger} />
                      <View style={styles.flex}>
                        <Text style={styles.errorTitle}>That NIN didn’t verify</Text>
                        <Text style={styles.errorBody}>
                          Check the 11 digits first. If they’re right, the name on your NIN
                          record may not match {fullName || 'the name you gave'} — for example a
                          middle name, or a different spelling.
                        </Text>
                        {rejection ? <Text style={styles.errorDetail}>{rejection}</Text> : null}
                      </View>
                    </View>
                  </View>

                  <View style={styles.infoRow}>
                    <LockIcon size={14} color={colors.textFaint} />
                    <Text style={styles.help}>
                      Nothing was saved. Fix the number or your name and try again.
                    </Text>
                  </View>

                  <Pressable
                    onPress={() => {
                      setStage('nin');
                      setTimeout(() => ninInput.current?.focus(), 120);
                    }}
                    accessibilityRole="button"
                    accessibilityLabel="Try again"
                    style={({ pressed }) => [styles.cta, pressed && styles.pressed]}
                  >
                    <Text style={styles.ctaText}>Try again</Text>
                  </Pressable>

                  <Pressable
                    onPress={() => {
                      setNin('');
                      setStage('who');
                    }}
                    accessibilityRole="button"
                    accessibilityLabel="Edit my name"
                    style={({ pressed }) => [styles.secondary, pressed && styles.pressed]}
                  >
                    <Text style={styles.secondaryText}>Edit my name</Text>
                  </Pressable>
                </>
              ) : null}
            </View>
          ) : null}

          {stage === 'done' ? (
            <VerifiedPanel
              label={label}
              summary={summary}
              onContinue={finish}
              colors={colors}
              styles={styles}
            />
          ) : null}
        </ScrollView>
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}

/**
 * Eleven boxes over one hidden field.
 *
 * Eleven real inputs would mean eleven focus handlers, backspace that has to
 * walk backwards by hand, and a paste that fills only the first box. One field
 * with the boxes drawn from its value keeps all of that behaviour for free, and
 * a NIN pasted from a message lands correctly.
 */
function NinBoxes({
  value,
  onChange,
  inputRef,
  colors,
  styles,
  error,
}: {
  value: string;
  onChange: (v: string) => void;
  inputRef: React.RefObject<TextInput | null>;
  colors: ThemeColors;
  styles: ReturnType<typeof createStyles>;
  error?: boolean;
}) {
  const digits = Array.from({ length: NIN_LENGTH }, (_, i) => value[i] ?? '');
  return (
    <View style={styles.ninRow}>
      {digits.map((d, i) => (
        <View
          key={i}
          style={[
            styles.ninBox,
            d !== '' && styles.ninBoxFilled,
            error && styles.ninBoxError,
          ]}
        >
          <Text style={styles.ninDigit}>{d}</Text>
        </View>
      ))}
      {/* The real input, stretched over the boxes.
          It used to be a 1x1 `opacity: 0` field that a Pressable focused by
          ref, and on Android that focus simply did not happen — the boxes
          looked tappable and nothing came up. Covering the row instead means a
          tap anywhere on it IS a tap on the input, with no programmatic focus
          to fail. `color: 'transparent'` rather than `opacity: 0`, because a
          zero-opacity view is not reliably focusable. */}
      <TextInput
        ref={inputRef}
        value={value}
        onChangeText={(t) => onChange(t.replace(/\D/g, '').slice(0, NIN_LENGTH))}
        keyboardType="number-pad"
        maxLength={NIN_LENGTH}
        style={styles.ninInput}
        caretHidden
        accessibilityLabel="Enter your 11 digit NIN"
        // Never offered to a password manager or a keyboard's suggestion strip.
        autoComplete="off"
        importantForAutofill="no"
        textContentType="none"
      />
    </View>
  );
}

/** The last screen: confirmation, then straight back to what they were doing. */
function VerifiedPanel({
  label,
  summary,
  onContinue,
  colors,
  styles,
}: {
  label: string;
  summary: string;
  onContinue: () => void;
  colors: ThemeColors;
  styles: ReturnType<typeof createStyles>;
}) {
  const progress = useRef(new Animated.Value(0)).current;

  useEffect(() => {
    // Returns on its own, but the button is there for anyone who would rather
    // not wait. Nothing here is a decision, so a hold would only be ceremony.
    const anim = Animated.timing(progress, {
      toValue: 1,
      duration: 2600,
      easing: Easing.linear,
      useNativeDriver: false,
    });
    anim.start(({ finished }) => {
      if (finished) onContinue();
    });
    return () => anim.stop();
  }, [progress, onContinue]);

  const width = progress.interpolate({ inputRange: [0, 1], outputRange: ['0%', '100%'] });

  return (
    <View style={styles.donePanel}>
      <View style={styles.doneMark}>
        <CheckIcon size={26} color={colors.positive} strokeWidth={2.4} />
      </View>
      <Text style={styles.doneTitle}>You’re verified</Text>
      <Text style={styles.doneSub}>That’s the only time we’ll ask.</Text>

      <Pressable
        onPress={onContinue}
        accessibilityRole="button"
        accessibilityLabel={`Back to ${label}`}
        style={({ pressed }) => [styles.returnCard, pressed && styles.pressed]}
      >
        <Text style={styles.returnLabel}>Taking you back to</Text>
        <Text style={styles.returnTarget} numberOfLines={2}>
          {summary || label}
        </Text>
        <View style={styles.returnTrack}>
          <Animated.View style={[styles.returnFill, { width }]} />
        </View>
      </Pressable>

      <Pressable
        onPress={onContinue}
        accessibilityRole="button"
        accessibilityLabel="Continue now"
        style={({ pressed }) => [styles.cta, styles.doneCta, pressed && styles.pressed]}
      >
        <Text style={styles.ctaText}>Continue now</Text>
      </Pressable>
    </View>
  );
}

const createStyles = (colors: ThemeColors) =>
  StyleSheet.create({
    screen: { flex: 1, backgroundColor: colors.background },
    flex: { flex: 1 },
    body: {
      paddingHorizontal: 20,
      paddingTop: 16,
      // Enough that the last field clears the keyboard once it is up.
      paddingBottom: 120,
      flexGrow: 1,
    },

    headerRow: { flexDirection: 'row', alignItems: 'center' },
    stepCount: { color: colors.textFaint, fontFamily: fontFamily.body, fontSize: 12 },
    // 18 above, as the artboard has it. At 4 the line read as an underline of
    // the title rather than a separate progress indicator — `FlowHeader` adds
    // no bottom padding of its own, so this margin is the whole gap.
    segments: { flexDirection: 'row', gap: 6, marginTop: 18, marginBottom: 24 },
    segment: { flex: 1, height: 2, borderRadius: 1, backgroundColor: colors.border },
    segmentOn: { backgroundColor: colors.accent },

    stageBody: { gap: 14 },
    eyebrow: {
      color: colors.textFaint,
      fontFamily: fontFamily.accent,
      fontSize: 10,
      letterSpacing: 0.8,
    },
    title: {
      color: colors.textStrong,
      fontFamily: fontFamily.heading,
      fontSize: 24,
      marginTop: -6,
    },
    lede: { color: colors.textMuted, fontFamily: fontFamily.body, fontSize: 13.5, lineHeight: 20 },

    nameRow: { flexDirection: 'row', gap: 14, marginTop: 4 },
    field: { gap: 6 },
    label: {
      color: colors.textFaint,
      fontFamily: fontFamily.bodyMedium,
      fontSize: 12,
      marginBottom: 6,
    },
    input: {
      color: colors.textStrong,
      fontFamily: fontFamily.body,
      fontSize: 15,
      borderBottomWidth: StyleSheet.hairlineWidth,
      borderBottomColor: colors.border,
      paddingVertical: 8,
    },
    help: {
      color: colors.textFaint,
      fontFamily: fontFamily.body,
      fontSize: 11.5,
      lineHeight: 17,
      flexShrink: 1,
    },

    ninRow: { flexDirection: 'row', gap: 5, marginTop: 6, position: 'relative' },
    ninBox: {
      flex: 1,
      aspectRatio: 0.78,
      // A hairline at 10% black is almost nothing on a white screen; these are
      // the thing the screen is asking you to tap, so they have to read as
      // fields rather than as a faint ruling.
      borderWidth: 1,
      borderColor: colors.borderStrong,
      backgroundColor: colors.surfaceMd,
      borderRadius: 7,
      alignItems: 'center',
      justifyContent: 'center',
    },
    ninBoxFilled: { borderColor: colors.accent },
    ninBoxError: { borderColor: colors.danger },
    ninDigit: { color: colors.textStrong, fontFamily: fontFamily.address, fontSize: 15 },
    // Present for the keyboard, invisible on screen. Not `display: none`, which
    // would stop it taking focus at all.
    ninInput: {
      ...StyleSheet.absoluteFillObject,
      color: 'transparent',
      backgroundColor: 'transparent',
      padding: 0,
    },

    infoCard: {
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: colors.border,
      borderRadius: 14,
      padding: 14,
      gap: 12,
      marginTop: 4,
    },
    infoRow: { flexDirection: 'row', gap: 10, alignItems: 'flex-start' },
    infoTitle: { color: colors.textPrimary, fontFamily: fontFamily.bodySemiBold, fontSize: 13 },
    infoBody: {
      color: colors.textMuted,
      fontFamily: fontFamily.body,
      fontSize: 12.5,
      lineHeight: 18,
      marginTop: 2,
    },

    errorCard: {
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: colors.danger,
      borderRadius: 14,
      padding: 14,
      marginTop: 4,
    },
    errorTitle: { color: colors.danger, fontFamily: fontFamily.bodySemiBold, fontSize: 13 },
    errorBody: {
      color: colors.textMuted,
      fontFamily: fontFamily.body,
      fontSize: 12.5,
      lineHeight: 18,
      marginTop: 2,
    },
    errorDetail: {
      color: colors.textFaint,
      fontFamily: fontFamily.body,
      fontSize: 11.5,
      marginTop: 6,
    },

    cta: {
      backgroundColor: colors.accent,
      borderRadius: 999,
      paddingVertical: 14,
      alignItems: 'center',
      justifyContent: 'center',
      marginTop: 8,
    },
    ctaOff: { opacity: 0.4 },
    ctaText: { color: colors.onAccent, fontFamily: fontFamily.bodySemiBold, fontSize: 15 },
    ctaFoot: {
      color: colors.textFaint,
      fontFamily: fontFamily.body,
      fontSize: 11.5,
      textAlign: 'center',
      marginTop: -2,
    },
    secondary: { alignItems: 'center', paddingVertical: 12 },
    secondaryText: { color: colors.accent, fontFamily: fontFamily.bodySemiBold, fontSize: 13.5 },

    donePanel: { flex: 1, alignItems: 'center', justifyContent: 'center', gap: 10, paddingTop: 40 },
    doneMark: {
      width: 54,
      height: 54,
      borderRadius: 27,
      borderWidth: 1.5,
      borderColor: colors.positive,
      alignItems: 'center',
      justifyContent: 'center',
      marginBottom: 6,
    },
    doneTitle: { color: colors.textStrong, fontFamily: fontFamily.heading, fontSize: 24 },
    doneSub: { color: colors.textMuted, fontFamily: fontFamily.body, fontSize: 13.5 },
    returnCard: {
      alignSelf: 'stretch',
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: colors.border,
      borderRadius: 16,
      padding: 14,
      gap: 4,
      marginTop: 28,
    },
    returnLabel: { color: colors.textFaint, fontFamily: fontFamily.body, fontSize: 11.5 },
    returnTarget: { color: colors.textPrimary, fontFamily: fontFamily.bodyMedium, fontSize: 14 },
    returnTrack: {
      height: 2,
      borderRadius: 1,
      backgroundColor: colors.border,
      marginTop: 10,
      overflow: 'hidden',
    },
    returnFill: { height: 2, borderRadius: 1, backgroundColor: colors.accent },
    doneCta: { alignSelf: 'stretch' },

    pressed: { opacity: 0.6 },
  });
