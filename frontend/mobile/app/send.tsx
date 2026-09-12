import { errorMessage } from '../lib/errorMessage';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { useLocalSearchParams } from 'expo-router';
import { ActivityIndicator, KeyboardAvoidingView, Modal, Platform, Pressable, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { useTheme } from '../hooks/useTheme';
import { useCurrency } from '../hooks/useCurrency';
import { useHiddenAmounts } from '../hooks/useHiddenAmounts';
import type { ThemeColors } from '../lib/theme';
import { fontFamily } from '../theme/typography';
import { FlowHeader } from '../components/FlowHeader';
import { isValidDestination } from '../lib/address';
import { ContactPicker } from '../components/ContactPicker';
import { QrScanner } from '../components/QrScanner';
import type { Contact } from '../hooks/useContacts';
import { requireSigner } from '../lib/signer';
import { requirePasskey } from '../lib/passkey';
import { fetchContractAssetBalance } from '../lib/activity';
import { sendAssetFromContract, getFeePayerSpendableXlm, isWalletDeployed } from '../lib/contractSpend';
import { getSignerSecret } from '../lib/walletStore';
import { useWallet } from '../components/WalletProvider';
import { sendPayment } from '../lib/sendPayment';
import { truncateAddress } from '../components/ui/AddressChip';
import { getWalletAddress } from '../lib/walletStore';
import { loadHoldings, unitPrice, type Holding } from '../lib/holdings';
import { ChevronDownIcon, ScanIcon, UsersIcon } from '../components/icons';
import { TokenIcon } from '../components/TokenIcon';
import { SuccessAnimation } from '../components/SuccessAnimation';
import { SlideToConfirm } from '../components/SlideToConfirm';

/** expo-router yields `string | string[]` for a repeated query key. */
function firstValue(value: string | string[] | undefined): string {
  if (Array.isArray(value)) return value[0] ?? '';
  return value ?? '';
}

/** Trim a raw balance to at most 4 grouped decimals. */
function fmtAmount(raw: string): string {
  const n = Number(raw);
  if (!isFinite(n)) return raw;
  return n.toLocaleString('en-US', { maximumFractionDigits: 4 });
}

const QUICK = [
  { label: '25%', frac: 0.25 },
  { label: '50%', frac: 0.5 },
  { label: '75%', frac: 0.75 },
  { label: 'Max', frac: 1 },
];

type Step = 'form' | 'authorizing' | 'submitting' | 'done' | 'error';

export default function SendScreen() {
  const { colors, isDark } = useTheme();
  const { format } = useCurrency();
  const { mask } = useHiddenAmounts();
  const { wallet } = useWallet();
  const styles = useMemo(() => createStyles(colors), [colors]);

  // Deep links land here prefilled: `to`, `amount`, `asset`, `memo`.
  const params = useLocalSearchParams<{ to?: string; amount?: string; asset?: string; memo?: string }>();

  const [recipient, setRecipient] = useState(() => firstValue(params.to));
  const [amount, setAmount] = useState(() => firstValue(params.amount));
  const [memo, setMemo] = useState(() => firstValue(params.memo));
  const [pickerOpen, setPickerOpen] = useState(false);
  const [scannerOpen, setScannerOpen] = useState(false);
  const [assetSheet, setAssetSheet] = useState(false);

  const [holdings, setHoldings] = useState<Holding[]>([]);
  const [selectedKey, setSelectedKey] = useState<string | null>(null);

  const [step, setStep] = useState<Step>('form');
  const [hash, setHash] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  // Load the account's real holdings for the asset selector.
  // Smart-wallet source: when the wallet is a C-address holding its own XLM,
  // the user can choose to spend from the contract (a __check_auth transfer).
  const [contractAddr, setContractAddr] = useState<string | null>(null);
  /** The contract's balance of the currently selected asset, not just XLM. */
  /**
   * What the CONTRACT holds of the selected asset. `null` means not read yet,
   * which is different from zero: until it is known we cannot split the
   * combined holding into what each side can actually send.
   */
  const [contractHeld, setContractHeld] = useState<number | null>(null);
  const [fromContract, setFromContract] = useState(false);

  useEffect(() => {
    let alive = true;
    (async () => {
      const address = await getWalletAddress().catch(() => null);
      if (!address) return;
      if (address.startsWith('C')) {
        if (alive) setContractAddr(address);
      }
      const hs = await loadHoldings(address).catch(() => [] as Holding[]);
      if (!alive) return;
      setHoldings(hs);
    })();
    return () => {
      alive = false;
    };
  }, []);

  const keyOf = (h: Holding) => `${h.code}:${h.issuer ?? 'native'}`;
  const preferred = firstValue(params.asset).toUpperCase();
  const selected =
    holdings.find((h) => keyOf(h) === selectedKey) ??
    holdings.find((h) => h.code === preferred) ??
    holdings.find((h) => h.native) ??
    holdings[0] ??
    null;
  const assetCode = selected?.code || firstValue(params.asset) || 'XLM';

  const trimmed = recipient.trim();
  const recipientValid = isValidDestination(trimmed);
  const showError = trimmed.length > 0 && !recipientValid;
  // The contract's balance OF THE SELECTED ASSET. Previously this only ever
  // read native XLM, so the smart wallet could not be chosen as the source for
  // anything else — the routing would use it, but nothing on screen said so.
  useEffect(() => {
    let alive = true;
    if (!contractAddr) return;
    const asset =
      selected && !selected.native && selected.issuer
        ? { code: selected.code, issuer: selected.issuer }
        : undefined;
    setContractHeld(null);
    void fetchContractAssetBalance(contractAddr, asset)
      .then((x) => {
        if (alive) setContractHeld(x);
      })
      .catch(() => {
        if (alive) setContractHeld(null);
      });
    return () => { alive = false; };
  }, [contractAddr, selected?.code, selected?.issuer, selected?.native]);

  const editable = step === 'form' || step === 'error';
  const amtNum = Number(amount);
  const nonNative = !!selected && !selected.native;
  const balanceNum = selected ? Number(selected.balance) : 0;
  // Any asset the contract actually holds can be its source — a SAC transfer
  // is asset-agnostic and needs no trustline on the contract side.
  const held = contractHeld ?? 0;
  const contractSource = fromContract && !!contractAddr && held > 0;

  /**
   * What the CLASSIC account alone holds.
   *
   * `selected.balance` is the COMBINED holding — `loadHoldings` adds the
   * contract's SAC balance to the fee payer's trustline on purpose, because
   * "what do I own" is one number. It is the wrong number the moment a source
   * is chosen, and using it here is what produced an `op_underfunded` on a
   * send of 10.3 from an account holding 10.2946 while the screen said 10.5546:
   * the missing 0.26 was in the contract, which this send was never going to
   * touch. Never show a number the app cannot honour.
   *
   * `null` while the contract side is still being read, so nothing is offered
   * on a split we have not measured yet.
   */
  const classicHeld = contractHeld === null ? null : Math.max(0, balanceNum - contractHeld);

  // Native sends must leave ~1.5 XLM for the base reserve + fee.
  const spendable = contractSource
    ? held
    : selected && classicHeld !== null
      ? selected.native
        ? Math.max(0, classicHeld - 1.5)
        : classicHeld
      : null;
  const insufficient = spendable !== null && amtNum > 0 && amtNum > spendable;
  const canSubmit = recipientValid && amtNum > 0 && editable && !insufficient;

  const up = selected ? unitPrice(selected) : null;
  const fiatOfAmount = up !== null && isFinite(amtNum) && amtNum > 0 ? format(amtNum * up) : null;

  const handleSelectContact = useCallback((contact: Contact) => {
    setRecipient(contact.address);
    setPickerOpen(false);
  }, []);

  const handleQuick = (frac: number) => {
    // Off the SOURCE's spendable, not the combined holding. `spendable`
    // already carries the native reserve deduction, so Max is an amount the
    // chosen account can actually pay.
    if (spendable === null || !isFinite(spendable) || spendable <= 0) return;
    const usable = spendable * frac;
    setAmount(usable.toFixed(usable >= 1 ? 2 : 4));
  };

  const handleSend = async () => {
    if (!canSubmit) return;
    setError(null);
    try {
      setStep('authorizing');

      // Smart-wallet spend: explicit "Smart wallet" source, or the automatic
      // fallback when the fee-payer alone can't cover the amount. The transfer
      // is FROM the contract — the passkey signs the Soroban auth entry and
      // __check_auth verifies it on-chain (that prompt IS the security gate).
      const stored = await getWalletAddress().catch(() => null);
      if (stored?.startsWith('C')) {
        // Narrowed on `issuer` rather than on `nonNative`: an issued asset with
        // no issuer cannot be turned into a SAC id, so it must not reach the
        // contract path at all. Undefined means native, which is the one asset
        // that legitimately has no issuer.
        const spendAsset =
          nonNative && selected?.issuer
            ? { code: selected.code, issuer: selected.issuer }
            : undefined;

        const [liveContractBalance, fpSpendable] = await Promise.all([
          fetchContractAssetBalance(stored, spendAsset),
          getFeePayerSpendableXlm(),
        ]);

        // Prefer the contract when it can actually cover the amount — it is the
        // wallet the user believes they are spending from, and the fee payer is
        // plumbing. But "prefer" is the operative word: the fee payer holds its
        // own separate balance and is a legitimate source too.
        //
        // Requiring the contract for every issued asset was wrong, and broke
        // the one flow that has to work first: moving USDC from the fee payer
        // INTO the contract. The contract is empty by definition at that point,
        // so the check rejected the transfer that would have filled it.
        const shouldUseContract = amtNum <= liveContractBalance && liveContractBalance > 0;
        if (shouldUseContract) {
          // The wallet contract must exist on-chain before __check_auth can run.
          // Creation computed the address counterfactually — deploy lazily here.
          if (!(await isWalletDeployed(stored))) {
            const secret = await getSignerSecret();
            if (!secret) throw new Error('No fee-payer key on this device to pay for deployment.');
            await wallet.deploy(secret);
          }
          setStep('submitting');
          const hash = await sendAssetFromContract(stored, recipient.trim(), amount, spendAsset);
          setHash(hash);
          setStep('done');
          return;
        }
        // Only an explicit "Smart wallet" choice is an error when the contract
        // is short. Otherwise fall through to the fee payer, which for an
        // issued asset reaches a C-address destination over that asset's SAC.
        if (contractSource) {
          const code = nonNative && selected ? selected.code : 'XLM';
          throw new Error(
            `The smart wallet holds ${liveContractBalance.toFixed(2)} ${code} — not enough for this amount.`,
          );
        }
      }

      // Presence gate: when a passkey is registered, spending demands it.
      await requirePasskey();
      const signer = await requireSigner();
      setStep('submitting');
      const result = await sendPayment(
        recipient,
        amount,
        signer,
        memo,
        nonNative && selected ? { code: selected.code, issuer: selected.issuer } : undefined,
      );
      setHash(result.hash);
      setStep('done');
    } catch (err) {
      const raw = errorMessage(err);
      const name = err instanceof Error ? err.name : '';
      // Horizon's 404 for the source account surfaces as a bare "Not found".
      const friendly =
        name === 'NotFoundError' || /^not found$/i.test(raw.trim())
          ? 'Your fee-payer account has no XLM yet. Open Settings → Fund test XLM, then try again.'
          : raw;
      setError(friendly);
      setStep('error');
    }
  };

  const reset = () => {
    setRecipient('');
    setAmount('');
    setMemo('');
    setStep('form');
    setHash(null);
    setError(null);
  };

  const busy = step === 'authorizing' || step === 'submitting';

  if (step === 'done') {
    return (
      <SafeAreaView style={styles.screen} edges={['top', 'bottom']} testID="send-screen">
        <View style={styles.body}>
          <FlowHeader title="Send" />
          <View style={styles.doneWrap}>
            <SuccessAnimation title="Payment sent" subtitle={`${amount} ${assetCode} is on its way`} />
            <Text style={styles.hash} numberOfLines={1} testID="send-hash">
              {hash ? `tx ${truncateAddress(hash, 8, 8)}` : ''}
            </Text>
            <Pressable style={[styles.cta, styles.doneCta]} onPress={reset} testID="send-reset">
              <Text style={styles.ctaText}>Send another</Text>
            </Pressable>
          </View>
        </View>
      </SafeAreaView>
    );
  }

  return (
    <SafeAreaView style={styles.screen} edges={['top', 'bottom']} testID="send-screen">
      {/* Android too: with SDK 54's edge-to-edge, adjustResize is ignored and
          the keyboard covers focused fields without explicit avoidance. */}
      <KeyboardAvoidingView style={styles.flex} behavior={Platform.OS === 'ios' ? 'padding' : 'height'}>
      <ScrollView
        contentContainerStyle={styles.body}
        keyboardShouldPersistTaps="handled"
        keyboardDismissMode="on-drag"
        automaticallyAdjustKeyboardInsets
        showsVerticalScrollIndicator={false}
      >
        <FlowHeader title="Send" />

        {/* Asset */}
        <Text style={styles.section}>Asset</Text>
        <Pressable
          onPress={() => holdings.length > 0 && setAssetSheet(true)}
          accessibilityRole="button"
          style={({ pressed }) => [styles.card, styles.rowBetween, pressed && styles.pressed]}
        >
          <View style={styles.rowLeft}>
            <TokenIcon code={assetCode} size={34} />
            <View>
              <Text style={styles.assetCode}>{assetCode}</Text>
              <Text style={styles.assetSub}>
                {selected ? `${mask(fmtAmount(selected.balance))} available` : 'Loading…'}
              </Text>
            </View>
          </View>
          <ChevronDownIcon size={18} color={colors.textFaint} />
        </Pressable>

        {/* Source — shown whenever the contract holds some of this asset */}
        {contractAddr && held > 0 && (
          <>
            <Text style={styles.section}>From</Text>
            <View style={styles.sourceRow}>
              <Pressable
                onPress={() => setFromContract(false)}
                accessibilityRole="button"
                style={[styles.sourcePill, !fromContract && styles.sourcePillActive]}
              >
                <Text style={[styles.sourceText, !fromContract && styles.sourceTextActive]}>Spending</Text>
              </Pressable>
              <Pressable
                onPress={() => setFromContract(true)}
                accessibilityRole="button"
                style={[styles.sourcePill, fromContract && styles.sourcePillActive]}
              >
                <Text style={[styles.sourceText, fromContract && styles.sourceTextActive]}>
                  Smart wallet · {held.toLocaleString('en-US', { maximumFractionDigits: 2 })}{' '}
                  {selected?.code ?? 'XLM'}
                </Text>
              </Pressable>
            </View>
            {fromContract && (
              <Text style={styles.note}>
                Spends the contract&apos;s own balance — your passkey signature is verified on-chain.
              </Text>
            )}
          </>
        )}

        {/* Amount */}
        <Text style={styles.section}>Amount</Text>
        <View style={[styles.card, styles.amountCard]}>
          <View style={styles.amountRow}>
            <TextInput
              testID="send-amount"
              style={styles.amountInput}
              value={amount}
              onChangeText={setAmount}
              placeholder="0"
              placeholderTextColor={colors.textFaint}
              keyboardType="decimal-pad"
              editable={editable}
              textAlign="center"
            />
            <Text style={styles.amountUnit}>{assetCode}</Text>
          </View>
          <Text style={styles.amountFiat}>{fiatOfAmount ? `≈ ${fiatOfAmount}` : ' '}</Text>
          <Text style={[styles.balanceLine, insufficient && styles.balanceWarn]}>
            {(() => {
              // The balance of the chosen source, never the combined holding.
              // Quoting the total here is what let someone type an amount the
              // selected account could not cover.
              const shown =
                spendable === null ? null : (contractSource ? held : spendable).toFixed(4);
              if (shown === null) return 'Checking balance…';
              return insufficient
                ? `Not enough ${assetCode} — ${contractSource ? 'smart wallet has' : 'spending has'} ${mask(fmtAmount(shown))}`
                : `Balance ${mask(fmtAmount(shown))} ${assetCode}`;
            })()}
          </Text>
          <View style={styles.chips}>
            {QUICK.map((q) => {
              // Same basis as handleQuick, so the highlighted chip is the one
              // that actually produced the amount in the field.
              const target = (spendable ?? 0) * q.frac;
              const active = amtNum > 0 && Math.abs(amtNum - target) < Math.max(0.0001, target * 0.02);
              return (
                <Pressable
                  key={q.label}
                  onPress={() => handleQuick(q.frac)}
                  style={({ pressed }) => [styles.chip, active && styles.chipActive, pressed && styles.pressed]}
                >
                  <Text style={[styles.chipText, active && styles.chipTextActive]}>{q.label}</Text>
                </Pressable>
              );
            })}
          </View>
        </View>

        {/* To */}
        <Text style={styles.section}>To</Text>
        <View style={[styles.card, styles.rowBetween]}>
          <TextInput
            style={styles.toInput}
            testID="send-recipient"
            value={recipient}
            onChangeText={setRecipient}
            placeholder="Address or name*domain"
            placeholderTextColor={colors.textFaint}
            autoCapitalize="none"
            autoCorrect={false}
            editable={editable}
          />
          <View style={styles.toActions}>
            <Pressable onPress={() => setScannerOpen(true)} disabled={!editable} accessibilityLabel="Scan a QR code" style={styles.roundBtn}>
              <ScanIcon size={16} color={colors.textSecondary} />
            </Pressable>
            <Pressable onPress={() => setPickerOpen(true)} disabled={!editable} accessibilityLabel="Choose a contact" style={styles.roundBtn}>
              <UsersIcon size={16} color={colors.textSecondary} />
            </Pressable>
          </View>
        </View>
        {showError && (
          <Text style={styles.errorText}>Enter a valid Stellar address (G/M/C…) or federated address (name*domain).</Text>
        )}

        {/* Memo */}
        <Text style={styles.section}>Memo · optional</Text>
        <View style={styles.card}>
          <TextInput
            style={styles.memoInput}
            testID="send-memo"
            value={memo}
            onChangeText={setMemo}
            placeholder="Add a note for the recipient"
            placeholderTextColor={colors.textFaint}
            editable={editable}
          />
        </View>

        {/* Fee */}
        <View style={styles.feeRow}>
          <Text style={styles.feeLabel}>Network fee</Text>
          <Text style={styles.feeValue}>Sponsored</Text>
        </View>

        {step === 'error' && error && <Text style={styles.errorBanner}>{error}</Text>}
        {nonNative && (
          <Text style={styles.note}>
            Sending {assetCode} — the recipient needs a {assetCode} trustline, at a classic (G…) address.
          </Text>
        )}

        <View style={styles.spacer} />

        {busy ? (
          <View style={[styles.cta, styles.disabled]} testID="send-submit">
            <ActivityIndicator color={colors.onAccent} />
            <Text style={styles.ctaText}>{step === 'authorizing' ? 'Waiting for passkey…' : 'Submitting…'}</Text>
          </View>
        ) : canSubmit ? (
          <SlideToConfirm label="Slide to send" onConfirm={handleSend} />
        ) : (
          <View style={[styles.cta, styles.disabled]} testID="send-submit">
            <Text style={styles.ctaText}>
              {insufficient ? 'Not enough balance' : step === 'error' ? 'Try again' : 'Enter details to send'}
            </Text>
          </View>
        )}
      </ScrollView>
      </KeyboardAvoidingView>

      {/* Asset picker sheet */}
      <Modal visible={assetSheet} transparent animationType="fade" onRequestClose={() => setAssetSheet(false)}>
        <Pressable style={styles.backdrop} onPress={() => setAssetSheet(false)}>
          <Pressable style={[styles.sheet, { backgroundColor: isDark ? '#1C1C1E' : '#FFFFFF' }]} onPress={(e) => e.stopPropagation()}>
            <Text style={styles.sheetTitle}>Select asset</Text>
            {holdings.map((h) => {
              const isSel = selected ? keyOf(h) === keyOf(selected) : false;
              return (
                <Pressable
                  key={keyOf(h)}
                  onPress={() => { setSelectedKey(keyOf(h)); setAssetSheet(false); }}
                  style={({ pressed }) => [styles.sheetRow, pressed && styles.pressed]}
                >
                  <TokenIcon code={h.code} size={34} />
                  <View style={{ flex: 1 }}>
                    <Text style={styles.assetCode}>{h.code}</Text>
                    <Text style={styles.assetSub}>{h.name}</Text>
                  </View>
                  <Text style={[styles.sheetBal, isSel && { color: colors.accent }]}>{mask(fmtAmount(h.balance))}</Text>
                </Pressable>
              );
            })}
          </Pressable>
        </Pressable>
      </Modal>

      <QrScanner visible={scannerOpen} onScan={(address) => { setRecipient(address); setScannerOpen(false); }} onClose={() => setScannerOpen(false)} />
      <ContactPicker visible={pickerOpen} onSelect={handleSelectContact} onClose={() => setPickerOpen(false)} />
    </SafeAreaView>
  );
}

const createStyles = (colors: ThemeColors) =>
  StyleSheet.create({
    screen: { flex: 1, backgroundColor: colors.background },
    flex: { flex: 1 },
    body: { paddingHorizontal: 24, paddingTop: 16, paddingBottom: 40 },
    section: {
      color: colors.textFaint,
      fontFamily: fontFamily.bodySemiBold,
      fontSize: 11,
      letterSpacing: 1.4,
      textTransform: 'uppercase',
      marginTop: 22,
      marginBottom: 8,
    },
    card: {
      backgroundColor: colors.surface,
      borderWidth: 1,
      borderColor: colors.border,
      borderRadius: 16,
      paddingHorizontal: 16,
      paddingVertical: 13,
    },
    rowBetween: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
    rowLeft: { flexDirection: 'row', alignItems: 'center', gap: 12, flexShrink: 1 },
    assetCode: { color: colors.textPrimary, fontFamily: fontFamily.bodySemiBold, fontSize: 15 },
    assetSub: { color: colors.textFaint, fontFamily: fontFamily.address, fontSize: 12, marginTop: 1 },

    amountCard: { alignItems: 'center', paddingTop: 22, paddingBottom: 14 },
    amountRow: { flexDirection: 'row', alignItems: 'baseline', justifyContent: 'center', gap: 8 },
    amountInput: {
      color: colors.textStrong,
      fontFamily: fontFamily.heading,
      fontSize: 46,
      lineHeight: 52,
      minWidth: 60,
      padding: 0,
    },
    amountUnit: { color: colors.textSecondary, fontFamily: fontFamily.bodySemiBold, fontSize: 18 },
    amountFiat: { color: colors.textMuted, fontFamily: fontFamily.address, fontSize: 14, marginTop: 8 },
    balanceLine: { color: colors.textFaint, fontFamily: fontFamily.body, fontSize: 12, marginTop: 14 },
    balanceWarn: { color: colors.danger, fontFamily: fontFamily.bodyMedium },
    chips: { flexDirection: 'row', gap: 6, marginTop: 10, flexWrap: 'wrap', justifyContent: 'center' },
    chip: {
      borderWidth: 1,
      borderColor: colors.border,
      borderRadius: 100,
      paddingHorizontal: 12,
      paddingVertical: 5,
    },
    chipActive: { borderColor: 'rgba(253,218,36,0.4)', backgroundColor: 'rgba(253,218,36,0.08)' },
    chipText: { color: colors.textMuted, fontFamily: fontFamily.bodySemiBold, fontSize: 11 },
    chipTextActive: { color: colors.accent },

    sourceRow: { flexDirection: 'row', gap: 8 },
    sourcePill: {
      flexShrink: 1,
      borderWidth: 1,
      borderColor: colors.border,
      borderRadius: 100,
      paddingHorizontal: 14,
      paddingVertical: 9,
    },
    sourcePillActive: { borderColor: 'rgba(253,218,36,0.4)', backgroundColor: 'rgba(253,218,36,0.08)' },
    sourceText: { color: colors.textMuted, fontFamily: fontFamily.bodyMedium, fontSize: 12.5 },
    sourceTextActive: { color: colors.accent },
    toInput: { flex: 1, color: colors.textPrimary, fontFamily: fontFamily.address, fontSize: 15 },
    toActions: { flexDirection: 'row', gap: 8, flexShrink: 0 },
    roundBtn: {
      width: 30,
      height: 30,
      borderRadius: 15,
      alignItems: 'center',
      justifyContent: 'center',
      backgroundColor: colors.surfaceMd,
      borderWidth: 1,
      borderColor: colors.border,
    },
    memoInput: { color: colors.textPrimary, fontFamily: fontFamily.address, fontSize: 14, padding: 0 },
    errorText: { color: colors.danger, fontFamily: fontFamily.body, fontSize: 13, lineHeight: 18, marginTop: 8 },

    feeRow: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginTop: 18, paddingHorizontal: 4 },
    feeLabel: { color: colors.textMuted, fontFamily: fontFamily.body, fontSize: 13 },
    feeValue: { color: colors.positive, fontFamily: fontFamily.bodyMedium, fontSize: 13 },
    note: { color: colors.textMuted, fontFamily: fontFamily.body, fontSize: 12.5, lineHeight: 18, marginTop: 12, textAlign: 'center' },
    status: { flexDirection: 'row', alignItems: 'center', gap: 10, marginTop: 14 },
    statusText: { color: colors.textSecondary, fontFamily: fontFamily.body, fontSize: 14 },
    errorBanner: {
      color: colors.danger,
      fontFamily: fontFamily.body,
      fontSize: 13,
      backgroundColor: colors.dangerSurface,
      borderRadius: 10,
      padding: 12,
      marginTop: 14,
    },
    spacer: { height: 28 },
    cta: {
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'center',
      gap: 8,
      backgroundColor: colors.accent,
      borderRadius: 100,
      paddingVertical: 17,
      marginTop: 18,
    },
    disabled: { opacity: 0.4 },
    ctaText: { color: colors.onAccent, fontFamily: fontFamily.bodySemiBold, fontSize: 15 },

    doneWrap: { alignItems: 'center', marginTop: 52, gap: 20 },
    doneCta: { alignSelf: 'stretch', marginTop: 16 },
    resultCard: {
      backgroundColor: colors.surface,
      borderRadius: 20,
      borderWidth: 1,
      borderColor: colors.border,
      padding: 20,
      gap: 8,
      marginTop: 24,
    },
    resultTitle: { color: colors.textStrong, fontFamily: fontFamily.heading, fontSize: 22 },
    label: { color: colors.textFaint, fontFamily: fontFamily.body, fontSize: 13, marginTop: 6 },
    hash: { color: colors.accent, fontFamily: fontFamily.address, fontSize: 14 },
    pressed: { opacity: 0.6 },

    backdrop: { flex: 1, backgroundColor: 'rgba(0,0,0,0.6)', justifyContent: 'flex-end' },
    sheet: { backgroundColor: colors.surfaceMd, borderTopLeftRadius: 24, borderTopRightRadius: 24, padding: 20, paddingBottom: 40 },
    sheetTitle: { color: colors.textFaint, fontFamily: fontFamily.bodySemiBold, fontSize: 11, letterSpacing: 1.2, textTransform: 'uppercase', marginBottom: 8 },
    sheetRow: { flexDirection: 'row', alignItems: 'center', gap: 12, paddingVertical: 12 },
    sheetBal: { color: colors.textPrimary, fontFamily: fontFamily.address, fontSize: 14 },
  });
