import '../lib/polyfills';

import { Horizon, Keypair, TransactionBuilder, type Transaction } from '@stellar/stellar-sdk';
import { useCallback, useEffect, useRef, useState } from 'react';
/**
 * Veil agent chat — the mobile port of the web wallet's `app/agent/page.tsx`.
 *
 * Same server, same protocol (`packages/agent`), same three-step onboarding and
 * role-aware suggestions. What differs is everything the phone forces:
 *
 *   - The transport lives in `lib/agentSocket.ts` and reconnects with backoff,
 *     because a mobile socket dies routinely — backgrounding the app is enough.
 *     The screen shows connection state instead of pretending it is always up.
 *   - A message typed while the socket is down is queued rather than dropped,
 *     so the reply arrives late rather than never.
 *   - The web page renders agent markdown with `dangerouslySetInnerHTML`. React
 *     Native has no innerHTML, so `renderInline` below turns the same `**bold**`
 *     and `` `code` `` markers into nested `<Text>` runs — which also means
 *     model output is never interpreted as markup.
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

import { Button, Card, Screen } from '../components/ui';
import {
  describeSubmissionError,
  isProposalForFeePayer,
  nextMessageId,
  parseAgentServerEvent,
  parseInlineMarkup,
  reviewProposedTransaction,
  shortenAddress,
  type AgentMessage,
  type ProposalReview,
  type ProposalStatus,
} from '../lib/agentMessages';
import { getNetwork } from '../lib/network';
import { signPayloadWithPasskey } from '../lib/passkey';
import { getSignerSecret, getWalletAddress } from '../lib/walletStore';
import { colors } from '../theme/colors';
import { fontFamily, typography } from '../theme/typography';

/**
 * Agent chat (`/agent`) — the assistant can read, explain, and *propose*, but it
 * cannot move funds.
 *
 * Every transaction the agent builds arrives as a proposal: decoded here from its
 * XDR, shown as what it will actually do, and left unsigned until the user taps
 * confirm and clears the device passkey prompt. The prompt is over this
 * transaction's own hash, so the biometric the user gives is bound to the
 * transaction on screen rather than to a generic "are you there" challenge. A
 * declined prompt leaves the proposal unsigned and the funds where they were.
 *
 * Ported from `frontend/wallet/app/agent/page.tsx`. The socket wiring below is
 * deliberately minimal — the durable client, history and reconnect policy belong
 * in `lib/agentSocket.ts` (backlog #65).
 */

const network = getNetwork();

const SUGGESTIONS = [
  "What's my balance?",
  'Swap 100 XLM to USDC',
  'Show recent transfers',
  'Best XLM/USDC rate?',
];

