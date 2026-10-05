import '../../lib/polyfills';

import { Horizon, Keypair, TransactionBuilder, type Transaction } from '@stellar/stellar-sdk';
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

import { useRouter } from 'expo-router';
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

import { Button, Card, Screen } from '../../components/ui';
import {
  describeSubmissionError,
  proposalRefusal,
  nextMessageId,
  parseInlineMarkup,
  reviewProposedTransaction,
  shortenAddress,
  type AgentMessage,
  type ProposalReview,
  type ProposalStatus,
} from '../../lib/agentMessages';
import { useNetwork } from '../../hooks/useNetwork';
import { historyFromMessages, sendAgentMessage, type AgentReply } from '../../lib/agentClient';
import { signPayloadWithPasskey } from '../../lib/passkey';
import { getPasskeyId, getSignerSecret, getWalletAddress } from '../../lib/walletStore';
import { useTheme } from '../../hooks/useTheme';
import type { ThemeColors } from '../../lib/theme';
import { fontFamily, typography } from '../../theme/typography';

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

const SUGGESTIONS = [
  "What's my balance?",
  'Swap 100 XLM to USDC',
  'Show recent transfers',
  'Best XLM/USDC rate?',
];

export default function AgentScreen() {
  const { colors } = useTheme();
  const styles = useMemo(() => createStyles(colors), [colors]);
  // Subscribed rather than read once at module load: the network is a runtime
  // choice, and everything on this screen belongs to exactly one chain.
  const { network } = useNetwork();
  const [messages, setMessages] = useState<AgentMessage[]>([
    {
      id: nextMessageId('greeting'),
      kind: 'agent',
      text: "I'm your Veil agent. I can check prices, read your transfer history, and prepare swaps and payments. Anything that moves funds needs your passkey — I can't sign for you.",
    },
  ]);
  const [input, setInput] = useState('');
  const [isThinking, setIsThinking] = useState(false);
  const [walletAddress, setWalletAddress] = useState<string | null>(null);
  const [feePayerAddress, setFeePayerAddress] = useState<string | null>(null);

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

  const handleReply = useCallback(
    (reply: AgentReply) => {
      if (reply.swapIntent) {
        appendMessage({
          id: nextMessageId('swap'),
          kind: 'swap',
          text: reply.response,
          intent: reply.swapIntent,
        });
        return;
      }

      if (reply.investIntent) {
        appendMessage({
          id: nextMessageId('invest'),
          kind: 'invest',
          text: reply.response,
          intent: reply.investIntent,
        });
        return;
      }

      if (!reply.pendingTxXdr) {
        appendMessage({ id: nextMessageId('agent'), kind: 'agent', text: reply.response });
        return;
      }

      // Decode the transaction before it is ever shown as approvable: a
      // proposal we cannot read is presented as one to reject, not to trust.
      let review: ProposalReview | null = null;
      let reviewError: string | null = null;
      try {
        review = reviewProposedTransaction(reply.pendingTxXdr, network.networkPassphrase);
      } catch (error) {
        reviewError =
          error instanceof Error ? error.message : 'This transaction could not be decoded on this device.';
      }

      appendMessage({
        id: nextMessageId('proposal'),
        kind: 'proposal',
        text: reply.response,
        claim: reply.pendingTxSummary ?? null,
        xdr: reply.pendingTxXdr,
        review,
        reviewError,
        status: { state: 'awaiting' },
      });
    },
    [appendMessage, network.networkPassphrase]
  );

  // One HTTPS request per message to the agent route (lib/agentClient.ts). The
  // conversation so far travels with it; the server keeps nothing between calls.
  async function handleSend() {
    const text = input.trim();
    if (!text || isThinking) return;

    const history = historyFromMessages(messages);
    appendMessage({ id: nextMessageId('user'), kind: 'user', text });
    setInput('');

    if (!walletAddress) {
      appendMessage({
        id: nextMessageId('error'),
        kind: 'error',
        text: 'No wallet on this device yet, so there is nothing for the agent to act on.',
      });
      return;
    }

    setIsThinking(true);
    try {
      const reply = await sendAgentMessage({
        message: text,
        walletAddress,
        feePayerAddress: feePayerAddress ?? undefined,
        history,
      });
      handleReply(reply);
    } catch (error) {
      appendMessage({
        id: nextMessageId('error'),
        kind: 'error',
        text: error instanceof Error ? error.message : String(error),
      });
    } finally {
      setIsThinking(false);
    }
  }

  function handleClearHistory() {
    // The agent keeps no history of its own any more — what it sees is what this
    // screen sends — so clearing is local.
    setMessages((current) => current.slice(0, 1));
    appendMessage({ id: nextMessageId('notice'), kind: 'notice', text: 'Conversation cleared.' });
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

    // One rule, shared with the web wallet (proposalRefusal): the decoded
    // transaction must be from this wallet's fee payer, with every operation one
    // this screen can show. The agent's summary plays no part in the decision.
    const refusal = proposalRefusal(message.review, feePayerAddress);
    if (refusal) {
      updateProposal(message.id, { state: 'failed', reason: refusal });
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
      const secret = await getSignerSecret();
      if (!secret) {
        updateProposal(message.id, {
          state: 'failed',
          reason: 'The signing key for this wallet is missing from this device.',
        });
        return;
      }

      // The passkey confirmation applies only when a passkey is registered
      // (smart-wallet / dev build). Testnet keypair mode has no passkey, so we
      // authorise with the stored key directly.
      if (await getPasskeyId()) {
        const confirmation = await signPayloadWithPasskey(new Uint8Array(tx.hash()));
        if (!confirmation) {
          updateProposal(message.id, { state: 'declined' });
          return;
        }
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
              It can propose, only you can sign
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

        <ScrollView showsVerticalScrollIndicator={false}
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
              <ActivityIndicator color={colors.accent} size="small" />
              <Text style={styles.thinkingText}>Thinking…</Text>
            </View>
          )}
        </ScrollView>

        <View style={styles.composer}>
          <ScrollView showsVerticalScrollIndicator={false} horizontal showsHorizontalScrollIndicator={false} style={styles.chips}>
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
              placeholderTextColor={colors.textFaint}
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
  const { colors } = useTheme();
  const styles = useMemo(() => createStyles(colors), [colors]);
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

    case 'swap':
      return (
        <View style={styles.row}>
          <View style={[styles.bubble, styles.bubbleAgent]}>
            {message.text.trim() ? <RichText text={message.text} /> : null}
            <SwapHandoff intent={message.intent} />
          </View>
        </View>
      );

    case 'invest':
      return (
        <View style={styles.row}>
          <View style={[styles.bubble, styles.bubbleAgent]}>
            {message.text.trim() ? <RichText text={message.text} /> : null}
            <InvestHandoff intent={message.intent} />
          </View>
        </View>
      );
  }
}

