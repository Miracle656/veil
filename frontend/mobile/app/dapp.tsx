/**
 * The in-app dApp browser shell.
 *
 * It loads exactly one thing: an origin from the allow-list in
 * `lib/dappAllowlist.ts`. There is no free-text address bar — the directory
 * (`app/dapps.tsx`) is the only way in, and it passes an allow-listed origin as
 * a route parameter.
 *
 * Security posture:
 *
 * - Only `https` is loaded. `http://` is refused even for an allow-listed host.
 * - Leaving the approved origin does not load in place. A different origin is
 *   offered to the system browser instead, and the grant never follows it.
 * - `window.open` is neutralised in the page, and a popup can never become a
 *   second in-app context that inherits the opener's permissions.
 * - The address bar always shows the origin that is actually loaded.
 * - A SEP-43 wallet provider is injected, and only into the approved origin's top
 *   frame. It exposes an address and signatures — never a key, a secret, or a
 *   credential id, because none of those ever enter the page or the message.
 * - Every signature request is shown to the user and approved there, on every
 *   call, even for an origin that already holds the signing grant. The grant
 *   means the site may ask; only the user's answer means it may sign.
 * - Every message is origin-checked again on the app side, per message, so a
 *   provider that a page somehow kept after navigating cannot answer for another.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ActivityIndicator, Pressable, StyleSheet, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { WebView } from 'react-native-webview';
import type { WebViewMessageEvent, WebViewNavigation } from 'react-native-webview';
import type { ShouldStartLoadRequest } from 'react-native-webview/lib/WebViewTypes';

import { ConfirmModal } from '../components/ConfirmModal';
import { DappApprovalModal } from '../components/DappApprovalModal';
import { NoticeModal } from '../components/NoticeModal';
import { FlowHeader } from '../components/FlowHeader';
import { useTheme } from '../hooks/useTheme';
import { openExternalUrl } from '../lib/about';
import type { PermissionPrompt, PermissionRequest } from '../lib/dappBridge';
import { handleProviderMessage, type ProviderContext } from '../lib/dappProviderBridge';
import { dappProviderScript } from '../lib/dappProvider';
import { getDappForUrl } from '../lib/dappAllowlist';
import {
  chromeOrigin,
  decideNavigation,
  decidePopup,
  parseWindowOpenMessage,
  WINDOW_OPEN_BLOCKER_JS,
} from '../lib/dappNavigation';
import { getNetwork } from '../lib/network';
import { hydrateOriginPermissions, isOriginPermissionGranted } from '../lib/permissions';
import { hasAuthEntrySigner, signAuthEntryPayload, signXdrPayload } from '../lib/walletConnect';
import { getWalletAddress } from '../lib/walletStore';
import type { ThemeColors } from '../lib/theme';
import { fontFamily } from '../theme/typography';

type PendingExternal = { origin: string; url: string };

/** One approval request waiting on the user, with the promise it answers. */
type QueuedPrompt = { request: PermissionRequest; resolve: (approved: boolean) => void };