export default function AgentScreen() {
  const [messages, setMessages] = useState<AgentMessage[]>([
    {
      id: nextMessageId('greeting'),
      kind: 'agent',
      text: "I'm your Veil agent. I can check prices, read your transfer history, and prepare swaps and payments. Anything that moves funds needs your passkey — I can't sign for you.",
    },
  ]);
  const [input, setInput] = useState('');
  const [isThinking, setIsThinking] = useState(false);
  const [isConnected, setIsConnected] = useState(false);
  const [walletAddress, setWalletAddress] = useState<string | null>(null);
  const [feePayerAddress, setFeePayerAddress] = useState<string | null>(null);

  const socketRef = useRef<WebSocket | null>(null);
  const reconnectRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const closedByUsRef = useRef(false);
  const scrollRef = useRef<ScrollView | null>(null);

  const appendMessage = useCallback((message: AgentMessage) => {
    setMessages((current) => [...current, message]);
  }, []);

  const updateProposal = useCallback((id: string, status: ProposalStatus) => {
    setMessages((current) =>
      current.map((message) =>
        message.id === id && message.kind === 'proposal' ? { ...message, status } : message
      )
    );
  }, []);

  // The fee payer is derived from the secret rather than read from a cached
  // public key, which can be stale and produce a source/signer mismatch.
  useEffect(() => {
    let active = true;
    (async () => {
      const [address, secret] = await Promise.all([getWalletAddress(), getSignerSecret()]);
      if (!active) return;
      setWalletAddress(address);
      if (!secret) return;
      try {
        setFeePayerAddress(Keypair.fromSecret(secret).publicKey());
      } catch {
        setFeePayerAddress(null);
      }
    })().catch(() => undefined);
    return () => {
      active = false;
    };
  }, []);

  const handleEvent = useCallback(
    (raw: string) => {
      const event = parseAgentServerEvent(raw);
      if (!event) return;

      switch (event.type) {
        case 'thinking':
          setIsThinking(true);
          return;

        case 'error':
          setIsThinking(false);
          appendMessage({
            id: nextMessageId('error'),
            kind: 'error',
            text: event.message,
          });
          return;

        case 'history_cleared':
          appendMessage({
            id: nextMessageId('notice'),
            kind: 'notice',
            text: 'Conversation history cleared on the agent.',
          });
          return;

        case 'response': {
          setIsThinking(false);

          if (!event.pendingTxXdr) {
            appendMessage({ id: nextMessageId('agent'), kind: 'agent', text: event.message });
            return;
          }

          // Decode the transaction before it is ever shown as approvable: a
          // proposal we cannot read is presented as one to reject, not to trust.
          let review: ProposalReview | null = null;
          let reviewError: string | null = null;
          try {
            review = reviewProposedTransaction(event.pendingTxXdr, network.networkPassphrase);
          } catch (error) {
            reviewError =
              error instanceof Error
                ? error.message
                : 'This transaction could not be decoded on this device.';
          }

          appendMessage({
            id: nextMessageId('proposal'),
            kind: 'proposal',
            text: event.message,
            claim: event.pendingTxSummary ?? null,
            xdr: event.pendingTxXdr,
            review,
            reviewError,
            status: { state: 'awaiting' },
          });
          return;
        }
      }
    },
    [appendMessage]
  );

  const connect = useCallback(() => {
    const url = process.env['EXPO_PUBLIC_AGENT_WS_URL']?.trim() || 'ws://localhost:3001';
    const socket = new WebSocket(url);
    socketRef.current = socket;

    socket.onopen = () => setIsConnected(true);
    socket.onmessage = (event) => handleEvent(String(event.data));
    socket.onclose = () => {
      setIsConnected(false);
      setIsThinking(false);
      if (closedByUsRef.current) return;
      reconnectRef.current = setTimeout(connect, 2_000);
    };
  }, [handleEvent]);

  useEffect(() => {
    closedByUsRef.current = false;
    connect();
    return () => {
      closedByUsRef.current = true;
      if (reconnectRef.current) clearTimeout(reconnectRef.current);
      socketRef.current?.close();
    };
  }, [connect]);

  function handleSend() {
    const text = input.trim();
    const socket = socketRef.current;
    if (!text || isThinking) return;

    appendMessage({ id: nextMessageId('user'), kind: 'user', text });
    setInput('');

    if (!socket || socket.readyState !== WebSocket.OPEN) {
      appendMessage({
        id: nextMessageId('error'),
        kind: 'error',
        text: 'Not connected to the agent yet. It will retry automatically — send again in a moment.',
      });
      return;
    }

    if (!walletAddress) {
      appendMessage({
        id: nextMessageId('error'),
        kind: 'error',
        text: 'No wallet on this device yet, so there is nothing for the agent to act on.',
      });
      return;
    }

    socket.send(
      JSON.stringify({
        type: 'chat',
        walletAddress,
        feePayerAddress: feePayerAddress ?? undefined,
        message: text,
      })
    );
  }

  function handleClearHistory() {
    const socket = socketRef.current;
    if (!walletAddress || !socket || socket.readyState !== WebSocket.OPEN) return;
    socket.send(JSON.stringify({ type: 'clear_history', walletAddress }));
  }

  /**
   * Approve a proposed transaction.
   *
   * The order matters: check what the transaction is, get the passkey over its
   * hash, and only then reach for the fee-payer key. Nothing is signed before the
   * user has cleared the prompt, and a dismissed prompt is a decline rather than
   * a failure.
   */
  async function handleConfirm(message: Extract<AgentMessage, { kind: 'proposal' }>) {
    if (message.status.state !== 'awaiting') return;

    const { review } = message;
    if (!review) {
      updateProposal(message.id, {
        state: 'failed',
        reason: 'This transaction could not be decoded, so it cannot be approved here.',
      });
      return;
    }

    if (!isProposalForFeePayer(review, feePayerAddress)) {
      updateProposal(message.id, {
        state: 'failed',
        reason: `This transaction is sourced from ${shortenAddress(review.source)}, which is not this wallet's fee payer. Nothing was signed.`,
      });
      return;
    }

    updateProposal(message.id, { state: 'confirming' });

    let tx: Transaction;
    try {
      tx = TransactionBuilder.fromXDR(message.xdr, network.networkPassphrase) as Transaction;
    } catch (error) {
      updateProposal(message.id, { state: 'failed', reason: describeSubmissionError(error) });
      return;
    }

    try {
      // The passkey is prompted over this transaction's own hash, so the
      // assertion the authenticator produces is bound to the transaction on
      // screen. The network never sees it — these are classic operations
      // authorised by the fee-payer signature — but it is what stands between
      // the agent's proposal and the fee-payer key held on this device, and
      // binding it to the hash means a stale confirmation cannot be reused for a
      // different transaction.
      const confirmation = await signPayloadWithPasskey(new Uint8Array(tx.hash()));
      if (!confirmation) {
        updateProposal(message.id, { state: 'declined' });
        return;
      }

      const secret = await getSignerSecret();
      if (!secret) {
        updateProposal(message.id, {
          state: 'failed',
          reason: 'The signing key for this wallet is missing from this device.',
        });
        return;
      }

      tx.sign(Keypair.fromSecret(secret));
      const result = await new Horizon.Server(network.horizonUrl).submitTransaction(tx);
      updateProposal(message.id, { state: 'submitted', hash: result.hash });
    } catch (error) {
      updateProposal(message.id, { state: 'failed', reason: describeSubmissionError(error) });
    }
  }

  return (
    <Screen>
      <KeyboardAvoidingView
        style={styles.flex}
        behavior={Platform.OS === 'ios' ? 'padding' : undefined}
      >
        <View style={styles.header}>
          <View style={styles.headerText}>
            <Text style={[typography.heading, styles.title]}>Veil agent</Text>
            <Text style={styles.status}>
              {isConnected ? 'Connected' : 'Connecting…'} · it can propose, only you can sign
            </Text>
          </View>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Clear conversation history"
            onPress={handleClearHistory}
            style={styles.clear}
          >
            <Text style={styles.clearText}>Clear</Text>
          </Pressable>
        </View>

        <ScrollView
          ref={scrollRef}
          contentContainerStyle={styles.thread}
          onContentSizeChange={() => scrollRef.current?.scrollToEnd({ animated: true })}
          keyboardShouldPersistTaps="handled"
        >
          {messages.map((message) => (
            <MessageRow
              key={message.id}
              message={message}
              onConfirm={handleConfirm}
              onDecline={updateProposal}
            />
          ))}

          {isThinking && (
            <View style={styles.thinking}>
              <ActivityIndicator color={colors.gold} size="small" />
              <Text style={styles.thinkingText}>Thinking…</Text>
            </View>
          )}
        </ScrollView>

        <View style={styles.composer}>
          <ScrollView horizontal showsHorizontalScrollIndicator={false} style={styles.chips}>
            {SUGGESTIONS.map((suggestion) => (
              <Pressable
                key={suggestion}
                accessibilityRole="button"
                onPress={() => setInput(suggestion)}
                style={styles.chip}
              >
                <Text style={styles.chipText}>{suggestion}</Text>
              </Pressable>
            ))}
          </ScrollView>

          <View style={styles.inputRow}>
            <TextInput
              style={styles.input}
              placeholder="Ask about balances, rates, or a payment"
              placeholderTextColor="rgba(246,247,248,0.3)"
              value={input}
              onChangeText={setInput}
              onSubmitEditing={handleSend}
              editable={!isThinking}
              returnKeyType="send"
              multiline
            />
            <Pressable
              accessibilityRole="button"
              accessibilityLabel="Send message"
              onPress={handleSend}
              disabled={!input.trim() || isThinking}
              style={({ pressed }) => [
                styles.send,
                (!input.trim() || isThinking) && styles.sendDisabled,
                pressed && styles.sendPressed,
              ]}
            >
              <Text style={styles.sendLabel}>Send</Text>
            </Pressable>
          </View>
        </View>
      </KeyboardAvoidingView>
    </Screen>
  );
}