/**
 * The agent does not build swaps: it hands them to the Swap screen, which
 * quotes across Soroswap, Phoenix, Aqua and the Stellar DEX, shows the route and
 * slippage, and asks for the passkey there.
 */
function SwapHandoff({ intent }: { intent: { from: string; to: string; amount?: string } }) {
  const router = useRouter();
  return (
    <View style={{ marginTop: 10 }}>
      <Button
        label={`Open Swap · ${intent.amount ? `${intent.amount} ` : ''}${intent.from} → ${intent.to}`}
        onPress={() =>
          router.push({
            pathname: '/swap',
            params: { from: intent.from, to: intent.to, ...(intent.amount ? { amount: intent.amount } : {}) },
          })
        }
      />
    </View>
  );
}

function InvestHandoff({ intent }: { intent: { asset: { code: string; issuer: string }; amount: string } }) {
  const router = useRouter();
  return (
    <View style={{ marginTop: 10 }}>
      <Button
        label={`Open Earn · ${intent.amount} ${intent.asset.code}`}
        onPress={() =>
          router.push({
            pathname: '/earn',
            params: { asset: intent.asset.code, issuer: intent.asset.issuer, amount: intent.amount },
          })
        }
      />
    </View>
  );
}

/** Agent prose with `**bold**` and `` `code` `` rendered as text, never as markup. */
function RichText({ text }: { text: string }) {
  const { colors } = useTheme();
  const styles = useMemo(() => createStyles(colors), [colors]);
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
  const { colors } = useTheme();
  const styles = useMemo(() => createStyles(colors), [colors]);
  // Named on the approval card itself, so which chain is about to be signed
  // against is visible at the moment of approval — and stays correct if the
  // user switches networks with a proposal already on screen.
  const { network } = useNetwork();
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
          <ActivityIndicator color={colors.accent} size="small" />
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

const createStyles = (colors: ThemeColors) =>
  StyleSheet.create({
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
      color: colors.textStrong,
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
      backgroundColor: 'rgba(253,218,36,0.08)',
      borderColor: 'rgba(253,218,36,0.18)',
      borderBottomRightRadius: 4,
    },
    bubbleAgent: {
      backgroundColor: colors.surfaceMd,
      borderColor: colors.border,
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
      color: colors.textPrimary,
    },
    strong: {
      fontFamily: fontFamily.bodySemiBold,
    },
    code: {
      fontFamily: fontFamily.address,
      fontSize: 13,
      color: colors.label,
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
      color: colors.accent,
    },
    proposalOperation: {
      fontFamily: fontFamily.bodyMedium,
      fontSize: 14,
      lineHeight: 20,
      color: colors.textPrimary,
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
      color: colors.textFaint,
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
      color: colors.positive,
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
      borderTopColor: colors.border,
      paddingTop: 10,
      // The tab bar floats over the bottom of every tab (VeilTabBar is
      // absolutely positioned), and its raised centre button stands higher
      // still. With 8 here the input sat underneath it and could not be typed
      // into. Scrolling tabs clear it with bottom padding on their content;
      // this composer is pinned, so it has to clear it itself.
      paddingBottom: 100,
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
      borderColor: colors.border,
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
      color: colors.textPrimary,
      backgroundColor: colors.surfaceMd,
      borderWidth: 1,
      borderColor: colors.border,
      borderRadius: 14,
      paddingVertical: 10,
      paddingHorizontal: 14,
    },
    send: {
      borderRadius: 14,
      backgroundColor: colors.accent,
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
      color: colors.onAccent,
    },
  });
