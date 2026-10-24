/**
 * Buy airtime with crypto from this wallet.
 *
 * Screens b1–b5 of the design, built on the shared `BillFlow`
 * (`components/BillFlow.tsx` and `lib/billFlow.ts`).
 *
 * ## What lives here vs in `BillFlow`
 *
 * `BillFlow` owns the shared payment machinery — mainnet gating, per-coin rate
 * loading, `customerRef` and classic `G…` `refundAddress` resolution, the
 * one-time NIN verification bounce to `/verify`, `previewSpendFee` on the
 * confirm step before the passkey prompt, reserving the order first (`payBill`)
 * and spending the locked amount second (`spendAsset`), and polling
 * `getBillStatus` until delivered or refunded.
 *
 * This file holds only what is specific to airtime:
 *   - Nigerian mobile prefix detection (`MTN`, `AIRTEL`, `GLO`, `9MOBILE`) and
 *     the editable network chip row (since ported numbers must be overridable)
 *   - the 11-digit phone number input and contact picker (`pickContactNumber`)
 *   - the airtime copy and confirmation rows passed across the `BillFlow` seam
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import { Pressable, Text, TextInput, View } from 'react-native';

import { BillFlow, createBillFlowStyles } from '../components/BillFlow';
import { ContactIcon } from '../components/icons';
import { useTheme } from '../hooks/useTheme';
import type { BillCategoryConfig } from '../lib/billFlow';
import { pickContactNumber } from '../lib/pickContact';
import { useNetwork } from '../hooks/useNetwork';
import type { ThemeColors } from '../lib/theme';
import { fontFamily } from '../theme/typography';
import { errorMessage } from '../lib/errorMessage';
import { getAssetIssuer } from '../lib/assets';
import { getFeePayerAddress } from '../lib/activity';
import { NotEnoughToSend, previewSpendFee, spendAsset } from '../lib/spendAsset';
import { isPasskeyCancellation } from '../lib/passkeyOutcome';
import type { PlatformFee } from '../lib/platformFee';
import {
  getBillStatus,
  getCustomerRef,
  isNairaVerified,
  getOnrampRate,
  payBill,
  type NairaCoin,
} from '../lib/onramp';
import { classifyBillPollStatus } from '../lib/billFlow';

type Step = 'form' | 'confirm' | 'paying' | 'done' | 'failed';

const QUICK_AMOUNTS = [200, 500, 1000, 2000] as const;

/**
 * Nigerian mobile prefixes, so the network is detected rather than asked for.
 *
 * Detection is a *suggestion*: numbers are ported, and a ported number sent to
 * the wrong biller is a failed vend. So the picker stays visible and editable,
 * and the hint says where the guess came from.
 */
export const PREFIXES: Record<string, string[]> = {
  MTN: ['0803', '0806', '0703', '0706', '0813', '0816', '0810', '0814', '0903', '0906', '0913', '0916'],
  AIRTEL: ['0802', '0808', '0708', '0812', '0701', '0902', '0901', '0904', '0907', '0912'],
  GLO: ['0805', '0807', '0705', '0815', '0811', '0905', '0915'],
  '9MOBILE': ['0809', '0818', '0817', '0909', '0908'],
};

export const NETWORKS = Object.keys(PREFIXES);

export function detectNetwork(phone: string): string | null {
  const p = phone.replace(/\D/g, '');
  if (p.length < 4) return null;
  const prefix = p.slice(0, 4);
  for (const [network, list] of Object.entries(PREFIXES)) {
    if (list.includes(prefix)) return network;
  }
  return null;
}

export function isValidNigerianPhone(phoneDigits: string): boolean {
  return phoneDigits.length === 11 && phoneDigits.startsWith('0');
}