// ── Message rendering ────────────────────────────────────────────────────────

function MessageRow({
  message,
  onConfirm,
  onDecline,
}: {
  message: AgentMessage;
  onConfirm: (message: Extract<AgentMessage, { kind: 'proposal' }>) => void;
  onDecline: (id: string, status: ProposalStatus) => void;
}) {
  switch (message.kind) {
    case 'user':
      return (
        <View style={[styles.row, styles.rowRight]}>
          <View style={[styles.bubble, styles.bubbleUser]}>
            <Text style={styles.bubbleText}>{message.text}</Text>
          </View>
        </View>
      );

    case 'notice':
      return <Text style={styles.notice}>{message.text}</Text>;

    case 'error':
      return (
        <View style={styles.row}>
          <View style={[styles.bubble, styles.bubbleError]}>
            <Text style={styles.errorLabel}>SOMETHING WENT WRONG</Text>
            <Text style={styles.errorText}>{message.text}</Text>
          </View>
        </View>
      );

    case 'agent':
      return (
        <View style={styles.row}>
          <View style={[styles.bubble, styles.bubbleAgent]}>
            <RichText text={message.text} />
          </View>
        </View>
      );

    case 'proposal':
      return (
        <View style={styles.row}>
          <View style={[styles.bubble, styles.bubbleAgent]}>
            <RichText text={message.text} />
            <ProposalCard message={message} onConfirm={onConfirm} onDecline={onDecline} />
          </View>
        </View>
      );
  }
}

/** Agent prose with `**bold**` and `` `code` `` rendered as text, never as markup. */
function RichText({ text }: { text: string }) {
  return (
    <Text style={styles.bubbleText}>
      {parseInlineMarkup(text).map((segment, index) => (
        <Text
          key={`${index}-${segment.style}`}
          style={
            segment.style === 'strong'
              ? styles.strong
              : segment.style === 'code'
                ? styles.code
                : undefined
          }
        >
          {segment.text}
        </Text>
      ))}
    </Text>
  );
}

/**
 * The gate on an agent-proposed action.
 *
 * What the transaction does is stated from the decoded XDR; the agent's own
 * summary sits underneath it, labelled as the agent's words, so the two can be
 * compared rather than conflated.
 */
function ProposalCard({
  message,
  onConfirm,
  onDecline,
}: {
  message: Extract<AgentMessage, { kind: 'proposal' }>;
  onConfirm: (message: Extract<AgentMessage, { kind: 'proposal' }>) => void;
  onDecline: (id: string, status: ProposalStatus) => void;
}) {
  const { review, status } = message;

  return (
    <Card variant="md" style={styles.proposal}>
      <Text style={styles.proposalLabel}>APPROVAL NEEDED</Text>

      {review ? (
        <>
          {review.operations.map((operation, index) => (
            <Text key={`${index}-${operation}`} style={styles.proposalOperation}>
              {operation}
            </Text>
          ))}
          <Text style={styles.proposalDetail}>From {shortenAddress(review.source)}</Text>
          <Text style={styles.proposalDetail}>
            Fee {review.fee} stroops · {network.displayName}
          </Text>
          {review.memo && <Text style={styles.proposalDetail}>Memo {review.memo}</Text>}
          {review.hasUnknownOperation && (
            <Text style={styles.proposalWarning}>
              This transaction contains an operation this app cannot describe. Review it carefully
              before approving.
            </Text>
          )}
        </>
      ) : (
        <Text style={styles.proposalWarning}>
          {message.reviewError ?? 'This transaction could not be decoded on this device.'}
        </Text>
      )}

      {message.claim && (
        <Text style={styles.proposalClaim}>The agent says: {message.claim}</Text>
      )}

      {status.state === 'awaiting' && (
        <View style={styles.proposalActions}>
          <Button
            label="Confirm with passkey"
            onPress={() => onConfirm(message)}
            disabled={!review}
          />
          <Button
            label="Decline"
            variant="ghost"
            onPress={() => onDecline(message.id, { state: 'declined' })}
          />
        </View>
      )}

      {status.state === 'confirming' && (
        <View style={styles.thinking}>
          <ActivityIndicator color={colors.gold} size="small" />
          <Text style={styles.thinkingText}>Waiting for your passkey…</Text>
        </View>
      )}

      {status.state === 'submitted' && (
        <>
          <Text style={styles.proposalDone}>Submitted</Text>
          <Text style={styles.proposalHash}>{status.hash}</Text>
        </>
      )}

      {status.state === 'declined' && (
        <Text style={styles.proposalDetail}>Declined. Nothing was signed or sent.</Text>
      )}

      {status.state === 'failed' && <Text style={styles.errorText}>{status.reason}</Text>}
    </Card>
  );
}

