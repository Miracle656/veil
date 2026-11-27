import { errorMessage } from '../lib/errorMessage';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import * as ExpoRouter from 'expo-router';
import { useLocalSearchParams } from 'expo-router';
import {
  ActivityIndicator,
  KeyboardAvoidingView,
  Modal,
  Platform,
  Pressable,
  ScrollView,
  Share,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import QRCode from 'react-native-qrcode-svg';
import * as Clipboard from 'expo-clipboard';
import { StrKey } from '@stellar/stellar-sdk';

import { useTheme } from '../hooks/useTheme';
import { useCurrency } from '../hooks/useCurrency';
import { useHiddenAmounts } from '../hooks/useHiddenAmounts';
import type { ThemeColors } from '../lib/theme';
import { fontFamily } from '../theme/typography';
import { FlowHeader } from '../components/FlowHeader';
import { isFederatedAddress, isValidDestination } from '../lib/address';
import { resolveFederation } from '../lib/federation';
import { ContactPicker } from '../components/ContactPicker';
import { QrScanner } from '../components/QrScanner';
import type { Contact } from '../hooks/useContacts';
import { requireSigner } from '../lib/signer';
import { requirePasskey } from '../lib/passkey';
import { isPasskeyCancellation, PasskeyCeremonyError } from '../lib/passkeyOutcome';
import { fetchContractAssetBalance, getFeePayerAddress } from '../lib/activity';
import { sendAssetFromContract, getFeePayerSpendableXlm, getFeePayerXlm, type FeePayerXlm } from '../lib/contractSpend';
import { useWallet } from '../components/WalletProvider';
import { deployWalletIfNeeded } from '../lib/deployWallet';
import { sendPayment } from '../lib/sendPayment';
import { validateMemoText } from '../lib/memo';
import { validateMemo } from '../lib/sep7';
import { truncateAddress } from '../components/ui/AddressChip';
import { getWalletAddress } from '../lib/walletStore';
// TODO(#1003): remove platform limitation warning when multi-origin contract ships
import {
  FIRST_SPEND_LIMITATION_MESSAGE,
  isFirstSpend,
  markFirstSpendCompleted,
} from '../lib/platformLimitation';
import { loadHoldings, unitPrice, type Holding } from '../lib/holdings';
import { getNetworkName } from '../lib/network';
import { isRegistryCode, resolveRequestedAsset } from '../lib/requestedAsset';
import { ChevronDownIcon, CopyIcon, ScanIcon, ShareIcon, UsersIcon } from '../components/icons';
import { TokenIcon } from '../components/TokenIcon';
import { SuccessAnimation } from '../components/SuccessAnimation';
import { SlideToConfirm } from '../components/SlideToConfirm';
import { reclaimEscrowSafely } from '../lib/escrow';
import {
  BEARER_LINK_WARNING,
  CLAIM_LINK_RESERVE_XLM,
  DEFAULT_LINK_EXPIRY_SECONDS,
  LINK_EXPIRY_OPTIONS,
  MAX_CLAIM_LINK_NOTE_LENGTH,
  ONE_TIME_SHARE_WARNING,
  RECLAIM_DEVICE_KEY_WARNING,
  createSenderClaimLink,
  ensureClassicTrustlineForClaimLink,
  estimateClaimLinkCost,
  hasSmartWalletFundedConfirmation,
  loadSenderClaimLinksOnChain,
  markSenderLinkReclaimed,
  markSmartWalletFundedConfirmation,
  validateClaimLinkNote,
  type CreatedSenderClaimLink,
  type SenderCreatedLinkView,
  type SenderLinkChainStatus,
} from '../lib/sendClaimLink';

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

function nextConfirmationId(): string {
  return `link_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
}

function statusBadgeLabel(status: SenderLinkChainStatus): string {
  switch (status) {
    case 'unclaimed':
      return 'Unclaimed';
    case 'claimed':
      return 'Claimed';
    case 'expired':
      return 'Expired';
    case 'reclaimed':
      return 'Reclaimed';
    case 'status_unknown':
      return 'Could not be checked';
  }
}

const QUICK = [
  { label: '25%', frac: 0.25 },
  { label: '50%', frac: 0.5 },
  { label: '75%', frac: 0.75 },
  { label: 'Max', frac: 1 },
];

type SendMode = 'address' | 'link';
type Step = 'form' | 'authorizing' | 'submitting' | 'done' | 'error';

export default function SendScreen() {
  const { colors, isDark } = useTheme();
  const { format } = useCurrency();
  const { mask } = useHiddenAmounts();
  const { wallet } = useWallet();
  const styles = useMemo(() => createStyles(colors), [colors]);

  // Deep links land here prefilled: `to`, `amount`, `asset` + `issuer`, `memo` + `memo_type` (#704).
  const params = useLocalSearchParams<{
    to?: string;
    amount?: string;
    asset?: string;
    issuer?: string;
    memo?: string;
    memo_type?: string;
    mode?: string;
  }>();

  // A link the registry alone refuses (#791) fills in nothing, not even the
  // address: a half-applied request is how the wrong asset gets paid. A code
  // the registry does not know waits on holdings, so it is prefilled and
  // blocked below instead.
  const [refusedAtOpen] = useState(() => {
    const code = firstValue(params.asset) || undefined;
    const issuer = firstValue(params.issuer) || undefined;
    if (!code && !issuer) return false;
    if (code && issuer && !isRegistryCode(code)) return false;
    return !resolveRequestedAsset(code, issuer, getNetworkName()).ok;
  });
  const [mode, setMode] = useState<SendMode>(() =>
    firstValue(params.mode) === 'link' ? 'link' : 'address',
  );
  const [recipient, setRecipient] = useState(() => (refusedAtOpen ? '' : firstValue(params.to)));
  const [amount, setAmount] = useState(() => (refusedAtOpen ? '' : firstValue(params.amount)));
  const [memo, setMemo] = useState(() => (refusedAtOpen ? '' : firstValue(params.memo)));
  // SEP-7 memo kind (text/id/hash/return, #704): validated against the memo
  // before submit rather than silently defaulting to text.
  const [memoType, setMemoType] = useState(() => (refusedAtOpen ? null : firstValue(params.memo_type) || null));
  const [pickerOpen, setPickerOpen] = useState(false);
  const [scannerOpen, setScannerOpen] = useState(false);
  const [assetSheet, setAssetSheet] = useState(false);

  // Claim-link state (#1285).
  const [linkNote, setLinkNote] = useState('');
  const [linkExpirySeconds, setLinkExpirySeconds] = useState(DEFAULT_LINK_EXPIRY_SECONDS);
  const [confirmationId, setConfirmationId] = useState(nextConfirmationId);
  const [createdLink, setCreatedLink] = useState<CreatedSenderClaimLink | null>(null);
  const [copiedLink, setCopiedLink] = useState(false);
  const [createdLinks, setCreatedLinks] = useState<SenderCreatedLinkView[]>([]);
  const [reclaimingId, setReclaimingId] = useState<string | null>(null);
  const [stagedFromContract, setStagedFromContract] = useState(false);
  const linkSubmitLockRef = useRef(false);

  const [holdings, setHoldings] = useState<Holding[]>([]);
  const [holdingsLoaded, setHoldingsLoaded] = useState(false);
  const [selectedKey, setSelectedKey] = useState<string | null>(null);

  const [step, setStep] = useState<Step>('form');
  const [hash, setHash] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  // TODO(#1003): remove platform limitation warning when multi-origin contract ships
  const [isFirst, setIsFirst] = useState(false);

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
  /**
   * The spending account's XLM with its actual reserve. `null` until read, and
   * ignored if the read failed (it zeroes out rather than throwing).
   */
  const [spendingXlm, setSpendingXlm] = useState<FeePayerXlm | null>(null);

  const refreshCreatedLinks = useCallback(async () => {
    try {
      const fp = await getFeePayerAddress().catch(() => null);
      const stored = await getWalletAddress().catch(() => null);
      const classicSponsor = fp ?? (stored && stored.startsWith('G') ? stored : null);
      if (!classicSponsor) return;
      const items = await loadSenderClaimLinksOnChain(classicSponsor);
      setCreatedLinks(items);
    } catch {
      // Non-fatal: link creation still works even if Horizon history cannot be read right now.
    }
  }, []);

  useEffect(() => {
    let alive = true;
    (async () => {
      const address = await getWalletAddress().catch(() => null);
      if (!address) {
        if (alive) setHoldingsLoaded(true);
        return;
      }
      // TODO(#1003): remove platform limitation check when multi-origin contract ships
      isFirstSpend(address).then((first) => {
        if (alive) setIsFirst(first);
      }).catch(() => {});
      if (address.startsWith('C')) {
        if (alive) setContractAddr(address);
      }
      const hs = await loadHoldings(address).catch(() => [] as Holding[]);
      if (!alive) return;
      setHoldings(hs);
      setHoldingsLoaded(true);
    })();
    return () => {
      alive = false;
    };
  }, []);

  useEffect(() => {
    if (mode !== 'link') return;
    void refreshCreatedLinks();
  }, [mode, refreshCreatedLinks]);

  const keyOf = (h: Holding) => `${h.code}:${h.issuer ?? 'native'}`;

  // The asset a link asked for, resolved to an exact code:issuer or refused
  // (#791). Never matched on the code alone: that is how an impostor USDT0 —
  // or, if the real one is not held, plain XLM — gets paid instead.
  const requestedCode = firstValue(params.asset) || undefined;
  const requestedIssuer = firstValue(params.issuer) || undefined;
  const request = useMemo(
    () =>
      requestedCode || requestedIssuer
        ? resolveRequestedAsset(requestedCode, requestedIssuer, getNetworkName(), holdings)
        : null,
    [requestedCode, requestedIssuer, holdings],
  );
  // For a code outside the registry the answer depends on holdings, so do not
  // refuse before they have loaded.
  const requestPending =
    !!request && !request.ok && !holdingsLoaded && !!requestedCode && !isRegistryCode(requestedCode);
  const requested = request?.ok ? request.asset : null;
  const requestedHolding = requested
    ? holdings.find((h) => h.code === requested.code && h.issuer === requested.issuer)
    : undefined;
  // What the link is still blocking, until the user picks an asset themselves.
  const requestProblem =
    selectedKey !== null || requestPending
      ? null
      : request && !request.ok
        ? `Payment request refused. ${request.reason}`
        : requested && holdingsLoaded && !requestedHolding
          ? `This request is for ${requested.code} issued by ${requested.issuer}, which this wallet does not hold.`
          : null;

  // A link that asked for an asset gets exactly that asset or nothing; only the
  // user's own pick overrides it.
  const fromRequest = !request
    ? (holdings.find((h) => h.native) ?? holdings[0])
    : !request.ok
      ? undefined
      : requested
        ? requestedHolding
        : holdings.find((h) => h.native);
  const selected = holdings.find((h) => keyOf(h) === selectedKey) ?? fromRequest ?? null;
  const assetCode = selected?.code || requested?.code || 'XLM';

  const trimmed = recipient.trim();
  const recipientValid = isValidDestination(trimmed);
  const showError = mode === 'address' && trimmed.length > 0 && !recipientValid;

  const selectedCode = selected?.code;
  const selectedIssuer = selected?.issuer;
  const selectedNative = selected?.native;

  // The contract's balance OF THE SELECTED ASSET. Previously this only ever
  // read native XLM, so the smart wallet could not be chosen as the source for
  // anything else — the routing would use it, but nothing on screen said so.
  useEffect(() => {
    let alive = true;
    if (!contractAddr) return;
    const asset =
      selectedCode && !selectedNative && selectedIssuer
        ? { code: selectedCode, issuer: selectedIssuer }
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
  }, [contractAddr, selectedCode, selectedIssuer, selectedNative]);

  useEffect(() => {
    if (!selected?.native && mode !== 'link') return;
    let alive = true;
    void getFeePayerXlm().then((x) => {
      if (alive) setSpendingXlm(x);
    });
    return () => {
      alive = false;
    };
  }, [selected?.native, holdings, mode]);

  const editable = step === 'form' || step === 'error';
  const amtNum = Number(amount);
  const nonNative = !!selected && !selected.native;
  const balanceNum = selected ? Number(selected.balance) : 0;
  // Any asset the contract actually holds can be its source — a SAC transfer
  // is asset-agnostic and needs no trustline on the contract side.
  const held = contractHeld ?? 0;
  const contractSource = fromContract && !!contractAddr && (held > 0 || stagedFromContract);

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

  // A native send must leave the account's reserve behind: (2 + subentries) x
  // 0.5 XLM, read from the account. A flat 1.5 understated it — the recovery
  // entries alone are three subentries — so "Max" offered XLM the network would
  // refuse. The flat figure remains only as the fallback while that read is out.
  const nativeSpendable = (classic: number) =>
    spendingXlm && spendingXlm.balance > 0
      ? Math.min(classic, spendingXlm.spendable)
      : Math.max(0, classic - 1.5);
  const rawSpendable = contractSource
    ? stagedFromContract
      ? Math.max(held, amtNum)
      : held
    : selected && classicHeld !== null
      ? selected.native
        ? nativeSpendable(classicHeld)
        : classicHeld
      : null;

  // Creating a claimable balance locks 1 XLM of refundable reserve on the
  // classic account while the link is unclaimed. Deduct it when sending native
  // XLM from the classic account so "Max" offers an amount that actually lands.
  const spendable =
    mode === 'link' && !contractSource && selected?.native && rawSpendable !== null
      ? Math.max(0, rawSpendable - Number(CLAIM_LINK_RESERVE_XLM))
      : rawSpendable;

  const insufficient = spendable !== null && amtNum > 0 && amtNum > spendable;
  const memoError =
    mode === 'address' && memo ? (memoType ? validateMemo(memo, memoType) : validateMemoText(memo)) : null;
  const linkNoteError = mode === 'link' ? validateClaimLinkNote(linkNote) : null;
  const linkCost = useMemo(
    () => estimateClaimLinkCost(amount, assetCode),
    [amount, assetCode],
  );
  const canSubmit =
    mode === 'link'
      ? amtNum > 0 && editable && !insufficient && !!selected && !requestProblem && !linkNoteError
      : recipientValid && amtNum > 0 && editable && !insufficient && !!selected && !requestProblem && !memoError;

  const up = selected ? unitPrice(selected) : null;
  const fiatOfAmount = up !== null && isFinite(amtNum) && amtNum > 0 ? format(amtNum * up) : null;

  const handleSelectContact = useCallback((contact: Contact) => {
    setRecipient(contact.address);
    setPickerOpen(false);
  }, []);

  const bumpConfirmationSession = () => {
    setConfirmationId(nextConfirmationId());
    setStagedFromContract(false);
  };

  const handleQuick = (frac: number) => {
    // Off the SOURCE's spendable, not the combined holding. `spendable`
    // already carries the native reserve deduction, so Max is an amount the
    // chosen account can actually pay.
    if (spendable === null || !isFinite(spendable) || spendable <= 0) return;
    const usable = spendable * frac;
    setAmount(usable.toFixed(usable >= 1 ? 2 : 4));
    bumpConfirmationSession();
  };

  const handleCreateClaimLink = async () => {
    if (!canSubmit || linkSubmitLockRef.current) return;
    const noteErr = validateClaimLinkNote(linkNote);
    if (noteErr) {
      setError(noteErr);
      setStep('error');
      return;
    }
    if (nonNative && (!selected?.issuer || !StrKey.isValidEd25519PublicKey(selected.issuer))) {
      setError(`Cannot create a ${assetCode} claim link without a valid Stellar issuer address.`);
      setStep('error');
      return;
    }

    linkSubmitLockRef.current = true;
    setError(null);
    let movedFromSmartWalletThisAttempt = false;
    try {
      setStep('authorizing');

      const stored = await getWalletAddress().catch(() => null);
      await requirePasskey();
      const signer = await requireSigner();

      // When spending from the smart wallet contract, route the asset into the
      // classic signer first via the existing __check_auth contract spend path,
      // then create the Stellar claimable balance from that signer.
      //
      // If step 1 already settled on a previous attempt for this confirmationId
      // and step 2 failed, skip pulling from the smart wallet again on retry —
      // even if "Smart wallet" is still selected on screen.
      const alreadyFundedFromWallet =
        stagedFromContract || hasSmartWalletFundedConfirmation(confirmationId);

      if (stored?.startsWith('C') && !alreadyFundedFromWallet) {
        const spendAsset =
          nonNative && selected?.issuer
            ? { code: selected.code, issuer: selected.issuer }
            : undefined;
        const [liveContractBalance, fpSpendable] = await Promise.all([
          fetchContractAssetBalance(stored, spendAsset),
          getFeePayerSpendableXlm(),
        ]);
        const shouldPullFromContract =
          contractSource ||
          ((classicHeld ?? 0) < amtNum && amtNum <= liveContractBalance && liveContractBalance > 0);

        if (shouldPullFromContract) {
          if (amtNum > liveContractBalance) {
            throw new Error(
              `The smart wallet holds ${liveContractBalance.toFixed(2)} ${assetCode} — not enough for this amount.`,
            );
          }
          const requiredClassicXlm = Number(CLAIM_LINK_RESERVE_XLM) + (spendAsset ? 0.5 : 0);
          if (fpSpendable < Number(CLAIM_LINK_RESERVE_XLM)) {
            throw new Error(
              `Your Spending account needs at least ${requiredClassicXlm} XLM above its reserve to hold this claim link while unclaimed.`,
            );
          }
          if (spendAsset) {
            await ensureClassicTrustlineForClaimLink(signer, spendAsset);
          }
          await deployWalletIfNeeded(wallet.deploy, stored);
          setStep('submitting');
          await sendAssetFromContract(stored, signer.publicKey, amount, spendAsset);
          markSmartWalletFundedConfirmation(confirmationId);
          setStagedFromContract(true);
          movedFromSmartWalletThisAttempt = true;
        }
      }

      setStep('submitting');
      const created = await createSenderClaimLink({
        confirmationId,
        signer,
        amount,
        asset: nonNative && selected ? { code: selected.code, issuer: selected.issuer ?? null } : undefined,
        note: linkNote,
        expirySeconds: linkExpirySeconds,
      });

      setStagedFromContract(false);
      setCreatedLink(created);
      setHash(created.txHash);
      setStep('done');
      // TODO(#1003): remove platform limitation call when multi-origin contract ships
      void markFirstSpendCompleted(stored);
      void refreshCreatedLinks();
    } catch (err) {
      if (isPasskeyCancellation(err)) {
        setError(null);
        setStep('form');
        return;
      }
      const raw = err instanceof PasskeyCeremonyError ? err.message : errorMessage(err);
      const name = err instanceof Error ? err.name : '';
      const baseFriendly =
        name === 'NotFoundError' || /^not found$/i.test(raw.trim())
          ? 'Your fee-payer account has no XLM yet. Open Settings → Fund test XLM, then try again.'
          : raw;
      const friendly = movedFromSmartWalletThisAttempt
        ? `${amount} ${assetCode} was moved to your Spending account, but creating the link failed: ${baseFriendly} Slide again to finish creating the link without transferring from your smart wallet a second time.`
        : baseFriendly;
      setError(friendly);
      setStep('error');
    } finally {
      linkSubmitLockRef.current = false;
    }
  };

  const handleSend = async () => {
    if (mode === 'link') {
      await handleCreateClaimLink();
      return;
    }
    if (!canSubmit) return;
    if (memo) {
      const memoErr = memoType ? validateMemo(memo, memoType) : validateMemoText(memo);
      if (memoErr) {
        setError(memoErr);
        setStep('error');
        return;
      }
    }
    setError(null);
    try {
      setStep('authorizing');

      // A federated address is a lookup, not an address. `isValidDestination`
      // accepts `name*domain` so the field does not reject one, but every
      // sending path below needs an account — handing the raw string to the
      // transaction builder is what produced "Unsupported address type" for a
      // name Lobstr could pay perfectly well.
      //
      // Resolved once here so both the contract path and the fee-payer path
      // get the same answer, and a name that resolves differently between two
      // lookups cannot send to one account while the review screen showed
      // another.
      let destination = recipient.trim();
      if (isFederatedAddress(destination)) {
        try {
          const record = await resolveFederation(destination);
          destination = record.account_id;
        } catch (err) {
          throw new Error(
            err instanceof Error && err.message === 'address not found'
              ? `No wallet is registered for ${recipient.trim()}.`
              : `Could not look up ${recipient.trim()} — the name server did not answer.`,
          );
        }
      }

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
        void fpSpendable;

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
          // With the key the address was derived from, resolved from the
          // secure store or the on-chain recovery entries — see
          // lib/deployWallet.ts. The SDK alone looked in one storage slot a
          // recovered wallet never wrote, and refused.
          await deployWalletIfNeeded(wallet.deploy, stored);
          setStep('submitting');
          const txHash = await sendAssetFromContract(stored, destination, amount, spendAsset);
          setHash(txHash);
          setStep('done');
          // TODO(#1003): remove platform limitation call when multi-origin contract ships
          void markFirstSpendCompleted(stored);
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
        destination,
        amount,
        signer,
        memo,
        nonNative && selected ? { code: selected.code, issuer: selected.issuer } : undefined,
        memoType || undefined,
      );
      setHash(result.hash);
      setStep('done');
      // TODO(#1003): remove platform limitation call when multi-origin contract ships
      void markFirstSpendCompleted(stored);
    } catch (err) {
      // A dismissed prompt is a decision, not a failure. Put the user back on
      // the form they filled in, with no red banner and nothing submitted.
      if (isPasskeyCancellation(err)) {
        setError(null);
        setStep('form');
        return;
      }
      const raw = err instanceof PasskeyCeremonyError ? err.message : errorMessage(err);
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

  const handleReclaimFromList = async (item: SenderCreatedLinkView) => {
    if (!item.canReclaim || reclaimingId) return;
    setReclaimingId(item.balanceId);
    setError(null);
    try {
      await requirePasskey();
      const signer = await requireSigner();
      const outcome = await reclaimEscrowSafely({
        signer,
        balanceId: item.balanceId,
        expiresAt: item.expiresAt,
        assetCode: item.assetCode,
        assetIssuer: item.assetIssuer,
      });
      if (outcome.status !== 'reclaimed') {
        setError(outcome.message);
        setStep('error');
        if (outcome.status === 'already_claimed' || outcome.status === 'already_reclaimed') {
          await refreshCreatedLinks();
        }
        return;
      }
      await markSenderLinkReclaimed(signer.publicKey, item.balanceId);
      await refreshCreatedLinks();
    } catch (err) {
      if (!isPasskeyCancellation(err)) {
        setError(errorMessage(err));
        setStep('error');
      }
    } finally {
      setReclaimingId(null);
    }
  };

  const handleShareCreatedLink = async () => {
    if (!createdLink) return;
    await Share.share({
      message: createdLink.claimUrl,
      title: `Claim ${createdLink.amount} ${createdLink.assetCode} on Veil`,
    });
  };

  const handleCopyCreatedLink = async () => {
    if (!createdLink) return;
    await Clipboard.setStringAsync(createdLink.claimUrl);
    setCopiedLink(true);
    setTimeout(() => setCopiedLink(false), 5000);
  };

  const reset = () => {
    setRecipient('');
    setAmount('');
    setMemo('');
    setMemoType(null);
    setLinkNote('');
    setCreatedLink(null);
    setCopiedLink(false);
    setStagedFromContract(false);
    setConfirmationId(nextConfirmationId());
    setStep('form');
    setHash(null);
    setError(null);
  };

  const busy = step === 'authorizing' || step === 'submitting';

  if (step === 'done') {
    if (mode === 'link' && createdLink) {
      return (
        <SafeAreaView style={styles.screen} edges={['top', 'bottom']} testID="send-screen">
          <ScrollView contentContainerStyle={styles.body} showsVerticalScrollIndicator={false}>
            <FlowHeader title="Claim link ready" />

            <View style={styles.bearerCard} testID="send-link-bearer-warning">
              <Text style={styles.bearerText}>{BEARER_LINK_WARNING}</Text>
            </View>

            <View style={[styles.card, styles.linkDoneCard]}>
              <Text style={styles.resultTitle}>
                {createdLink.amount} {createdLink.assetCode}
              </Text>
              {createdLink.note ? (
                <Text style={styles.linkDoneNote} testID="send-link-done-note">
                  {createdLink.note}
                </Text>
              ) : null}

              <View style={styles.qrWrap} testID="send-link-qr">
                <QRCode
                  value={createdLink.claimUrl}
                  size={168}
                  backgroundColor="#F6F7F8"
                  color="#0F0F0F"
                />
              </View>

              <View style={styles.shareActionsRow}>
                <Pressable
                  testID="send-link-share"
                  accessibilityRole="button"
                  onPress={() => void handleShareCreatedLink()}
                  style={({ pressed }) => [styles.cta, styles.flexBtn, pressed && styles.pressed]}
                >
                  <ShareIcon size={17} color={colors.onAccent} />
                  <Text style={styles.ctaText}>Share link</Text>
                </Pressable>
                <Pressable
                  testID="send-link-copy"
                  accessibilityRole="button"
                  onPress={() => void handleCopyCreatedLink()}
                  style={({ pressed }) => [styles.secondaryBtn, pressed && styles.pressed]}
                >
                  <CopyIcon size={17} color={colors.textPrimary} />
                  <Text style={styles.secondaryBtnText}>{copiedLink ? 'Copied' : 'Copy'}</Text>
                </Pressable>
              </View>

              <Text style={styles.reclaimKeyNote} testID="send-link-one-time-warning">
                {ONE_TIME_SHARE_WARNING}
              </Text>

              <View style={styles.costSummaryDone}>
                <View style={styles.costLine}>
                  <Text style={styles.feeLabel}>Locked in link</Text>
                  <Text style={styles.costVal}>
                    {createdLink.cost.amount} {createdLink.cost.assetCode}
                  </Text>
                </View>
                <View style={styles.costLine}>
                  <Text style={styles.feeLabel}>Refundable reserve</Text>
                  <Text style={styles.costVal}>{createdLink.cost.reserveXlm} XLM</Text>
                </View>
                <View style={styles.costLine}>
                  <Text style={styles.feeLabel}>Network fee paid</Text>
                  <Text style={styles.costVal}>{createdLink.cost.feeXlm} XLM</Text>
                </View>
              </View>
            </View>

            <Pressable style={[styles.cta, styles.doneCta]} onPress={reset} testID="send-reset">
              <Text style={styles.ctaText}>Create another link</Text>
            </Pressable>
          </ScrollView>
        </SafeAreaView>
      );
    }

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

        {/* Delivery mode: direct address vs bearer claim link (#1285) */}
        <View style={styles.modeSwitchRow} accessibilityRole="tablist">
          <Pressable
            testID="send-mode-address"
            accessibilityRole="tab"
            accessibilityState={{ selected: mode === 'address' }}
            disabled={!editable}
            onPress={() => {
              setMode('address');
              setError(null);
            }}
            style={[styles.modePill, mode === 'address' && styles.sourcePillActive]}
          >
            <Text style={[styles.sourceText, mode === 'address' && styles.sourceTextActive]}>
              To an address
            </Text>
          </Pressable>
          <Pressable
            testID="send-mode-link"
            accessibilityRole="tab"
            accessibilityState={{ selected: mode === 'link' }}
            disabled={!editable}
            onPress={() => {
              setMode('link');
              bumpConfirmationSession();
              setError(null);
            }}
            style={[styles.modePill, mode === 'link' && styles.sourcePillActive]}
          >
            <Text style={[styles.sourceText, mode === 'link' && styles.sourceTextActive]}>
              Send as a link
            </Text>
          </Pressable>
        </View>

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
                {selected
                  ? `${mask(fmtAmount(selected.balance))} available${selected.issuer ? ` · ${truncateAddress(selected.issuer)}` : ''}`
                  : holdingsLoaded ? 'Choose an asset' : 'Loading…'}
              </Text>
            </View>
          </View>
          <ChevronDownIcon size={18} color={colors.textFaint} />
        </Pressable>

        {/* Source — shown whenever the contract holds some of this asset */}
        {contractAddr && (held > 0 || stagedFromContract) && (
          <>
            <Text style={styles.section}>From</Text>
            <View style={styles.sourceRow}>
              <Pressable
                testID="send-source-spending"
                onPress={() => setFromContract(false)}
                accessibilityRole="button"
                style={[styles.sourcePill, !fromContract && styles.sourcePillActive]}
              >
                {/* Both sides carry their balance. Only the smart wallet did, so
                    a tester holding 8 could see the 2 in the contract but had to
                    work out the 6 in spending for themselves. */}
                <Text style={[styles.sourceText, !fromContract && styles.sourceTextActive]}>
                  Spending
                  {classicHeld !== null
                    ? ` · ${mask(classicHeld.toLocaleString('en-US', { maximumFractionDigits: 2 }))} ${selected?.code ?? 'XLM'}`
                    : ''}
                </Text>
              </Pressable>
              <Pressable
                testID="send-source-smart-wallet"
                onPress={() => setFromContract(true)}
                accessibilityRole="button"
                style={[styles.sourcePill, fromContract && styles.sourcePillActive]}
              >
                <Text style={[styles.sourceText, fromContract && styles.sourceTextActive]}>
                  Smart wallet · {mask(held.toLocaleString('en-US', { maximumFractionDigits: 2 }))}{' '}
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
              onChangeText={(val) => {
                setAmount(val);
                bumpConfirmationSession();
              }}
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
                spendable === null
                  ? null
                  : (contractSource && !stagedFromContract ? held : spendable).toFixed(4);
              if (shown === null) return 'Checking balance…';
              return insufficient
                ? `Not enough ${assetCode} — ${contractSource ? 'smart wallet has' : 'spending has'} ${mask(fmtAmount(shown))}`
                : !contractSource && selected?.native && classicHeld !== null && classicHeld - Number(shown) > 0.0001
                  ? // Say both: the account holds more than it can send, and
                    // quoting only one of the two reads as a wrong balance.
                    `Balance ${mask(fmtAmount(classicHeld.toFixed(4)))} ${assetCode} · ${mask(fmtAmount(shown))} can be sent`
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

        {mode === 'address' ? (
          <>
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
              <Text style={styles.errorText} testID="send-recipient-error">Enter a valid Stellar address (G/M/C…) or federated address (name*domain).</Text>
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
            {memoError && (
              <Text style={styles.errorText} testID="send-memo-error">
                {memoError}
              </Text>
            )}

            {/* Fee */}
            <View style={styles.feeRow}>
              <Text style={styles.feeLabel}>Network fee</Text>
              <Text style={styles.feeValue}>Sponsored</Text>
            </View>

            {/* The memo is how exchange deposits get credited: show it on the
                confirmation surface so a scanned SEP-7 memo is seen before submit (#704). */}
            {memo ? (
              <View style={styles.feeRow}>
                <Text style={styles.feeLabel}>Memo</Text>
                <Text style={styles.feeValue}>{memoType ? `${memo} (${memoType})` : memo}</Text>
              </View>
            ) : null}
          </>
        ) : (
          <>
            {/* Expiry window */}
            <Text style={styles.section}>Reclaim after</Text>
            <View style={styles.chipsLeft}>
              {LINK_EXPIRY_OPTIONS.map((opt) => {
                const selectedOpt = linkExpirySeconds === opt.seconds;
                return (
                  <Pressable
                    key={opt.id}
                    testID={`send-link-expiry-${opt.id}`}
                    accessibilityRole="button"
                    disabled={!editable}
                    onPress={() => {
                      setLinkExpirySeconds(opt.seconds);
                      bumpConfirmationSession();
                    }}
                    style={[styles.chip, selectedOpt && styles.chipActive]}
                  >
                    <Text style={[styles.chipText, selectedOpt && styles.chipTextActive]}>
                      {opt.label}
                    </Text>
                  </Pressable>
                );
              })}
            </View>

            {/* Locked-down plain-text note */}
            <Text style={styles.section}>Note · optional ({MAX_CLAIM_LINK_NOTE_LENGTH} chars max)</Text>
            <View style={styles.card}>
              <TextInput
                style={styles.memoInput}
                testID="send-link-note"
                value={linkNote}
                onChangeText={(val) => {
                  setLinkNote(val);
                  bumpConfirmationSession();
                }}
                maxLength={MAX_CLAIM_LINK_NOTE_LENGTH + 10}
                placeholder="Plain note shown on the claim screen (no links)"
                placeholderTextColor={colors.textFaint}
                editable={editable}
              />
            </View>
            {linkNoteError && (
              <Text style={styles.errorText} testID="send-link-note-error">
                {linkNoteError}
              </Text>
            )}

            {/* Full cost breakdown + explicit bearer & device-key reclaim disclosures */}
            <View style={[styles.card, styles.costCard]} testID="send-link-cost-card">
              <View style={styles.costLine}>
                <Text style={styles.feeLabel}>Amount</Text>
                <Text style={styles.costVal} testID="send-link-cost-amount">
                  {linkCost.amount} {linkCost.assetCode}
                </Text>
              </View>
              <View style={styles.costLine}>
                <Text style={styles.feeLabel}>Refundable link reserve</Text>
                <Text style={styles.costVal} testID="send-link-cost-reserve">
                  {linkCost.reserveXlm} XLM (returned on claim or reclaim)
                </Text>
              </View>
              <View style={styles.costLine}>
                <Text style={styles.feeLabel}>Network fee</Text>
                <Text style={styles.costVal} testID="send-link-cost-fee">
                  {linkCost.feeXlm} XLM
                </Text>
              </View>
              <Text style={styles.bearerInline} testID="send-link-preconfirm-bearer">
                {BEARER_LINK_WARNING}
              </Text>
              <Text style={styles.reclaimKeyNote} testID="send-link-reclaim-key-warning">
                {RECLAIM_DEVICE_KEY_WARNING}
              </Text>
            </View>
          </>
        )}

        {step === 'error' && error && (
          <Text style={styles.errorBanner} testID="send-error">
            {error}
          </Text>
        )}
        {requestProblem && <Text style={styles.errorBanner} accessibilityRole="alert">{requestProblem}</Text>}
        {mode === 'address' && nonNative && (
          <Text style={styles.note}>
            Sending {assetCode} — the recipient needs a {assetCode} trustline, at a classic (G…) address.
          </Text>
        )}

        <View style={styles.spacer} />

        {busy ? (
          <View
            style={[styles.cta, styles.disabled]}
            testID="send-submit"
            accessible={true}
            accessibilityRole="button"
            accessibilityState={{ disabled: true }}
            aria-disabled={true}
          >
            <ActivityIndicator color={colors.onAccent} />
            <Text style={styles.ctaText}>{step === 'authorizing' ? 'Waiting for passkey…' : 'Submitting…'}</Text>
          </View>
        ) : canSubmit ? (
          <>
            {/* TODO(#1003): remove platform limitation warning when multi-origin contract ships */}
            {isFirst && (
              <View testID="first-spend-limitation-notice" style={styles.firstSpendNotice}>
                <Text style={styles.firstSpendNoticeText}>
                  {FIRST_SPEND_LIMITATION_MESSAGE}
                </Text>
              </View>
            )}
            <SlideToConfirm
              label={mode === 'link' ? 'Slide to create link' : 'Slide to send'}
              onConfirm={handleSend}
              testID="send-submit"
            />
          </>
        ) : (
          <View
            style={[styles.cta, styles.disabled]}
            testID="send-submit"
            accessible={true}
            accessibilityRole="button"
            accessibilityState={{ disabled: true }}
            aria-disabled={true}
          >
            <Text style={styles.ctaText}>
              {requestProblem
                ? 'Choose an asset to send'
                : !selected
                  ? 'Choose an asset to send'
                  : insufficient
                    ? 'Not enough balance'
                    : step === 'error'
                      ? 'Try again'
                      : mode === 'link'
                        ? 'Enter an amount to create link'
                        : 'Enter details to send'}
            </Text>
          </View>
        )}

        {/* Sender's created claim links verified live on-chain (#1285) */}
        {mode === 'link' && createdLinks.length > 0 && (
          <View style={styles.createdListSection} testID="send-created-links-list">
            <View style={styles.rowBetween}>
              <Text style={styles.section}>Your created links (on-chain)</Text>
              <Pressable
                testID="send-open-claim-links"
                accessibilityRole="button"
                onPress={() => ExpoRouter.router?.push?.('/claim-links' as never)}
              >
                <Text style={styles.reclaimInlineText}>Tied-up reserves</Text>
              </Pressable>
            </View>
            {createdLinks.map((item) => (
              <View
                key={item.balanceId}
                style={[styles.card, styles.createdLinkRow]}
                testID={`send-created-link-${item.balanceId}`}
              >
                <View style={styles.rowBetween}>
                  <Text style={styles.assetCode}>
                    {item.amount} {item.assetCode}
                  </Text>
                  <Text
                    style={styles.createdStatus}
                    testID={`send-created-link-status-${item.balanceId}`}
                  >
                    {statusBadgeLabel(item.status)}
                  </Text>
                </View>
                {item.note ? <Text style={styles.assetSub}>{item.note}</Text> : null}
                {item.canReclaim && (
                  <Pressable
                    testID={`send-link-reclaim-${item.balanceId}`}
                    accessibilityRole="button"
                    disabled={reclaimingId === item.balanceId}
                    onPress={() => void handleReclaimFromList(item)}
                    style={({ pressed }) => [styles.reclaimInlineBtn, pressed && styles.pressed]}
                  >
                    <Text style={styles.reclaimInlineText}>
                      {reclaimingId === item.balanceId ? 'Reclaiming…' : 'Reclaim'}
                    </Text>
                  </Pressable>
                )}
              </View>
            ))}
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
                  onPress={() => {
                    setSelectedKey(keyOf(h));
                    bumpConfirmationSession();
                    setAssetSheet(false);
                  }}
                  style={({ pressed }) => [styles.sheetRow, pressed && styles.pressed]}
                >
                  <TokenIcon code={h.code} size={34} />
                  <View style={{ flex: 1 }}>
                    <Text style={styles.assetCode}>{h.code}</Text>
                    {/* The issuer tells apart two holdings that share a code. */}
                    <Text style={styles.assetSub}>
                      {h.issuer ? `${h.name} · ${truncateAddress(h.issuer)}` : h.name}
                    </Text>
                  </View>
                  <Text style={[styles.sheetBal, isSel && { color: colors.accent }]}>{mask(fmtAmount(h.balance))}</Text>
                </Pressable>
              );
            })}
          </Pressable>
        </Pressable>
      </Modal>

      {/* Filled from a scanned SEP-7 URI: memo → the memo field, amount →
          the amount field, and an asset only when it resolves to an exact
          code:issuer — a scanned code alone never overrides the selection (#704/#791). */}
      <QrScanner
        visible={scannerOpen}
        onScan={(address, details) => {
          setRecipient(address);
          if (details?.amount) setAmount(details.amount);
          // The memo survives scan → review → submit: it lands in the same
          // field the review row renders and `sendPayment` attaches (#704).
          if (details?.memo) setMemo(details.memo);
          if (details?.memoType) setMemoType(details.memoType);
          if (details?.assetCode) {
            const scanned = resolveRequestedAsset(
              details.assetCode,
              details.assetIssuer,
              getNetworkName(),
              holdings,
            );
            if (scanned.ok && scanned.asset) {
              const heldAsset = holdings.find(
                (h) => h.code === scanned.asset!.code && h.issuer === scanned.asset!.issuer,
              );
              if (heldAsset) setSelectedKey(keyOf(heldAsset));
            }
          }
          setScannerOpen(false);
        }}
        onClose={() => setScannerOpen(false)}
      />
      <ContactPicker visible={pickerOpen} onSelect={handleSelectContact} onClose={() => setPickerOpen(false)} />
    </SafeAreaView>
  );
}

const createStyles = (colors: ThemeColors) =>
  StyleSheet.create({
    screen: { flex: 1, backgroundColor: colors.background },
    flex: { flex: 1 },
    body: { paddingHorizontal: 24, paddingTop: 16, paddingBottom: 40 },
    modeSwitchRow: { flexDirection: 'row', gap: 8, marginTop: 14 },
    modePill: {
      flex: 1,
      alignItems: 'center',
      borderWidth: 1,
      borderColor: colors.border,
      borderRadius: 100,
      paddingHorizontal: 14,
      paddingVertical: 9,
    },
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
    chipsLeft: { flexDirection: 'row', gap: 8, flexWrap: 'wrap' },
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

    costCard: { marginTop: 18, gap: 8 },
    costLine: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', gap: 8 },
    costVal: { color: colors.textPrimary, fontFamily: fontFamily.address, fontSize: 13 },
    bearerInline: {
      color: colors.accentText,
      fontFamily: fontFamily.bodyMedium,
      fontSize: 12.5,
      marginTop: 4,
    },
    reclaimKeyNote: {
      color: colors.textMuted,
      fontFamily: fontFamily.body,
      fontSize: 12,
      lineHeight: 17,
    },

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
    flexBtn: { flex: 1, marginTop: 0 },
    secondaryBtn: {
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'center',
      gap: 8,
      borderWidth: 1,
      borderColor: colors.borderStrong,
      borderRadius: 100,
      paddingHorizontal: 18,
      paddingVertical: 16,
    },
    secondaryBtnText: {
      color: colors.textPrimary,
      fontFamily: fontFamily.bodySemiBold,
      fontSize: 14,
    },
    disabled: { opacity: 0.4 },
    ctaText: { color: colors.onAccent, fontFamily: fontFamily.bodySemiBold, fontSize: 15 },

    doneWrap: { alignItems: 'center', marginTop: 52, gap: 20 },
    doneCta: { alignSelf: 'stretch', marginTop: 16 },
    bearerCard: {
      marginTop: 18,
      backgroundColor: colors.surface,
      borderWidth: 1,
      borderColor: colors.accent,
      borderRadius: 14,
      paddingHorizontal: 16,
      paddingVertical: 12,
    },
    bearerText: {
      color: colors.accentText,
      fontFamily: fontFamily.bodySemiBold,
      fontSize: 14,
      textAlign: 'center',
    },
    linkDoneCard: { alignItems: 'center', gap: 14, marginTop: 14, paddingVertical: 20 },
    linkDoneNote: {
      color: colors.textSecondary,
      fontFamily: fontFamily.body,
      fontSize: 14,
      textAlign: 'center',
    },
    qrWrap: {
      padding: 14,
      borderRadius: 16,
      backgroundColor: '#F6F7F8',
    },
    shareActionsRow: {
      flexDirection: 'row',
      alignItems: 'center',
      alignSelf: 'stretch',
      gap: 10,
    },
    costSummaryDone: {
      alignSelf: 'stretch',
      borderTopWidth: 1,
      borderTopColor: colors.border,
      paddingTop: 12,
      gap: 6,
    },
    createdListSection: { marginTop: 10, gap: 8 },
    createdLinkRow: { gap: 6 },
    createdStatus: {
      color: colors.textSecondary,
      fontFamily: fontFamily.bodyMedium,
      fontSize: 12,
    },
    reclaimInlineBtn: {
      marginTop: 6,
      alignSelf: 'flex-start',
      borderWidth: 1,
      borderColor: colors.accent,
      borderRadius: 100,
      paddingHorizontal: 14,
      paddingVertical: 6,
    },
    reclaimInlineText: {
      color: colors.accentText,
      fontFamily: fontFamily.bodySemiBold,
      fontSize: 12,
    },
    resultCard: {
      backgroundColor: colors.surface,
      borderRadius: 20,
      borderWidth: 1,
      borderColor: colors.border,
      padding: 20,
      gap: 8,
      marginTop: 24,
    },
    resultTitle: { color: colors.textStrong, fontFamily: fontFamily.heading, fontSize: 28 },
    label: { color: colors.textFaint, fontFamily: fontFamily.body, fontSize: 13, marginTop: 6 },
    hash: { color: colors.accent, fontFamily: fontFamily.address, fontSize: 14 },
    pressed: { opacity: 0.6 },

    backdrop: { flex: 1, backgroundColor: 'rgba(0,0,0,0.6)', justifyContent: 'flex-end' },
    sheet: { backgroundColor: colors.surfaceMd, borderTopLeftRadius: 24, borderTopRightRadius: 24, padding: 20, paddingBottom: 40 },
    sheetTitle: { color: colors.textFaint, fontFamily: fontFamily.bodySemiBold, fontSize: 11, letterSpacing: 1.2, textTransform: 'uppercase', marginBottom: 8 },
    sheetRow: { flexDirection: 'row', alignItems: 'center', gap: 12, paddingVertical: 12 },
    sheetBal: { color: colors.textPrimary, fontFamily: fontFamily.address, fontSize: 14 },
    firstSpendNotice: {
      backgroundColor: colors.surface,
      borderWidth: 1,
      borderColor: colors.accent,
      borderRadius: 14,
      paddingHorizontal: 16,
      paddingVertical: 12,
      marginBottom: 14,
    },
    firstSpendNoticeText: {
      color: colors.accent,
      fontFamily: fontFamily.body,
      fontSize: 12,
      lineHeight: 18,
      textAlign: 'center',
    },
  });
