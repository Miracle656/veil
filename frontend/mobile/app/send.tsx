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
import { fetchContractXlm } from '../lib/activity';
import { sendXlmFromContract, getFeePayerSpendableXlm, isWalletDeployed } from '../lib/contractSpend';
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
  const [contractXlm, setContractXlm] = useState(0);
  const [fromContract, setFromContract] = useState(false);

  useEffect(() => {
    let alive = true;
    (async () => {
      const address = await getWalletAddress().catch(() => null);
      if (!address) return;
      if (address.startsWith('C')) {
        void fetchContractXlm(address).then((x) => {
          if (alive) {
            setContractAddr(address);
            setContractXlm(x);
          }
        });
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
  const editable = step === 'form' || step === 'error';
  const amtNum = Number(amount);
  const nonNative = !!selected && !selected.native;
  const balanceNum = selected ? Number(selected.balance) : 0;
  // The smart-wallet source only applies to native XLM.
  const contractSource = fromContract && !nonNative && !!contractAddr;
  // Native sends must leave ~1.5 XLM for the base reserve + fee.
  const spendable = contractSource
    ? contractXlm
    : selected
      ? selected.native
        ? Math.max(0, balanceNum - 1.5)
        : balanceNum
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
    if (!selected || !isFinite(balanceNum) || balanceNum <= 0) return;
    // Leave a little XLM for fees/reserve when maxing native.
    const usable = selected.native && frac === 1 ? Math.max(0, balanceNum - 1.5) : balanceNum * frac;
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
      if (!nonNative && stored?.startsWith('C')) {
        const [liveContractXlm, fpSpendable] = await Promise.all([
          fetchContractXlm(stored),
          getFeePayerSpendableXlm(),
        ]);
        const shouldUseContract =
          (contractSource && amtNum <= liveContractXlm) ||
          (amtNum > fpSpendable && amtNum <= liveContractXlm);
        if (shouldUseContract) {
          // The wallet contract must exist on-chain before __check_auth can run.
          // Creation computed the address counterfactually — deploy lazily here.
          if (!(await isWalletDeployed(stored))) {
            const secret = await getSignerSecret();
            if (!secret) throw new Error('No fee-payer key on this device to pay for deployment.');
            await wallet.deploy(secret);
          }
          setStep('submitting');
          const hash = await sendXlmFromContract(stored, recipient.trim(), amount);
          setHash(hash);
          setStep('done');
          return;
        }
        if (contractSource) {
          throw new Error(`The smart wallet holds ${liveContractXlm.toFixed(2)} XLM — not enough for this amount.`);
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

        {/* Source — only for smart wallets holding their own XLM */}
        {contractAddr && contractXlm > 0 && !nonNative && (
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
                  Smart wallet · {contractXlm.toLocaleString('en-US', { maximumFractionDigits: 0 })} XLM
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
              const shown = contractSource ? contractXlm.toFixed(2) : selected?.balance;
              return insufficient && shown
                ? `Not enough ${assetCode} — ${contractSource ? 'smart wallet has' : 'you have'} ${mask(fmtAmount(shown))}`
                : `Balance ${shown ? `${mask(fmtAmount(shown))} ${assetCode}` : '—'}`;
            })()}
          </Text>
          <View style={styles.chips}>
            {QUICK.map((q) => {
              const target = q.frac === 1 ? balanceNum : balanceNum * q.frac;
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