const styles = StyleSheet.create({
  flex: {
    flex: 1,
  },
  header: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: 12,
    paddingTop: 16,
    paddingBottom: 12,
  },
  headerText: {
    flex: 1,
    gap: 2,
  },
  title: {
    color: colors.offWhite,
    fontSize: 24,
  },
  status: {
    fontFamily: fontFamily.body,
    fontSize: 12,
    color: colors.textMuted,
  },
  clear: {
    paddingVertical: 6,
    paddingHorizontal: 10,
  },
  clearText: {
    fontFamily: fontFamily.bodyMedium,
    fontSize: 13,
    color: colors.textMuted,
  },
  thread: {
    gap: 12,
    paddingBottom: 16,
  },
  row: {
    flexDirection: 'row',
    justifyContent: 'flex-start',
  },
  rowRight: {
    justifyContent: 'flex-end',
  },
  bubble: {
    maxWidth: '86%',
    borderRadius: 18,
    borderWidth: 1,
    paddingVertical: 12,
    paddingHorizontal: 14,
    gap: 10,
  },
  bubbleUser: {
    backgroundColor: colors.goldSoft,
    borderColor: colors.goldBorder,
    borderBottomRightRadius: 4,
  },
  bubbleAgent: {
    backgroundColor: colors.surfaceMd,
    borderColor: colors.borderDim,
    borderBottomLeftRadius: 4,
  },
  bubbleError: {
    backgroundColor: 'rgba(248,113,113,0.08)',
    borderColor: 'rgba(248,113,113,0.3)',
    borderBottomLeftRadius: 4,
  },
  bubbleText: {
    fontFamily: fontFamily.body,
    fontSize: 14,
    lineHeight: 21,
    color: colors.offWhite,
  },
  strong: {
    fontFamily: fontFamily.bodySemiBold,
  },
  code: {
    fontFamily: fontFamily.address,
    fontSize: 13,
    color: colors.warmGrey,
  },
  notice: {
    fontFamily: fontFamily.body,
    fontSize: 12,
    color: colors.textMuted,
    textAlign: 'center',
  },
  errorLabel: {
    fontFamily: fontFamily.accent,
    fontSize: 11,
    letterSpacing: 1,
    color: '#f87171',
  },
  errorText: {
    fontFamily: fontFamily.body,
    fontSize: 13,
    lineHeight: 19,
    color: '#f87171',
  },
  proposal: {
    padding: 14,
    gap: 8,
  },
  proposalLabel: {
    fontFamily: fontFamily.accent,
    fontSize: 11,
    letterSpacing: 1,
    color: colors.gold,
  },
  proposalOperation: {
    fontFamily: fontFamily.bodyMedium,
    fontSize: 14,
    lineHeight: 20,
    color: colors.offWhite,
  },
  proposalDetail: {
    fontFamily: fontFamily.body,
    fontSize: 12,
    lineHeight: 18,
    color: colors.textMuted,
  },
  proposalClaim: {
    fontFamily: fontFamily.body,
    fontSize: 12,
    lineHeight: 18,
    fontStyle: 'italic',
    color: 'rgba(246,247,248,0.4)',
  },
  proposalWarning: {
    fontFamily: fontFamily.body,
    fontSize: 12,
    lineHeight: 18,
    color: '#fbbf24',
  },
  proposalActions: {
    gap: 8,
    marginTop: 4,
  },
  proposalDone: {
    fontFamily: fontFamily.bodyMedium,
    fontSize: 13,
    color: colors.teal,
  },
  proposalHash: {
    fontFamily: fontFamily.address,
    fontSize: 11,
    color: colors.textMuted,
  },
  thinking: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
  },
  thinkingText: {
    fontFamily: fontFamily.body,
    fontSize: 13,
    color: colors.textMuted,
  },
  composer: {
    borderTopWidth: 1,
    borderTopColor: colors.borderDim,
    paddingTop: 10,
    paddingBottom: 8,
    gap: 10,
  },
  chips: {
    flexGrow: 0,
  },
  chip: {
    marginRight: 8,
    paddingVertical: 6,
    paddingHorizontal: 12,
    borderRadius: 100,
    borderWidth: 1,
    borderColor: colors.borderDim,
    backgroundColor: colors.surface,
  },
  chipText: {
    fontFamily: fontFamily.body,
    fontSize: 12,
    color: colors.textMuted,
  },
  inputRow: {
    flexDirection: 'row',
    alignItems: 'flex-end',
    gap: 10,
  },
  input: {
    flex: 1,
    maxHeight: 120,
    fontFamily: fontFamily.body,
    fontSize: 14,
    color: colors.offWhite,
    backgroundColor: colors.surfaceMd,
    borderWidth: 1,
    borderColor: colors.borderDim,
    borderRadius: 14,
    paddingVertical: 10,
    paddingHorizontal: 14,
  },
  send: {
    borderRadius: 14,
    backgroundColor: colors.goldFill,
    paddingVertical: 12,
    paddingHorizontal: 18,
  },
  sendDisabled: {
    opacity: 0.4,
  },
  sendPressed: {
    transform: [{ scale: 0.98 }],
  },
  sendLabel: {
    fontFamily: fontFamily.bodySemiBold,
    fontSize: 14,
    color: colors.nearBlack,
  },
});
import AsyncStorage from '@react-native-async-storage/async-storage';
import { useRouter } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { useTheme } from '../hooks/useTheme';
import type { ThemeColors } from '../lib/theme';
import {
  buildGreeting,
  consumeNotification,
  isAgentRole,
  LANGUAGES,
  loadProfile,
  ROLES,
  saveProfile,
  suggestionsFor,
  type AgentUserProfile,
} from '../lib/agentProfile';
import {
  createAgentSocket,
  type AgentSocket,
  type AgentSocketStatus,
} from '../lib/agentSocket';

/** AsyncStorage key holding the wallet address, shared with `lib/backupFile.ts`. */
const ADDRESS_KEY = 'invisible_wallet_address';

/** AsyncStorage key holding the fee-payer secret, mirroring the web wallet's. */
const SIGNER_SECRET_KEY = 'veil_signer_secret';

type ChatMessage = {
  id: string;
  role: 'user' | 'agent';
  content: string;
  /** Set when the agent built a transaction that needs the user's approval. */
  pendingTxXdr?: string;
  pendingTxSummary?: string;
};

let messageCounter = 0;
function nextMessageId(): string {
  messageCounter += 1;
  return `m${messageCounter}`;
}

function agentMessage(content: string, extra: Partial<ChatMessage> = {}): ChatMessage {
  return { id: nextMessageId(), role: 'agent', content, ...extra };
}

// ── Inline markdown ─────────────────────────────────────────────────────────────

type InlineSegment = { text: string; kind: 'plain' | 'bold' | 'code' };

/**
 * Split agent text into bold / code / plain runs.
 *
 * Deliberately minimal: the agent only ever emits `**bold**` and `` `code` ``,
 * and a fuller markdown parser would be a lot of surface area for two markers.
 * Unmatched markers stay literal, so a stray asterisk renders as an asterisk.
 */
function renderInline(content: string): InlineSegment[] {
  const segments: InlineSegment[] = [];
  const pattern = /\*\*(.+?)\*\*|`(.+?)`/gs;
  let cursor = 0;

  for (let match = pattern.exec(content); match !== null; match = pattern.exec(content)) {
    if (match.index > cursor) {
      segments.push({ text: content.slice(cursor, match.index), kind: 'plain' });
    }
    segments.push(
      match[1] !== undefined
        ? { text: match[1], kind: 'bold' }
        : { text: match[2] as string, kind: 'code' }
    );
    cursor = match.index + match[0].length;
  }

  if (cursor < content.length) {
    segments.push({ text: content.slice(cursor), kind: 'plain' });
  }
  return segments;
}