export default function DappBrowserScreen() {
  const router = useRouter();
  const { colors } = useTheme();
  const styles = useMemo(() => createStyles(colors), [colors]);
  const params = useLocalSearchParams<{ origin?: string }>();
  const requested = typeof params.origin === 'string' ? params.origin : '';

  // The entry decides the approved origin. An unrecognised request is refused
  // outright rather than normalised into something loadable — this is the
  // allow-list gate V211 describes.
  const entry = useMemo(() => getDappForUrl(requested), [requested]);
  const approvedOrigin = entry?.origin ?? null;

  const webRef = useRef<WebView>(null);
  const [loadedUrl, setLoadedUrl] = useState<string | null>(null);
  const [pendingExternal, setPendingExternal] = useState<PendingExternal | null>(null);
  const [notice, setNotice] = useState<{ title: string; message: string } | null>(null);

  const shownOrigin = approvedOrigin ? chromeOrigin(approvedOrigin, loadedUrl) : '';

  // ── The provider ──────────────────────────────────────────────────────────

  // Grants are read from the live store in `lib/permissions.ts`, which starts
  // hydrating at import; asking again here costs nothing and covers the case
  // where this screen is the first thing the app ever opened.
  useEffect(() => {
    void hydrateOriginPermissions();
  }, []);

  // The injected script is generated once per approved origin. It carries that
  // origin inside it and declines to install anywhere else, so a document the
  // WebView lands on that is not the granted page gets no provider at all — on
  // top of the app-side check, which is the one that actually decides.
  const providerScript = useMemo(
    () => (approvedOrigin ? dappProviderScript(approvedOrigin) : ''),
    [approvedOrigin],
  );
  const injectedBeforeLoad = useMemo(
    () => `${WINDOW_OPEN_BLOCKER_JS}\n${providerScript}`,
    [providerScript],
  );

  const promptQueueRef = useRef<QueuedPrompt[]>([]);
  const [activePrompt, setActivePrompt] = useState<QueuedPrompt | null>(null);

  /**
   * Present the approval sheet and wait for the user.
   *
   * Requests are queued rather than overlapped: a second sheet replacing the one
   * the user is reading would hide a request they had not finished looking at.
   */
  const prompt = useCallback<PermissionPrompt>((request) => {
    return new Promise<boolean>((resolve) => {
      const wasEmpty = promptQueueRef.current.length === 0;
      promptQueueRef.current.push({ request, resolve });
      if (wasEmpty) setActivePrompt(promptQueueRef.current[0]);
    });
  }, []);

  const answerActivePrompt = useCallback(
    (approved: boolean) => {
      const [current, ...rest] = promptQueueRef.current;
      promptQueueRef.current = rest;
      if (!current) return;
      current.resolve(approved);
      setActivePrompt(rest[0] ?? null);
    },
    [],
  );

  /**
   * Decline everything still waiting on the user.
   *
   * Left unresolved, a `signTransaction` promise would hang in the page forever
   * and a later grant check could not tell the difference between "the user said
   * no" and "the user never asked". Navigating away and closing the screen are
   * both a no, so both answer the queue that way.
   */
  const declinePendingPrompts = useCallback(() => {
    const queued = promptQueueRef.current;
    promptQueueRef.current = [];
    for (const pending of queued) pending.resolve(false);
    setActivePrompt(null);
  }, []);

  // Leaving the screen — by back gesture, by the header, or by a route change —
  // ends every request the page had outstanding.
  useEffect(() => declinePendingPrompts, [declinePendingPrompts]);

  // A different approved origin is a different site: nothing it asks may inherit
  // a prompt the previous one left open.
  useEffect(() => {
    declinePendingPrompts();
  }, [approvedOrigin, declinePendingPrompts]);

  const providerContext = useCallback(
    (messageOrigin: string | null): ProviderContext => ({
      approvedOrigin: approvedOrigin ?? '',
      messageOrigin,
      dappName: entry?.name,
      prompt,
      isGranted: isOriginPermissionGranted,
      getAddress: getWalletAddress,
      signTransactionXdr: signXdrPayload,
      signAuthEntryXdr: signAuthEntryPayload,
      hasSigner: hasAuthEntrySigner,
      network: () => {
        const network = getNetwork();
        return {
          name: network.name,
          displayName: network.displayName,
          networkPassphrase: network.networkPassphrase,
        };
      },
    }),
    [approvedOrigin, entry?.name, prompt],
  );

  const onShouldStartLoadWithRequest = useCallback(
    (request: ShouldStartLoadRequest): boolean => {
      if (!approvedOrigin) return false;
      const decision = decideNavigation(approvedOrigin, request.url);
      if (decision.action === 'allow') return true;
      if (decision.action === 'external') {
        // Never load it in place: the grant stays with the approved origin.
        setPendingExternal({ origin: decision.origin, url: request.url });
        return false;
      }
      setNotice({
        title: 'Blocked',
        message:
          decision.reason === 'insecure'
            ? 'This dApp tried to load an insecure http:// address. Veil only browses secure origins.'
            : 'This dApp tried to navigate to an address Veil cannot open.',
      });
      return false;
    },
    [approvedOrigin],
  );

  const onNavigationStateChange = useCallback(
    (navState: WebViewNavigation) => {
      if (!approvedOrigin) return;
      // Only the approved origin may update the chrome; a blocked redirect left
      // the page where it was, so the bar must not describe the destination.
      if (decideNavigation(approvedOrigin, navState.url).action === 'allow') {
        setLoadedUrl(navState.url);
        return;
      }
      // A request from a document this page is no longer is not answerable, and
      // a sheet describing it would be a lie about what the user is looking at.
      declinePendingPrompts();
    },
    [approvedOrigin, declinePendingPrompts],
  );

  const onMessage = useCallback(
    async (event: WebViewMessageEvent) => {
      if (!approvedOrigin) return;
      const data = event.nativeEvent.data;

      const message = parseWindowOpenMessage(data);
      if (message) {
        const decision = decidePopup(approvedOrigin, message.url);
        if (decision.action === 'navigate') {
          // Fold a same-origin popup back into this view rather than opening a
          // second one that would share the opener's permissions.
          const target = message.url;
          webRef.current?.injectJavaScript(
            `window.location.href = ${JSON.stringify(target)}; true;`,
          );
          return;
        }
        if (decision.action === 'external') {
          setPendingExternal({ origin: decision.origin, url: message.url });
          return;
        }
        setNotice({
          title: 'Popup blocked',
          message: 'This dApp tried to open a window Veil cannot allow.',
        });
        return;
      }

      // The provider's own envelope. `nativeEvent.url` is the frame that posted
      // it, as the WebView reports it — passed through untouched so the bridge
      // can compare it against the approved origin rather than trusting this
      // screen to have normalised it the same way.
      const handled = await handleProviderMessage(data, providerContext(event.nativeEvent.url ?? null));
      if (handled.kind === 'ignored') return;

      // Answering is one function call with one JSON string; the bridge escapes
      // what could otherwise be evaluated as page code.
      webRef.current?.injectJavaScript(handled.javascript);
    },
    [approvedOrigin, providerContext],
  );

  const confirmExternal = useCallback(() => {
    const target = pendingExternal;
    setPendingExternal(null);
    if (target) void openExternalUrl(target.url);
  }, [pendingExternal]);

  // ── Refusal: not on the allow-list ────────────────────────────────────────
  if (!approvedOrigin) {
    return (
      <SafeAreaView style={styles.screen} edges={['top']} testID="dapp-refused">
        <View style={styles.header}>
          <FlowHeader title="Browser" />
        </View>
        <View style={styles.refusedBody}>
          <Text style={styles.refusedTitle}>Not an approved dApp</Text>
          <Text style={styles.refusedMessage}>
            Veil can only open dApps from its directory. This address is not on the list:
          </Text>
          <Text style={styles.refusedOrigin} numberOfLines={3}>
            {requested || 'No address supplied'}
          </Text>
          <Pressable
            accessibilityRole="button"
            onPress={() => router.replace('/dapps')}
            style={({ pressed }) => [styles.primary, pressed && styles.pressed]}
          >
            <Text style={styles.primaryText}>Browse the dApp directory</Text>
          </Pressable>
        </View>
      </SafeAreaView>
    );
  }

  return (
    <SafeAreaView style={styles.screen} edges={['top']} testID="dapp-browser">
      <View style={styles.header}>
        <FlowHeader title={entry?.name ?? 'Browser'} />
      </View>

      {/* The origin is shown at all times, by the app's own chrome, updating as
          the page navigates. Nothing from the page renders here. */}
      <View style={styles.originBar} testID="dapp-origin-bar">
        <Text style={styles.lock} accessibilityLabel="Secure connection">
          {'\u{1F512}'}
        </Text>
        <Text style={styles.originText} numberOfLines={1} testID="dapp-origin">
          {shownOrigin}
        </Text>
      </View>

      <WebView
        ref={webRef}
        source={{ uri: approvedOrigin }}
        style={styles.webview}
        testID="dapp-webview"
        // All navigation decisions run through onShouldStartLoadWithRequest, so
        // the whitelist must not pre-empt it by handing URLs to the OS.
        originWhitelist={['*']}
        onShouldStartLoadWithRequest={onShouldStartLoadWithRequest}
        onNavigationStateChange={onNavigationStateChange}
        onMessage={onMessage}
        // The window-open blocker runs first and the provider second: both are
        // before the page's own scripts, which is the only way a dApp's wallet
        // discovery (`window.freighterApi`) finds anything at all. After-load
        // injection is the retry for a page that probed during a navigation.
        injectedJavaScriptBeforeContentLoaded={injectedBeforeLoad}
        injectedJavaScript={injectedBeforeLoad}
        // No second in-app window may be created from page JavaScript.
        setSupportMultipleWindows={false}
        javaScriptCanOpenWindowsAutomatically={false}
        // Keep the page from reaching the app through a URL scheme.
        allowsBackForwardNavigationGestures={false}
        startInLoadingState
        renderLoading={() => (
          <View style={styles.loading}>
            <ActivityIndicator color={colors.accent} />
            <Text style={styles.loadingText}>Loading {shownOrigin}…</Text>
          </View>
        )}
        renderError={() => (
          <View style={styles.loading}>
            <Text style={styles.refusedTitle}>Could not load the page</Text>
            <Text style={styles.refusedMessage}>
              Check your connection and try again. Veil did not open anything else.
            </Text>
          </View>
        )}
      />

      <ConfirmModal
        isOpen={pendingExternal !== null}
        title="Leave this dApp?"
        message={
          pendingExternal
            ? `This link goes to ${pendingExternal.origin}, a different origin. Veil will open it in your browser, and any permission granted here stays with ${shownOrigin}.`
            : ''
        }
        confirmLabel="Open in browser"
        cancelLabel="Stay here"
        onConfirm={confirmExternal}
        onCancel={() => setPendingExternal(null)}
      />

      <NoticeModal
        isOpen={notice !== null}
        title={notice?.title ?? ''}
        message={notice?.message ?? ''}
        tone="error"
        onClose={() => setNotice(null)}
      />

      {/* The gate: a provider request that needs the user waits here for an
          answer, and the bridge signs nothing until this resolves true. */}
      <DappApprovalModal
        request={activePrompt?.request ?? null}
        networkName={getNetwork().displayName}
        onDecision={answerActivePrompt}
      />
    </SafeAreaView>
  );
}