export function buildAirtimeCategoryConfig(params: {
  provider: string;
  phone: string;
}): BillCategoryConfig {
  const phoneDigits = params.phone.replace(/\D/g, '');
  const { provider } = params;
  return {
    category: 'airtime',
    title: 'Airtime',
    returnTo: '/airtime',
    provider,
    customerId: phoneDigits,
    customerValid: isValidNigerianPhone(phoneDigits),
    quickAmounts: QUICK_AMOUNTS,
    copy: {
      mainnetTitle: 'Switch to mainnet to buy airtime',
      mainnetHint:
        'Top-ups are vended against real crypto, so this only works on mainnet — there is no test mode. Switch network in Settings, then come back.',
      insufficientBalanceNoun: 'top-up',
      verifySummary: (amountFormatted) => `Airtime · ${amountFormatted} to ${params.phone}`,
      confirmQuestion: (amountFormatted) => `${amountFormatted} airtime to ${phoneDigits} costs`,
      confirmRows: [
        { label: 'Network', value: provider },
        { label: 'Phone', value: phoneDigits },
      ],
      refundNote: `If ${provider} can't complete the top-up, the full amount comes straight back to this wallet.`,
      payingTitle: 'Sending your top-up',
      payingHint: (amountFormatted) => `${provider} is vending ${amountFormatted} to ${phoneDigits}.`,
      payingWaitLabel: 'Waiting for the top-up…',
      payingSummaryLabel: 'Airtime',
      payingSummaryValue: (amountFormatted) => `${amountFormatted} · ${provider} ${phoneDigits}`,
      doneTitle: 'Airtime sent',
      doneHint: (amountFormatted) =>
        `${amountFormatted} is on ${phoneDigits}. It usually shows on the phone within a minute.`,
      doneRows: [{ label: 'Network', value: provider }],
      doneAgainLabel: 'Buy again',
      failedHint: (spentFormatted) =>
        `Your ${spentFormatted} is being returned to this wallet. No airtime was added to ${phoneDigits}.`,
      failedReasonLabel: `${provider} didn't complete the top-up`,
    },
  };
}