// ── Screen ──────────────────────────────────────────────────────────────────────

export default function AgentScreen() {
  const router = useRouter();
  const { colors } = useTheme();
  const styles = useMemo(() => createStyles(colors), [colors]);
  // The thread scrolls edge to edge, so the header and composer carry the
  // safe-area insets themselves rather than the screen being inset as a whole.
  const insets = useSafeAreaInsets();

  const [profile, setProfile] = useState<AgentUserProfile>({});
  const [ready, setReady] = useState(false);
  const [showOnboarding, setShowOnboarding] = useState(false);
  const [onboardingStep, setOnboardingStep] = useState(0);
  const [draft, setDraft] = useState<AgentUserProfile>({ name: '', role: '', language: 'English' });

  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [input, setInput] = useState('');
  const [isThinking, setIsThinking] = useState(false);
  const [status, setStatus] = useState<AgentSocketStatus>('connecting');
  const [approvingXdr, setApprovingXdr] = useState<string | null>(null);

  const walletAddress = useRef('');
  const feePayerSecret = useRef('');
  const feePayerAddress = useRef('');
  const socketRef = useRef<AgentSocket | null>(null);
  const scrollRef = useRef<ScrollView | null>(null);

  const appendMessage = useCallback((message: ChatMessage) => {
    setMessages((prev) => [...prev, message]);
  }, []);

  // ── Load stored identity, then greet or onboard ──────────────────────────────
  useEffect(() => {
    let cancelled = false;

    (async () => {
      const [stored, address, secret] = await Promise.all([
        loadProfile(),
        AsyncStorage.getItem(ADDRESS_KEY).catch(() => null),
        AsyncStorage.getItem(SIGNER_SECRET_KEY).catch(() => null),
      ]);
      if (cancelled) return;

      walletAddress.current = address ?? '';
      feePayerSecret.current = secret ?? '';
      feePayerAddress.current = secret ? await derivePublicKey(secret) : '';
      if (cancelled) return;
      setProfile(stored);

      if (!isAgentRole(stored.role)) {
        setDraft({ name: stored.name ?? '', role: '', language: stored.language ?? 'English' });
        setShowOnboarding(true);
        setReady(true);
        return;
      }

      const notification = await consumeNotification(stored);
      if (cancelled) return;
      setMessages([agentMessage(buildGreeting(stored, notification))]);
      setReady(true);
    })();

    return () => {
      cancelled = true;
    };
  }, []);

  // ── Socket lifecycle ─────────────────────────────────────────────────────────
  useEffect(() => {
    const socket = createAgentSocket({
      onStatus: setStatus,

      onMessage: (message) => {
        switch (message.type) {
          case 'thinking':
            setIsThinking(true);
            return;
          case 'response':
            setIsThinking(false);
            appendMessage(
              agentMessage(message.message, {
                pendingTxXdr: message.pendingTxXdr,
                pendingTxSummary: message.pendingTxSummary,
              })
            );
            return;
          case 'error':
            setIsThinking(false);
            appendMessage(agentMessage(`Something went wrong: ${message.message}`));
            return;
          case 'history_cleared':
            return;
        }
      },

      // The agent server keeps no outbox, so a reply interrupted by a dropped
      // connection is lost. Say so rather than leaving the dots spinning.
      onRequestsLost: (count) => {
        setIsThinking(false);
        appendMessage(
          agentMessage(
            count === 1
              ? 'The connection dropped before I could answer. Ask me again once you are back online.'
              : `The connection dropped before I could answer your last ${count} messages. Ask me again once you are back online.`
          )
        );
      },
    });

    socketRef.current = socket;
    socket.connect();

    return () => {
      socketRef.current = null;
      socket.close();
    };
  }, [appendMessage]);

  const suggestions = useMemo(() => suggestionsFor(profile), [profile]);
  const isOffline = status === 'reconnecting' || status === 'closed';

  // ── Sending ──────────────────────────────────────────────────────────────────
  const sendMessage = useCallback(
    (text: string) => {
      const trimmed = text.trim();
      const socket = socketRef.current;
      if (!trimmed || isThinking || !socket) return;

      appendMessage({ id: nextMessageId(), role: 'user', content: trimmed });
      setInput('');

      if (!walletAddress.current) {
        appendMessage(
          agentMessage(
            'I could not find your wallet on this device. Finish setting up or restoring your wallet, then come back and ask me again.'
          )
        );
        return;
      }

      const outcome = socket.send({
        type: 'chat',
        walletAddress: walletAddress.current,
        message: trimmed,
        ...(feePayerAddress.current ? { feePayerAddress: feePayerAddress.current } : {}),
        profile,
      });

      if (outcome === 'queued') {
        appendMessage(
          agentMessage("You're offline — I'll send that as soon as the connection is back.")
        );
      } else if (outcome === 'dropped') {
        appendMessage(
          agentMessage('Too many messages are already waiting to send. Try again once we reconnect.')
        );
      }
    },
    [appendMessage, isThinking, profile]
  );

  const clearHistory = useCallback(() => {
    const socket = socketRef.current;
    if (socket && walletAddress.current) {
      socket.send({ type: 'clear_history', walletAddress: walletAddress.current });
    }
    setIsThinking(false);
    setMessages([agentMessage(buildGreeting(profile))]);
  }, [profile]);

  // ── Transaction approval ─────────────────────────────────────────────────────
  const approveTransaction = useCallback(
    async (xdr: string) => {
      setApprovingXdr(xdr);
      // Drop the card immediately so a double tap cannot submit twice.
      setMessages((prev) =>
        prev.map((m) =>
          m.pendingTxXdr === xdr
            ? { ...m, pendingTxXdr: undefined, pendingTxSummary: undefined }
            : m
        )
      );

      try {
        if (!feePayerSecret.current) {
          throw new Error('No signing key on this device. Set up your fee-payer first.');
        }
        const hash = await submitSignedTransaction(xdr, feePayerSecret.current);
        appendMessage(agentMessage(`Transaction submitted.\n\nHash: \`${hash}\`\n\nSettles in ~5 seconds.`));
      } catch (err) {
        appendMessage(agentMessage(`Transaction failed: ${describeSubmitError(err)}`));
      } finally {
        setApprovingXdr(null);
      }
    },
    [appendMessage]
  );

  // ── Onboarding ───────────────────────────────────────────────────────────────
  const finishOnboarding = useCallback(async () => {
    const merged = await saveProfile(draft);
    setProfile(merged);
    setShowOnboarding(false);
    const notification = await consumeNotification(merged);
    setMessages([agentMessage(buildGreeting(merged, notification))]);
  }, [draft]);

  if (!ready) {
    return (
      <View style={[styles.screen, styles.centered]}>
        <ActivityIndicator color={colors.accent} />
      </View>
    );
  }

  if (showOnboarding) {
    return (
      <ScrollView
        style={styles.screen}
        contentContainerStyle={styles.onboarding}
        keyboardShouldPersistTaps="handled"
      >
        <View style={styles.dots}>
          {[0, 1, 2].map((i) => (
            <View key={i} style={[styles.dot, i <= onboardingStep && styles.dotActive]} />
          ))}
        </View>

        {onboardingStep === 0 && (
          <>
            <Text style={styles.onboardTitle}>What should I call you?</Text>
            <Text style={styles.onboardBody}>
              Your agent will greet you by name and personalize conversations.
            </Text>
            <TextInput
              style={[styles.input, styles.inputCentered]}
              placeholder="Your name"
              placeholderTextColor={colors.textFaint}
              value={draft.name ?? ''}
              onChangeText={(name) => setDraft((d) => ({ ...d, name }))}
              autoCapitalize="words"
              autoCorrect={false}
            />
            <Pressable
              style={styles.primaryButton}
              accessibilityRole="button"
              onPress={() => setOnboardingStep(1)}
            >
              <Text style={styles.primaryButtonLabel}>
                {draft.name?.trim() ? 'Continue' : 'Skip'}
              </Text>
            </Pressable>
          </>
        )}

        {onboardingStep === 1 && (
          <>
            <Text style={styles.onboardTitle}>How do you use your wallet?</Text>
            <Text style={styles.onboardBody}>
              This helps your agent give smarter suggestions when you receive funds or ask for help.
            </Text>
            {ROLES.map((role) => {
              const selected = draft.role === role.value;
              return (
                <Pressable
                  key={role.value}
                  accessibilityRole="radio"
                  accessibilityState={{ selected }}
                  onPress={() => setDraft((d) => ({ ...d, role: role.value }))}
                  style={[styles.optionCard, selected && styles.optionCardSelected]}
                >
                  <Text style={[styles.optionLabel, selected && styles.optionLabelSelected]}>
                    {role.label}
                  </Text>
                  <Text style={styles.optionDesc}>{role.desc}</Text>
                </Pressable>
              );
            })}
            <View style={styles.buttonRow}>
              <Pressable
                style={[styles.ghostButton, styles.flexOne]}
                accessibilityRole="button"
                onPress={() => setOnboardingStep(0)}
              >
                <Text style={styles.ghostButtonLabel}>Back</Text>
              </Pressable>
              <Pressable
                style={[styles.primaryButton, styles.flexTwo, !draft.role && styles.buttonDisabled]}
                accessibilityRole="button"
                disabled={!draft.role}
                onPress={() => setOnboardingStep(2)}
              >
                <Text style={styles.primaryButtonLabel}>Continue</Text>
              </Pressable>
            </View>
          </>
        )}

        {onboardingStep === 2 && (
          <>
            <Text style={styles.onboardTitle}>Preferred language</Text>
            <Text style={styles.onboardBody}>Your agent will respond in this language.</Text>
            <View style={styles.languageWrap}>
              {LANGUAGES.map((language) => {
                const selected = draft.language === language;
                return (
                  <Pressable
                    key={language}
                    accessibilityRole="radio"
                    accessibilityState={{ selected }}
                    onPress={() => setDraft((d) => ({ ...d, language }))}
                    style={[styles.chip, selected && styles.chipSelected]}
                  >
                    <Text style={[styles.chipLabel, selected && styles.chipLabelSelected]}>
                      {language}
                    </Text>
                  </Pressable>
                );
              })}
            </View>
            <View style={styles.buttonRow}>
              <Pressable
                style={[styles.ghostButton, styles.flexOne]}
                accessibilityRole="button"
                onPress={() => setOnboardingStep(1)}
              >
                <Text style={styles.ghostButtonLabel}>Back</Text>
              </Pressable>
              <Pressable
                style={[styles.primaryButton, styles.flexTwo]}
                accessibilityRole="button"
                onPress={finishOnboarding}
              >
                <Text style={styles.primaryButtonLabel}>Start chatting</Text>
              </Pressable>
            </View>
          </>
        )}
      </ScrollView>
    );
  }

  return (
    <KeyboardAvoidingView
      style={styles.screen}
      behavior={Platform.OS === 'ios' ? 'padding' : undefined}
    >
      <View style={[styles.header, { paddingTop: insets.top + 12 }]}>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Go back"
          onPress={() => router.back()}
          style={styles.headerButton}
        >
          <Text style={styles.headerButtonLabel}>Back</Text>
        </Pressable>
        <View style={styles.headerCenter}>
          <Text style={styles.headerTitle}>Veil Agent</Text>
          <Text style={styles.headerSubtitle}>Powered by Claude</Text>
        </View>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Clear conversation history"
          onPress={clearHistory}
          style={styles.headerButton}
        >
          <Text style={styles.headerButtonLabel}>Clear</Text>
        </Pressable>
      </View>

      {isOffline && (
        <View style={styles.banner} accessibilityRole="alert">
          <Text style={styles.bannerText}>
            {status === 'reconnecting'
              ? 'Reconnecting to your agent…'
              : 'Disconnected from your agent.'}
          </Text>
        </View>
      )}

      <ScrollView
        ref={scrollRef}
        style={styles.thread}
        contentContainerStyle={styles.threadContent}
        keyboardShouldPersistTaps="handled"
        onContentSizeChange={() => scrollRef.current?.scrollToEnd({ animated: true })}
      >
        {messages.map((message) => (
          <View
            key={message.id}
            style={[styles.row, message.role === 'user' ? styles.rowUser : styles.rowAgent]}
          >
            <View
              style={[
                styles.bubble,
                message.role === 'user' ? styles.bubbleUser : styles.bubbleAgent,
              ]}
            >
              <Text style={styles.bubbleText}>
                {renderInline(message.content).map((segment, i) => (
                  <Text
                    key={i}
                    style={
                      segment.kind === 'bold'
                        ? styles.bold
                        : segment.kind === 'code'
                          ? styles.code
                          : undefined
                    }
                  >
                    {segment.text}
                  </Text>
                ))}
              </Text>

              {message.pendingTxXdr && (
                <View style={styles.approvalCard}>
                  <Text style={styles.approvalLabel}>TRANSACTION READY</Text>
                  {message.pendingTxSummary && (
                    <Text style={styles.approvalSummary}>{message.pendingTxSummary}</Text>
                  )}
                  <Pressable
                    accessibilityRole="button"
                    accessibilityLabel="Approve and submit transaction"
                    disabled={approvingXdr !== null}
                    onPress={() => approveTransaction(message.pendingTxXdr as string)}
                    style={[styles.primaryButton, approvingXdr !== null && styles.buttonDisabled]}
                  >
                    {approvingXdr === message.pendingTxXdr ? (
                      <ActivityIndicator color={colors.onAccent} />
                    ) : (
                      <Text style={styles.primaryButtonLabel}>Approve and submit</Text>
                    )}
                  </Pressable>
                </View>
              )}
            </View>
          </View>
        ))}

        {isThinking && (
          <View style={[styles.row, styles.rowAgent]}>
            <View style={[styles.bubble, styles.bubbleAgent]}>
              <Text style={styles.thinkingText}>Thinking…</Text>
            </View>
          </View>
        )}
      </ScrollView>

      <View style={[styles.composer, { paddingBottom: insets.bottom + 12 }]}>
        <ScrollView
          horizontal
          showsHorizontalScrollIndicator={false}
          contentContainerStyle={styles.suggestionRow}
          keyboardShouldPersistTaps="handled"
        >
          {suggestions.map((suggestion) => (
            <Pressable
              key={suggestion}
              accessibilityRole="button"
              onPress={() => setInput(suggestion)}
              style={styles.chip}
            >
              <Text style={styles.chipLabel}>{suggestion}</Text>
            </Pressable>
          ))}
        </ScrollView>

        <View style={styles.inputRow}>
          <TextInput
            style={[styles.input, styles.flexOne]}
            placeholder="Ask me anything…"
            placeholderTextColor={colors.textFaint}
            value={input}
            onChangeText={setInput}
            onSubmitEditing={() => sendMessage(input)}
            editable={!isThinking}
            returnKeyType="send"
            multiline
          />
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Send message"
            disabled={!input.trim() || isThinking}
            onPress={() => sendMessage(input)}
            style={[styles.sendButton, (!input.trim() || isThinking) && styles.buttonDisabled]}
          >
            <Text style={styles.sendButtonLabel}>Send</Text>
          </Pressable>
        </View>
      </View>
    </KeyboardAvoidingView>
  );
}

