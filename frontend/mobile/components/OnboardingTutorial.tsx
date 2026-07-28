/**
 * First-run onboarding tutorial for Veil Mobile.
 *
 * Ported from `frontend/wallet/components/OnboardingTutorial.tsx`.
 *
 * - Shows a full-screen overlay with step-by-step coach marks.
 * - Dismiss persists across sessions (parent stores dismissal).
 * - Exposes `__e2eSkipTutorial` so e2e tests can bypass the overlay.
 *
 * Acceptance:
 *   - Tutorial shows once
 *   - Dismiss persists
 *   - Skip flag available for tests
 */

import React, { useCallback, useRef, useState } from 'react';
import {
  Animated,
  Modal,
  Pressable,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import { colors, radii, spacing } from '../constants/theme';
import { fonts } from '../constants/typography';

// ── E2E skip flag ─────────────────────────────────────────────────────────
//
// Tests can set this to `true` BEFORE mounting the component to suppress the
// tutorial overlay entirely (mirrors the web approach where tests set
// `localStorage.setItem('veil_seen_tutorial', '1')` via `page.addInitScript`).
//
// When `true`, `OnboardingTutorial` renders `null`.
export let __e2eSkipTutorial = false;

/**
 * Allow e2e tests to bypass the tutorial.
 * Call once before rendering, e.g. in test setup or `page.addInitScript`.
 */
export function setE2eSkipTutorial(skip: boolean): void {
  __e2eSkipTutorial = skip;
}

// ── Step data ─────────────────────────────────────────────────────────────

interface Step {
  title: string;
  description: string;
  icon: React.ReactNode;
}

const STEPS: Step[] = [
  {
    title: 'No seed phrase',
    description:
      "Veil uses your device's biometrics as your key. No seed phrase, no private key file — just your fingerprint or Face ID.",
    icon: <KeyholeIcon />,
  },
  {
    title: 'Your passkey, your wallet',
    description:
      'When you create a wallet, your device registers a passkey. The cryptographic public key is stored on-chain. Only your device can sign.',
    icon: <ShieldIcon />,
  },
  {
    title: 'Ready to start',
    description:
      'Tap Create wallet to register your passkey and deploy your wallet on Stellar. It takes about 10 seconds.',
    icon: <WandIcon />,
  },
];

// ── Inline icons (no external SVG library) ────────────────────────────────

/** Keyhole / fingerprint icon — inner circle + outer arc. */
function KeyholeIcon() {
  return (
    <View style={iconStyles.container}>
      <View style={iconStyles.outerRing} />
      <View style={iconStyles.innerCircle} />
      <View style={iconStyles.keyStem} />
      <View style={iconStyles.keyBit} />
    </View>
  );
}

/** Shield / lock icon — rounded rect with a lock bar. */
function ShieldIcon() {
  return (
    <View style={iconStyles.container}>
      <View style={iconStyles.shieldBody} />
      <View style={iconStyles.shieldArc} />
      <View style={iconStyles.lockBar} />
    </View>
  );
}

/** Wand / magic icon — star + stick. */
function WandIcon() {
  return (
    <View style={iconStyles.container}>
      <View style={iconStyles.wandStick} />
      <View style={iconStyles.starCenter} />
      {[0, 1, 2, 3].map((i) => (
        <View
          key={i}
          style={[
            iconStyles.starPoint,
            { transform: [{ rotate: `${i * 90}deg` }] },
          ]}
        />
      ))}
    </View>
  );
}

const ICON_SIZE = 48;
const iconStyles = StyleSheet.create({
  container: {
    width: ICON_SIZE,
    height: ICON_SIZE,
    alignItems: 'center',
    justifyContent: 'center',
  },
  // Keyhole
  outerRing: {
    position: 'absolute',
    width: 30,
    height: 30,
    borderRadius: 15,
    borderWidth: 2.5,
    borderColor: colors.gold,
    top: 4,
  },
  innerCircle: {
    position: 'absolute',
    width: 12,
    height: 12,
    borderRadius: 6,
    backgroundColor: colors.gold,
    top: 9,
  },
  keyStem: {
    position: 'absolute',
    width: 2.5,
    height: 14,
    backgroundColor: colors.gold,
    top: 20,
    left: 23,
  },
  keyBit: {
    position: 'absolute',
    width: 2.5,
    height: 5,
    backgroundColor: colors.gold,
    top: 24,
    left: 26,
  },
  // Shield
  shieldBody: {
    position: 'absolute',
    width: 34,
    height: 34,
    borderRadius: 6,
    borderWidth: 2.5,
    borderColor: colors.gold,
  },
  shieldArc: {
    position: 'absolute',
    width: 34,
    height: 18,
    borderBottomLeftRadius: 17,
    borderBottomRightRadius: 17,
    borderWidth: 2.5,
    borderColor: colors.gold,
    backgroundColor: 'transparent',
    top: 16,
  },
  lockBar: {
    position: 'absolute',
    width: 14,
    height: 2.5,
    backgroundColor: colors.gold,
    top: 18,
    left: 10,
    borderRadius: 1,
  },
  // Wand
  wandStick: {
    position: 'absolute',
    width: 2.5,
    height: 32,
    backgroundColor: colors.gold,
    borderRadius: 1.25,
    bottom: 2,
    right: 8,
    transform: [{ rotate: '-20deg' }],
  },
  starCenter: {
    position: 'absolute',
    width: 10,
    height: 10,
    borderRadius: 5,
    backgroundColor: colors.gold,
    top: 8,
    left: 12,
  },
  starPoint: {
    position: 'absolute',
    width: 2.5,
    height: 10,
    backgroundColor: colors.gold,
    borderRadius: 1.25,
    top: 7,
    left: 22.75,
  },
});

// ── Component ─────────────────────────────────────────────────────────────

interface OnboardingTutorialProps {
  onComplete: () => void;
}

export function OnboardingTutorial({ onComplete }: OnboardingTutorialProps) {
  const [step, setStep] = useState(0);
  const fadeAnim = useRef(new Animated.Value(1)).current;
  const slideAnim = useRef(new Animated.Value(0)).current;
  const [animating, setAnimating] = useState(false);

  // Skip rendering entirely when the e2e flag is set.
  if (__e2eSkipTutorial) {
    return null;
  }

  const isLastStep = step === STEPS.length - 1;

  const animateToStep = useCallback(
    (nextStep: number) => {
      if (animating) return;
      setAnimating(true);

      Animated.parallel([
        Animated.timing(fadeAnim, {
          toValue: 0,
          duration: 200,
          useNativeDriver: true,
        }),
        Animated.timing(slideAnim, {
          toValue: 20,
          duration: 200,
          useNativeDriver: true,
        }),
      ]).start(() => {
        setStep(nextStep);
        slideAnim.setValue(-20);

        Animated.parallel([
          Animated.timing(fadeAnim, {
            toValue: 1,
            duration: 300,
            useNativeDriver: true,
          }),
          Animated.timing(slideAnim, {
            toValue: 0,
            duration: 300,
            useNativeDriver: true,
          }),
        ]).start(() => {
          setAnimating(false);
        });
      });
    },
    [animating, fadeAnim, slideAnim],
  );

  const handleNext = useCallback(() => {
    if (isLastStep) {
      onComplete();
    } else {
      animateToStep(step + 1);
    }
  }, [isLastStep, onComplete, animateToStep, step]);

  const handleSkip = useCallback(() => {
    onComplete();
  }, [onComplete]);

  return (
    <Modal
      visible
      transparent={false}
      animationType="fade"
      statusBarTranslucent
      onRequestClose={handleSkip}
    >
      <View style={styles.overlay}>
        <Animated.View
          style={[
            styles.content,
            {
              opacity: fadeAnim,
              transform: [{ translateY: slideAnim }],
            },
          ]}
        >
          {/* Icon */}
          <View style={styles.iconWrapper}>{STEPS[step].icon}</View>

          {/* Title */}
          <Text
            style={styles.title}
            accessibilityRole="header"
            accessibilityLabel={STEPS[step].title}
          >
            {STEPS[step].title}
          </Text>

          {/* Description */}
          <Text style={styles.description}>{STEPS[step].description}</Text>

          {/* Step dots */}
          <View style={styles.dotsRow}>
            {STEPS.map((_, i) => (
              <View
                key={i}
                style={[
                  styles.dot,
                  { backgroundColor: i === step ? colors.gold : 'rgba(246,247,248,0.2)' },
                ]}
              />
            ))}
          </View>

          {/* Buttons */}
          <View style={styles.buttonsContainer}>
            <Pressable style={styles.primaryButton} onPress={handleNext}>
              <Text style={styles.primaryButtonText}>
                {isLastStep ? 'Get started' : 'Next'}
              </Text>
            </Pressable>

            {!isLastStep && (
              <Pressable style={styles.skipButton} onPress={handleSkip}>
                <Text style={styles.skipButtonText}>Skip</Text>
              </Pressable>
            )}
          </View>
        </Animated.View>
      </View>
    </Modal>
  );
}

// ── Styles ────────────────────────────────────────────────────────────────

const styles = StyleSheet.create({
  overlay: {
    flex: 1,
    backgroundColor: colors.nearBlack,
    alignItems: 'center',
    justifyContent: 'center',
    padding: spacing.lg * 2,
  },
  content: {
    maxWidth: 400,
    width: '100%',
    alignItems: 'center',
    gap: spacing.lg + spacing.sm,
  },
  iconWrapper: {
    marginBottom: spacing.md,
  },
  title: {
    fontFamily: fonts.lora,
    fontStyle: 'italic',
    fontWeight: '600',
    fontSize: 28,
    color: '#D4D4D4',
    textAlign: 'center',
  },
  description: {
    fontFamily: fonts.inter,
    fontSize: 16,
    lineHeight: 26,
    color: 'rgba(246,247,248,0.6)',
    textAlign: 'center',
  },
  dotsRow: {
    flexDirection: 'row',
    gap: 12,
    marginTop: spacing.sm,
  },
  dot: {
    width: 8,
    height: 8,
    borderRadius: 4,
  },
  buttonsContainer: {
    width: '100%',
    marginTop: spacing.xl,
    gap: 12,
  },
  primaryButton: {
    backgroundColor: '#C9A227',
    paddingVertical: 14,
    borderRadius: radii.full,
    alignItems: 'center',
    justifyContent: 'center',
  },
  primaryButtonText: {
    color: '#111111',
    fontFamily: fonts.inter,
    fontWeight: '600',
    fontSize: 15,
  },
  skipButton: {
    paddingVertical: 12,
    borderRadius: radii.full,
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.08)',
  },
  skipButtonText: {
    color: '#A0A0A0',
    fontFamily: fonts.inter,
    fontWeight: '500',
    fontSize: 14,
  },
});