const createStyles = (colors: ThemeColors) =>
  StyleSheet.create({
    screen: { flex: 1, backgroundColor: colors.background },
    header: { paddingHorizontal: 20, paddingTop: 16, paddingBottom: 10 },
    originBar: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: 8,
      marginHorizontal: 20,
      marginBottom: 8,
      paddingHorizontal: 12,
      paddingVertical: 9,
      borderRadius: 999,
      backgroundColor: colors.surfaceMd,
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: colors.border,
    },
    lock: { fontSize: 12 },
    originText: {
      flex: 1,
      color: colors.textSecondary,
      fontFamily: fontFamily.address,
      fontSize: 13,
    },
    webview: { flex: 1, backgroundColor: colors.background },
    loading: {
      flex: 1,
      alignItems: 'center',
      justifyContent: 'center',
      gap: 12,
      padding: 32,
      backgroundColor: colors.background,
    },
    loadingText: { color: colors.textMuted, fontFamily: fontFamily.body, fontSize: 13 },
    refusedBody: { flex: 1, padding: 24, gap: 12, justifyContent: 'center' },
    refusedTitle: { color: colors.textStrong, fontFamily: fontFamily.heading, fontSize: 24 },
    refusedMessage: {
      color: colors.textMuted,
      fontFamily: fontFamily.body,
      fontSize: 14,
      lineHeight: 20,
    },
    refusedOrigin: {
      color: colors.textPrimary,
      fontFamily: fontFamily.address,
      fontSize: 14,
      backgroundColor: colors.surfaceMd,
      borderRadius: 12,
      padding: 12,
    },
    primary: {
      marginTop: 8,
      alignItems: 'center',
      paddingVertical: 14,
      borderRadius: 100,
      backgroundColor: colors.accent,
    },
    primaryText: { color: colors.onAccent, fontFamily: fontFamily.bodySemiBold, fontSize: 15 },
    pressed: { opacity: 0.7 },
  });