// ── Transaction submission ──────────────────────────────────────────────────────

/**
 * The fee-payer address the agent should build transactions against.
 *
 * Always derived from the stored secret, never read from a cached public key:
 * the web wallet found that a stale cache produces an address/signer mismatch
 * the server rejects with a 400. An unusable secret yields an empty string, and
 * the field is simply omitted from the request.
 */
async function derivePublicKey(secret: string): Promise<string> {
  try {
    const { Keypair } = await import('@stellar/stellar-sdk');
    return Keypair.fromSecret(secret).publicKey();
  } catch {
    return '';
  }
}

/**
 * Sign the agent's transaction with the device's fee-payer key and submit it.
 *
 * The agent never holds a wallet key — it builds an unsigned envelope and the
 * user's device is what authorises it. Mirrors the web wallet's approval path.
 */
async function submitSignedTransaction(xdr: string, signerSecret: string): Promise<string> {
  const { Keypair, TransactionBuilder, Horizon, Networks } = await import('@stellar/stellar-sdk');

  const networkPassphrase =
    process.env['EXPO_PUBLIC_NETWORK_PASSPHRASE']?.trim() || Networks.TESTNET;
  const horizonUrl =
    process.env['EXPO_PUBLIC_HORIZON_URL']?.trim() ||
    (networkPassphrase === Networks.PUBLIC
      ? 'https://horizon.stellar.org'
      : 'https://horizon-testnet.stellar.org');

  const transaction = TransactionBuilder.fromXDR(xdr, networkPassphrase);
  transaction.sign(Keypair.fromSecret(signerSecret));

  const result = await new Horizon.Server(horizonUrl).submitTransaction(transaction);
  return result.hash;
}

