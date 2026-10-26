/**
 * The app's global error boundary (#442).
 *
 * A render error anywhere under it swaps the tree for a fallback instead of
 * the white screen React Native shows by default — and the wallet is
 * untouched by such an error: nothing here is near a signing path, so the
 * fallback can say that plainly. The error is reported to Sentry when (and
 * only when) crash reporting is live (`lib/sentry.ts`); with reporting off,
 * this component is the whole of #442's fix.
 *
 * It wraps the navigator in `app/_layout.tsx`, so it catches errors from
 * screens *and* from the providers around them.
 */

import { Component, type ReactNode } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';

import { captureMobileError } from '../lib/sentry';
import { colors as palette } from '../theme/colors';
import { fontFamily } from '../theme/typography';

type ErrorBoundaryProps = { children: ReactNode };
type ErrorBoundaryState = { error: Error | null };

export class ErrorBoundary extends Component<ErrorBoundaryProps, ErrorBoundaryState> {
  state: ErrorBoundaryState = { error: null };

  static getDerivedStateFromError(error: Error): ErrorBoundaryState {
    return { error };
  }

  componentDidCatch(error: Error): void {
    captureMobileError(error);
  }

  private readonly reset = () => {
    this.setState({ error: null });
  };

  render(): ReactNode {
    const { error } = this.state;
    if (!error) return this.props.children;

    return (
      <View style={styles.root} testID="error-boundary-fallback" accessibilityRole="alert">
        <Text style={styles.title}>Something went wrong</Text>
        <Text style={styles.body}>
          The app hit an unexpected error. Your wallet is untouched — nothing was signed or sent.
          Try again, and if it keeps happening, reopen the app.
        </Text>
        <Text style={styles.detail} testID="error-boundary-message">
          {error.message}
        </Text>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Try again"
          onPress={this.reset}
          style={styles.button}
          testID="error-boundary-retry"
        >
          <Text style={styles.buttonText}>Try again</Text>
        </Pressable>
      </View>
    );
  }
}

/**
 * Static palette, not `useTheme()`: this is a class component (an error
 * boundary has to be), and it has to render before any provider it might be
 * wrapping. The fallback is legible in both themes as these values stand.
 */
const styles = StyleSheet.create({
  root: {
    flex: 1,
    backgroundColor: palette.nearBlack,
    alignItems: 'center',
    justifyContent: 'center',
    gap: 14,
    paddingHorizontal: 28,
  },
  title: {
    color: palette.offWhite,
    fontFamily: fontFamily.heading,
    fontSize: 22,
    textAlign: 'center',
  },
  body: {
    color: palette.textMuted,
    fontFamily: fontFamily.body,
    fontSize: 14,
    lineHeight: 21,
    textAlign: 'center',
  },
  detail: {
    color: palette.textMuted,
    fontFamily: fontFamily.address,
    fontSize: 12,
    textAlign: 'center',
  },
  button: {
    marginTop: 8,
    backgroundColor: palette.goldFill,
    borderRadius: 14,
    paddingHorizontal: 24,
    paddingVertical: 12,
  },
  buttonText: {
    color: palette.nearBlack,
    fontFamily: fontFamily.bodySemiBold,
    fontSize: 15,
  },
});