export default function AirtimeScreen() {
  const { colors } = useTheme();
  const styles = useMemo(() => createBillFlowStyles(colors), [colors]);

  const [provider, setProvider] = useState<string>('MTN');
  const [providerTouched, setProviderTouched] = useState(false);
  const [phone, setPhone] = useState('');
  const [contactError, setContactError] = useState<string | null>(null);

  const phoneDigits = phone.replace(/\D/g, '');
  const detected = detectNetwork(phone);

  // A detected network wins until the user overrides it. Ported numbers are why
  // the override exists at all.
  useEffect(() => {
    if (detected && !providerTouched) setProvider(detected);
  }, [detected, providerTouched]);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const [addr, ref] = await Promise.all([
        getFeePayerAddress().catch(() => null),
        getCustomerRef().catch(() => null),
      ]);
      if (cancelled) return;
      setRefundAddress(addr);
      setCustomerRef(ref);
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const loadRate = useCallback(async () => {
    if (mainnetOnly) return;
    setRateState('loading');
    try {
      // Per coin: the two are different prices, so switching the toggle has to
      // re-fetch rather than reuse whatever the other one quoted.
      setRate(await getOnrampRate(coin));
      setRateState('ready');
    } catch {
      setRate(null);
      setRateState('failed');
    }
  }, [mainnetOnly, coin]);

  useEffect(() => {
    void loadRate();
  }, [loadRate]);

  // Poll the vend result. Unlike the onramp, nothing on-chain says whether the
  // airtime landed — the deposit leaving this wallet is visible, the top-up is
  // not — so asking is the only way to know.
  useEffect(() => {
    if (!orderId || !customerRef || step !== 'paying' || !payHash) return;
    const check = async () => {
      try {
        const s = await getBillStatus(customerRef, orderId);
        // One classifier for every bill screen. This used to be an inline
        // regex that did not know "settled"/"disbursed" — the words Linq
        // actually ends a vend with — so a delivered top-up never left this
        // screen.
        const outcome = classifyBillPollStatus(s.status);
        if (outcome === 'done') setStep('done');
        if (outcome === 'failed') setStep('failed');
      } catch (err) {
        // Silent *to the user*: a failed poll is nothing they can act on, and
        // the payment has already left, so an error here would read as if it
        // had not. But silent to us as well is how a top-up that landed sat on
        // a spinner with no way to find out why — the status was fine, the
        // request never got there, and nothing anywhere said so.
        console.warn('[airtime] status poll failed:', errorMessage(err));
      }
    };
    void check();
    pollRef.current = setInterval(check, 10_000);
    return () => {
      if (pollRef.current) clearInterval(pollRef.current);
      pollRef.current = null;
    };
  }, [orderId, customerRef, step, payHash]);

  const ngn = Number(amountNGN.replace(/[^\d]/g, '')) || 0;
  const code = coin.toUpperCase();
  const cost = rate && ngn > 0 ? ngn / rate : 0;

  // Only on the confirm step: it reads two balances, and doing that on every
  // keystroke of the amount field would be a request per digit.
  useEffect(() => {
    if (step !== 'confirm' || cost <= 0) return;
    let cancelled = false;
    void (async () => {
      const issuer = coin === 'usdc' ? getAssetIssuer('USDC', 'mainnet') : null;
      const fee = await previewSpendFee({
        amount: String(cost),
        ...(issuer ? { asset: { code: 'USDC', issuer } } : {}),
      }).catch(() => null);
      if (!cancelled) setVeilFee(fee);
    })();
    return () => {
      cancelled = true;
    };
  }, [step, cost, coin]);
  const phoneDigits = phone.replace(/\D/g, '');

  /**
   * The one-time NIN check, which this screen never used to ask for.
   *
   * Linq refuses a bill from an unverified customer, so the old path let
   * someone fill in a phone number and an amount, tap through to confirm, and
   * meet "customer … has not completed KYC" at the moment they expected a
   * payment — which is the worst place to learn a rule exists. The check now
   * happens before the summary, and `/verify` is handed enough to bring them
   * back to exactly this airtime purchase.
   */
  const chooseContact = useCallback(async () => {
    const picked = await pickContactNumber();
    if (picked.ok) {
      setPhone(picked.phone);
      setContactError(null);
      return;
    }
    // A cancel is a decision, not a failure, and gets no message.
    if (picked.reason !== 'cancelled') setContactError(picked.message);
  }, []);

  const config = useMemo(
    () => buildAirtimeCategoryConfig({ provider, phone }),
    [provider, phone],
  );

  return (
    <BillFlow
      {...config}
      fieldError={contactError}
      onClearFieldError={() => setContactError(null)}
    >
      <Text style={styles.label}>NETWORK</Text>
      <View style={styles.networkRow}>
        {NETWORKS.map((n) => (
          <Pressable
            key={n}
            onPress={() => {
              setProvider(n);
              setProviderTouched(true);
            }}
            style={[styles.networkChip, provider === n && styles.networkChipActive]}
          >
            <Text style={[styles.networkText, provider === n && styles.networkTextActive]}>
              {n}
            </Text>
          </Pressable>
        ))}
      </View>

      <View style={styles.field}>
        <Text style={styles.label}>PHONE NUMBER</Text>
        <View style={styles.phoneRow}>
          <TextInput
            style={styles.phoneInput}
            value={phone}
            onChangeText={(t) => setPhone(t.replace(/[^\d]/g, '').slice(0, 11))}
            keyboardType="number-pad"
            placeholder="0803 512 4471"
            placeholderTextColor={colors.textMuted}
          />
          {/* Nobody remembers the number they are topping up. It is
              almost always someone else's, which is the whole reason
              this screen exists. */}
          <Pressable
            onPress={() => void chooseContact()}
            accessibilityRole="button"
            accessibilityLabel="Choose from contacts"
            hitSlop={8}
            style={({ pressed }) => [styles.contactBtn, pressed && styles.pressed]}
          >
            <ContactIcon size={17} color={colors.textSecondary} />
          </Pressable>
        </View>
        {detected ? (
          <Text style={styles.hint}>
            {detected} number, detected from {phoneDigits.slice(0, 4)}
            {providerTouched && provider !== detected ? ` — sending to ${provider}` : ''}
          </Text>
        ) : (
          <Text style={styles.hint}>
            Numbers get ported, so check the network above matches.
          </Text>
        )}
      </View>
    </BillFlow>
  );
}