/**
 * Turn a Horizon rejection into something a user can act on. Horizon buries the
 * useful part — the transaction and operation result codes — inside the error
 * response, and the top-level message is only ever "Request failed".
 */
function describeSubmitError(error: unknown): string {
  const codes = (
    error as { response?: { data?: { extras?: { result_codes?: Record<string, unknown> } } } }
  )?.response?.data?.extras?.result_codes;

  if (codes) {
    const operations = Array.isArray(codes.operations) ? codes.operations.join(', ') : '';
    const transaction = typeof codes.transaction === 'string' ? codes.transaction : 'tx_failed';
    return operations ? `${transaction} — ${operations}` : transaction;
  }

  return error instanceof Error ? error.message : 'Unknown error';
}

// ── Styles ──────────────────────────────────────────────────────────────────────

const createStyles = (colors: ThemeColors) =>
  StyleSheet.create({
    screen: {
      flex: 1,
      backgroundColor: colors.background,
    },
    centered: {
      alignItems: 'center',
      justifyContent: 'center',
    },
    header: {
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'space-between',
      paddingHorizontal: 16,
      paddingBottom: 12,
      borderBottomWidth: 1,
      borderBottomColor: colors.border,
    },
    headerButton: {
      minWidth: 52,
      paddingVertical: 6,
    },
    headerButtonLabel: {
      color: colors.textMuted,
      fontSize: 14,
    },
    headerCenter: {
      alignItems: 'center',
    },
    headerTitle: {
      color: colors.textStrong,
      fontSize: 15,
      fontWeight: '600',
    },
    headerSubtitle: {
      color: colors.textMuted,
      fontSize: 11,
      marginTop: 2,
    },
    banner: {
      backgroundColor: colors.surface,
      borderBottomWidth: 1,
      borderBottomColor: colors.border,
      paddingVertical: 8,
      paddingHorizontal: 16,
    },
    bannerText: {
      color: colors.textMuted,
      fontSize: 12,
      textAlign: 'center',
    },
    thread: {
      flex: 1,
    },
    threadContent: {
      padding: 16,
      gap: 12,
    },
    row: {
      flexDirection: 'row',
    },
    rowUser: {
      justifyContent: 'flex-end',
    },
    rowAgent: {
      justifyContent: 'flex-start',
    },
    bubble: {
      maxWidth: '82%',
      borderRadius: 18,
      borderWidth: 1,
      paddingHorizontal: 14,
      paddingVertical: 10,
    },
    bubbleUser: {
      backgroundColor: colors.surface,
      borderColor: colors.accent,
      borderBottomRightRadius: 4,
    },
    bubbleAgent: {
      backgroundColor: colors.surface,
      borderColor: colors.border,
      borderBottomLeftRadius: 4,
    },
    bubbleText: {
      color: colors.textPrimary,
      fontSize: 14,
      lineHeight: 22,
    },
    bold: {
      fontWeight: '700',
      color: colors.textStrong,
    },
    code: {
      fontFamily: Platform.OS === 'ios' ? 'Menlo' : 'monospace',
      fontSize: 13,
      color: colors.accentText,
    },
    thinkingText: {
      color: colors.textMuted,
      fontSize: 14,
    },
    approvalCard: {
      marginTop: 12,
      padding: 12,
      borderRadius: 12,
      borderWidth: 1,
      borderColor: colors.accent,
      gap: 8,
    },
    approvalLabel: {
      color: colors.textFaint,
      fontSize: 11,
      letterSpacing: 1,
    },
    approvalSummary: {
      color: colors.textPrimary,
      fontSize: 13,
      lineHeight: 20,
    },
    composer: {
      borderTopWidth: 1,
      borderTopColor: colors.border,
      paddingHorizontal: 16,
      paddingTop: 10,
      gap: 10,
    },
    suggestionRow: {
      gap: 8,
      paddingRight: 8,
    },
    inputRow: {
      flexDirection: 'row',
      alignItems: 'flex-end',
      gap: 10,
    },
    input: {
      backgroundColor: colors.surface,
      borderRadius: 12,
      borderWidth: 1,
      borderColor: colors.border,
      color: colors.textPrimary,
      fontSize: 15,
      maxHeight: 120,
      paddingHorizontal: 14,
      paddingVertical: 12,
    },
    inputCentered: {
      textAlign: 'center',
    },
    sendButton: {
      alignItems: 'center',
      justifyContent: 'center',
      backgroundColor: colors.accent,
      borderRadius: 12,
      minHeight: 48,
      paddingHorizontal: 18,
    },
    sendButtonLabel: {
      color: colors.onAccent,
      fontSize: 15,
      fontWeight: '600',
    },
    chip: {
      alignSelf: 'flex-start',
      backgroundColor: colors.surface,
      borderColor: colors.border,
      borderRadius: 100,
      borderWidth: 1,
      paddingHorizontal: 14,
      paddingVertical: 7,
    },
    chipSelected: {
      borderColor: colors.accent,
    },
    chipLabel: {
      color: colors.textMuted,
      fontSize: 13,
    },
    chipLabelSelected: {
      color: colors.accentText,
      fontWeight: '600',
    },
    onboarding: {
      flexGrow: 1,
      gap: 12,
      justifyContent: 'center',
      padding: 24,
    },
    dots: {
      flexDirection: 'row',
      gap: 8,
      justifyContent: 'center',
      marginBottom: 8,
    },
    dot: {
      backgroundColor: colors.border,
      borderRadius: 4,
      height: 8,
      width: 8,
    },
    dotActive: {
      backgroundColor: colors.accent,
    },
    onboardTitle: {
      color: colors.textStrong,
      fontSize: 26,
      fontWeight: '700',
      textAlign: 'center',
    },
    onboardBody: {
      color: colors.textSecondary,
      fontSize: 14,
      lineHeight: 21,
      marginBottom: 8,
      textAlign: 'center',
    },
    optionCard: {
      backgroundColor: colors.surface,
      borderColor: colors.border,
      borderRadius: 12,
      borderWidth: 1,
      padding: 16,
    },
    optionCardSelected: {
      borderColor: colors.accent,
    },
    optionLabel: {
      color: colors.textPrimary,
      fontSize: 15,
      fontWeight: '600',
    },
    optionLabelSelected: {
      color: colors.accentText,
    },
    optionDesc: {
      color: colors.textMuted,
      fontSize: 13,
      marginTop: 2,
    },
    languageWrap: {
      flexDirection: 'row',
      flexWrap: 'wrap',
      gap: 8,
      justifyContent: 'center',
    },
    buttonRow: {
      flexDirection: 'row',
      gap: 12,
      marginTop: 8,
    },
    flexOne: {
      flex: 1,
    },
    flexTwo: {
      flex: 2,
    },
    primaryButton: {
      alignItems: 'center',
      backgroundColor: colors.accent,
      borderRadius: 12,
      justifyContent: 'center',
      minHeight: 48,
      paddingHorizontal: 20,
    },
    primaryButtonLabel: {
      color: colors.onAccent,
      fontSize: 15,
      fontWeight: '600',
    },
    ghostButton: {
      alignItems: 'center',
      borderColor: colors.border,
      borderRadius: 12,
      borderWidth: 1,
      justifyContent: 'center',
      minHeight: 48,
      paddingHorizontal: 20,
    },
    ghostButtonLabel: {
      color: colors.textPrimary,
      fontSize: 15,
      fontWeight: '600',
    },
    buttonDisabled: {
      opacity: 0.5,
    },
  });
