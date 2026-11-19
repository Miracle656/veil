/**
 * One-tap claim onboarding and resumable state machine (#1284).
 *
 * Turns an inbound `/claim` link into a passkey, a recoverable wallet, a funded
 * fee payer, and settled money in one tap — without an account step, without
 * stranding non-PRF authenticators on a random fee payer, and with durable
 * checkpoints before and after every network/biometric boundary so an
 * interrupted claim always resumes cleanly.
 *
 * ## Fee-payer sponsorship cap
 *
 * A brand-new wallet has zero XLM, so its PRF-derived classic fee payer cannot
 * exist on Stellar or submit `claimClaimableBalance` until Veil funds it:
 *
 *   - `MAX_SPONSORED_CLAIM_XLM_PER_WALLET = '2'` (2.0 XLM ceiling: 1.0 XLM base
 *     reserve for the fee-payer G-account + 0.5 XLM for one issued-asset
 *     trustline such as USDC + 0.5 XLM fee and transient ephemeral-claimant
 *     sponsorship headroom; Tx 1 settles 100% of the claimed funds into the
 *     fee-payer immediately, and Tx 2 `accountMerge`s the zero-balance ephemeral
 *     account in the next ledger so Stellar Core's `op_seq_num_too_far` same-ledger
 *     merge rule is respected and the sponsorship reserve is released).
 *   - `MAX_SPONSORED_CLAIMS_PER_INSTALL = 1` (at most one sponsored onboarding
 *     per install, and only after verifying on Horizon that `balanceId` is a
 *     real, currently unclaimed `ClaimableBalance` and the fee payer holds less
 *     than `MIN_FUNDED_FEE_PAYER_XLM`).
 */
import AsyncStorage from '@react-native-async-storage/async-storage';
import {
  Asset,
  Horizon,
  Keypair,
  Operation,
  StrKey,
  TransactionBuilder,
} from '@stellar/stellar-sdk';
import { Buffer } from 'buffer';
import * as SecureStore from 'expo-secure-store';
import { Platform } from 'react-native';

import { fundWithFriendbot } from './classicWallet';
import { recordFeePayerSource } from './feePayerSource';
import { inclusionFee } from './fees';
import { horizonErrorMessage } from './horizonError';
import { getNetwork, getNetworkName, hydrateNetwork } from './network';
import { evaluatePrf, requirePasskey } from './passkey';
import { isPasskeyCancellation } from './passkeyOutcome';
import { FEE_PAYER_PRF_SALT } from './passkeyWallet';
import { writeBreadcrumbs } from './walletBreadcrumbs';
import {
  SDK_KEYS,
  getPasskeyId,
  getPasskeyPublicKey,
  getSignerSecret,
  getWalletAddress,
  hasUsableWallet,
  setPasskeyCredential,
  setPasskeyId,
  setSignerSecret,
  setWalletAddress,
} from './walletStore';

/** Maximum XLM Veil sponsors to onboard and settle a fresh claimer's fee payer. */
export const MAX_SPONSORED_CLAIM_XLM_PER_WALLET = '2';

/** Maximum number of Veil-sponsored fresh-wallet claims allowed per install. */
export const MAX_SPONSORED_CLAIMS_PER_INSTALL = 1;

/** Minimum XLM balance on the fee payer to settle a claim + transient sponsorship without new funding. */
export const MIN_FUNDED_FEE_PAYER_XLM = 1.5;

const PENDING_CLAIM_KEY = 'veil_pending_claim_v1';
const SPONSORED_CLAIM_COUNT_KEY = 'veil_sponsored_claim_count_v1';
const SDK_KEY_ID = 'invisible_wallet_key_id';

export const CLAIM_ALREADY_CLAIMED_MESSAGE = 'This link has already been claimed.';
export const CLAIM_STILL_WAITING_MESSAGE =
  'Your money is still waiting in this link. Tap Claim to finish.';
export const CLAIM_PRF_UNSUPPORTED_MESSAGE =
  'This passkey provider does not support WebAuthn PRF recovery, so Veil did not create a wallet that would be stranded on this device. Choose a passkey provider with PRF support (such as Google Password Manager or iCloud Keychain) — your money is still waiting in this link.';

export type ClaimCheckpointStage =
  | 'before_passkey'
  | 'after_passkey'
  | 'after_creation'
  | 'during_claim';

export type ClaimLinkParams = {
  balanceId: string;
  amount?: string;
  assetCode?: string;
  assetIssuer?: string | null;
  sender?: string | null;
  note?: string | null;
  expiresAt?: number | null;
  ephemeralSecret?: string | null;
};

export type PersistedClaimCheckpoint = {
  stage: ClaimCheckpointStage;
  link: ClaimLinkParams;
  /** Populated once `wallet.register()` succeeds (`after_passkey`) so resume never overwrites the key ID. */
  walletAddress?: string | null;
  publicKeyHex?: string | null;
  keyId?: string | null;
  feePayerPublicKey?: string | null;
  updatedAt: number;
};

export type ClaimPreviewState =
  | {
      status: 'ready';
      balanceId: string;
      amount: string;
      assetCode: string;
      assetIssuer: string | null;
      senderLabel: string | null;
      note: string | null;
      expiresAt: number | null;
      hasExistingWallet: boolean;
      resumingStage: ClaimCheckpointStage | null;
      resumeNotice: string | null;
    }
  | {
      status: 'already_claimed';
      balanceId: string;
      message: string;
    }
  | {
      status: 'already_in_wallet';
      balanceId: string;
      walletAddress: string;
      message: string;
    }
  | {
      status: 'invalid_link';
      message: string;
    };

export type ExecuteClaimResult =
  | {
      status: 'claimed';
      txHash: string;
      walletAddress: string;
      feePayerAddress: string;
      amount: string;
      assetCode: string;
      createdNewWallet: boolean;
    }
  | {
      status: 'already_claimed';
      message: string;
    }
  | {
      status: 'prf_unsupported';
      message: string;
    }
  | {
      status: 'cancelled';
    };

export type RegisterableWallet = {
  register: (username?: string) => Promise<{ walletAddress: string; publicKeyBytes?: Uint8Array }>;
};

export class PrfUnsupportedClaimError extends Error {
  constructor(message = CLAIM_PRF_UNSUPPORTED_MESSAGE) {
    super(message);
    this.name = 'PrfUnsupportedClaimError';
  }
}

type ClaimFlowTestOverrides = {
  fetchImpl?: typeof fetch;
  sponsorEndpointUrl?: string | null;
};

let testOverrides: ClaimFlowTestOverrides = {};

export function configureClaimFlowForTests(overrides: ClaimFlowTestOverrides): void {
  testOverrides = overrides;
}

// Disallow schemes, protocol-relative URLs, bare hostnames/TLDs, Unicode dot
// confusables, IP literals, emails, HTML/entities, and Markdown links in any
// sender-supplied note/name rendered on the claim screen.
const UNSAFE_SCHEME_OR_MARKUP_RE =
  /\b(?:https?|ftp|mailto|tel|javascript|data|vbscript|file|veil|web\+stellar)\s*:|\/\/\S+|\bwww\.[a-z0-9-]+|[<>&`]|\[[^\]]*\]\([^)]*\)|!\[[^\]]*\]/i;
const UNSAFE_BARE_DOMAIN_OR_IP_RE =
  /(?:^|[\s(@])(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+(?:[a-z]{2,24}|xn--[a-z0-9-]{2,})(?=$|[\s/:?#),.!])|\b(?:\d{1,3}\.){3}\d{1,3}\b|\[[0-9a-f:]+\]|[a-z0-9-][\u3002\uFF0E\uFF61][a-z]{2,}/i;

export function sanitizeDisplayField(raw: string | null | undefined, maxLen: number): string | null {
  if (!raw) return null;
  const trimmed = raw.trim().replace(/[\u0000-\u001F\u007F]/g, '');
  if (!trimmed) return null;
  if (UNSAFE_SCHEME_OR_MARKUP_RE.test(trimmed) || UNSAFE_BARE_DOMAIN_OR_IP_RE.test(trimmed)) {
    return null;
  }
  return trimmed.length > maxLen ? trimmed.slice(0, maxLen) : trimmed;
}

/** Format an on-chain unix expiry timestamp for the recipient preview screen. */
export function formatClaimExpiryForRecipient(
  expiresAtUnix: number,
  nowUnix = Math.floor(Date.now() / 1000),
): string {
  const diff = expiresAtUnix - nowUnix;
  const abs = Math.max(0, Math.floor(Math.abs(diff)));
  const unit =
    abs < 60
      ? 'less than a minute'
      : abs < 3_600
        ? `${Math.floor(abs / 60)}m`
        : abs < 86_400
          ? `${Math.floor(abs / 3_600)}h`
          : `${Math.floor(abs / 86_400)}d`;
  if (diff <= 0) {
    return `Expired ${unit} ago — the sender can now reclaim this link`;
  }
  return `Claim within ${unit}`;
}

async function scopedSdkStorageKey(baseKey: string): Promise<string> {
  await hydrateNetwork();
  return getNetworkName() === 'mainnet' ? `${baseKey}_mainnet` : baseKey;
}

async function readScopedSdkKeyId(): Promise<string | null> {
  const scoped = await scopedSdkStorageKey(SDK_KEY_ID);
  const val = await AsyncStorage.getItem(scoped);
  if (val) return val;
  if (scoped !== SDK_KEY_ID) {
    return AsyncStorage.getItem(SDK_KEY_ID);
  }
  return null;
}

async function clearScopedSdkRegistrationKeys(): Promise<void> {
  await hydrateNetwork();
  const isMainnet = getNetworkName() === 'mainnet';
  const keysToClear = SDK_KEYS.map((k) => (isMainnet ? `${k}_mainnet` : k));
  await Promise.all(keysToClear.map((k) => AsyncStorage.removeItem(k).catch(() => undefined)));
}

function toHex(bytes: Uint8Array): string {
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}

async function writeEncryptedCheckpoint(value: PersistedClaimCheckpoint): Promise<void> {
  const serialized = JSON.stringify(value);
  if (Platform.OS === 'web') {
    await AsyncStorage.setItem(PENDING_CLAIM_KEY, serialized);
    return;
  }
  try {
    await SecureStore.setItemAsync(PENDING_CLAIM_KEY, serialized);
  } catch {
    await AsyncStorage.setItem(PENDING_CLAIM_KEY, serialized);
  }
}

async function readEncryptedCheckpoint(): Promise<PersistedClaimCheckpoint | null> {
  let raw: string | null = null;
  if (Platform.OS === 'web') {
    raw = await AsyncStorage.getItem(PENDING_CLAIM_KEY);
  } else {
    try {
      raw = await SecureStore.getItemAsync(PENDING_CLAIM_KEY);
    } catch {
      raw = null;
    }
    if (!raw) {
      raw = await AsyncStorage.getItem(PENDING_CLAIM_KEY).catch(() => null);
    }
  }
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as PersistedClaimCheckpoint;
    if (!parsed || typeof parsed !== 'object' || !parsed.link?.balanceId) return null;
    return parsed;
  } catch {
    return null;
  }
}

export async function clearPendingClaimCheckpoint(): Promise<void> {
  await Promise.all([
    SecureStore.deleteItemAsync(PENDING_CLAIM_KEY).catch(() => undefined),
    AsyncStorage.removeItem(PENDING_CLAIM_KEY).catch(() => undefined),
  ]);
}

export async function loadPendingClaimCheckpoint(): Promise<PersistedClaimCheckpoint | null> {
  return readEncryptedCheckpoint();
}

export async function savePendingClaimCheckpoint(
  stage: ClaimCheckpointStage,
  link: ClaimLinkParams,
  extra: Partial<Omit<PersistedClaimCheckpoint, 'stage' | 'link' | 'updatedAt'>> = {},
): Promise<PersistedClaimCheckpoint> {
  const existing = await readEncryptedCheckpoint();
  const mergedLink: ClaimLinkParams =
    existing && existing.link.balanceId === link.balanceId
      ? {
          balanceId: link.balanceId,
          amount: link.amount ?? existing.link.amount,
          assetCode: link.assetCode ?? existing.link.assetCode,
          assetIssuer: link.assetIssuer ?? existing.link.assetIssuer ?? null,
          sender: link.sender ?? existing.link.sender ?? null,
          note: link.note ?? existing.link.note ?? null,
          expiresAt: link.expiresAt ?? existing.link.expiresAt ?? null,
          ephemeralSecret: link.ephemeralSecret ?? existing.link.ephemeralSecret ?? null,
        }
      : link;

  const record: PersistedClaimCheckpoint = {
    stage,
    link: mergedLink,
    walletAddress:
      extra.walletAddress !== undefined ? extra.walletAddress : (existing?.walletAddress ?? null),
    publicKeyHex:
      extra.publicKeyHex !== undefined ? extra.publicKeyHex : (existing?.publicKeyHex ?? null),
    keyId: extra.keyId !== undefined ? extra.keyId : (existing?.keyId ?? null),
    feePayerPublicKey:
      extra.feePayerPublicKey !== undefined
        ? extra.feePayerPublicKey
        : (existing?.feePayerPublicKey ?? null),
    updatedAt: Date.now(),
  };

  await writeEncryptedCheckpoint(record);
  return record;
}

/**
 * Used by `app/index.tsx` on launch so a fresh install or interrupted claim
 * resumes straight onto `/claim` instead of dropping the user onto `/welcome`.
 */
export async function getPendingClaimResumeRoute(): Promise<string | null> {
  const pending = await readEncryptedCheckpoint();
  if (!pending?.link?.balanceId) return null;
  const pairs: [string, string][] = [['id', pending.link.balanceId]];
  if (pending.link.amount) pairs.push(['amount', pending.link.amount]);
  if (pending.link.assetCode) pairs.push(['asset', pending.link.assetCode]);
  if (pending.link.assetIssuer) pairs.push(['issuer', pending.link.assetIssuer]);
  if (pending.link.sender) pairs.push(['sender', pending.link.sender]);
  if (pending.link.note) pairs.push(['note', pending.link.note]);
  if (pending.link.expiresAt) pairs.push(['expires', String(pending.link.expiresAt)]);
  if (pending.link.ephemeralSecret) pairs.push(['s', pending.link.ephemeralSecret]);
  return `/claim?${pairs.map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`).join('&')}`;
}

function isNotFoundError(err: unknown): boolean {
  const status = (err as { response?: { status?: number } })?.response?.status;
  if (status === 404) return true;
  return err instanceof Error && err.name === 'NotFoundError';
}

function isClaimDoesNotExistError(err: unknown): boolean {
  if (isNotFoundError(err)) return true;
  const opCodes = (
    err as {
      response?: {
        data?: { extras?: { result_codes?: { operations?: string[] } } };
      };
    }
  )?.response?.data?.extras?.result_codes?.operations;
  return Array.isArray(opCodes) && opCodes.includes('op_does_not_exist');
}

function parseHorizonAsset(raw: string): { code: string; issuer: string | null } {
  if (!raw || raw === 'native') return { code: 'XLM', issuer: null };
  const colon = raw.indexOf(':');
  if (colon === -1) return { code: raw, issuer: null };
  return { code: raw.slice(0, colon), issuer: raw.slice(colon + 1) || null };
}

function extractExpiryFromClaimants(claimants: unknown): number | null {
  if (!Array.isArray(claimants)) return null;
  for (const item of claimants) {
    const notPred = (item as { predicate?: { not?: Record<string, unknown> } })?.predicate?.not;
    if (!notPred) continue;
    const epoch = notPred.abs_before_epoch ?? notPred.absBeforeEpoch;
    if (epoch !== undefined && epoch !== null) {
      const n = Number(epoch);
      if (Number.isFinite(n) && n > 0) return Math.floor(n);
    }
    if (typeof notPred.abs_before === 'string') {
      const ms = Date.parse(notPred.abs_before);
      if (Number.isFinite(ms) && ms > 0) return Math.floor(ms / 1000);
    }
  }
  return null;
}

async function resolveBalanceClaimant(
  server: Horizon.Server,
  balanceId: string,
): Promise<string | null> {
  try {
    const ops = (
      server as unknown as {
        operations?: () => {
          forClaimableBalance?: (id: string) => {
            order: (dir: 'asc' | 'desc') => {
              limit: (n: number) => {
                call: () => Promise<{ records?: Record<string, unknown>[] }>;
              };
            };
          };
        };
      }
    ).operations?.();
    const page = await ops?.forClaimableBalance?.(balanceId)?.order('desc').limit(5).call();
    const match = page?.records?.find((r) => r.type === 'claim_claimable_balance');
    if (!match) return null;
    return typeof match.claimant === 'string'
      ? match.claimant
      : typeof match.source_account === 'string'
        ? match.source_account
        : null;
  } catch {
    return null;
  }
}

async function isBalanceSettledIntoOurWallet(
  server: Horizon.Server,
  balanceId: string,
  ourFeePayerPubKey: string | null,
  ephemeralSecret: string | null | undefined,
): Promise<boolean> {
  if (!ourFeePayerPubKey) return false;
  const claimant = await resolveBalanceClaimant(server, balanceId);
  if (!claimant) return false;
  if (claimant === ourFeePayerPubKey) return true;
  if (ephemeralSecret && StrKey.isValidEd25519SecretSeed(ephemeralSecret)) {
    const ephemPub = Keypair.fromSecret(ephemeralSecret).publicKey();
    if (claimant === ephemPub) {
      // Confirm our fee-payer account exists on-chain (meaning our atomic merge landed).
      try {
        await server.loadAccount(ourFeePayerPubKey);
        return true;
      } catch {
        return false;
      }
    }
  }
  return false;
}

/**
 * Inspect the inbound claim link BEFORE firing any passkey/biometric prompt.
 *
 * Persists the link immediately so an install/restart or interrupted step can
 * resume, resolves on-chain amount/asset/sponsor from Horizon, and converts an
 * already-claimed link into a plain sentence rather than a network error.
 */
export async function inspectClaimBeforePrompt(
  rawLink: Partial<ClaimLinkParams>,
): Promise<ClaimPreviewState> {
  const existing = await readEncryptedCheckpoint();
  const balanceId = (rawLink.balanceId ?? existing?.link.balanceId ?? '').trim();
  if (!balanceId) {
    return {
      status: 'invalid_link',
      message: 'This claim link is missing its balance identifier.',
    };
  }

  const mergedLink: ClaimLinkParams = {
    balanceId,
    amount: rawLink.amount?.trim() || existing?.link.amount,
    assetCode: rawLink.assetCode?.trim().toUpperCase() || existing?.link.assetCode,
    assetIssuer: rawLink.assetIssuer?.trim() || existing?.link.assetIssuer || null,
    sender: sanitizeDisplayField(rawLink.sender ?? existing?.link.sender, 48),
    note: sanitizeDisplayField(rawLink.note ?? existing?.link.note, 80),
    expiresAt: rawLink.expiresAt ?? existing?.link.expiresAt ?? null,
    ephemeralSecret: rawLink.ephemeralSecret?.trim() || existing?.link.ephemeralSecret || null,
  };

  const resumingStage =
    existing && existing.link.balanceId === balanceId ? existing.stage : null;
  await savePendingClaimCheckpoint(resumingStage ?? 'before_passkey', mergedLink);

  const [walletReady, storedWallet, storedSecret] = await Promise.all([
    hasUsableWallet(),
    getWalletAddress().catch(() => null),
    getSignerSecret().catch(() => null),
  ]);
  const ourFeePayerPub =
    storedSecret && StrKey.isValidEd25519SecretSeed(storedSecret)
      ? Keypair.fromSecret(storedSecret).publicKey()
      : (existing?.feePayerPublicKey ?? null);

  const net = getNetwork();
  const server = new Horizon.Server(net.horizonUrl);

  try {
    const record = await (
      server as unknown as {
        claimableBalances: () => {
          claimableBalance: (id: string) => { call: () => Promise<Record<string, unknown>> };
        };
      }
    )
      .claimableBalances()
      .claimableBalance(balanceId)
      .call();

    const parsedAsset = parseHorizonAsset(String(record.asset ?? 'native'));
    const onChainAmount = typeof record.amount === 'string' ? record.amount.replace(/\.?0+$/, '') || '0' : null;
    const sponsor = typeof record.sponsor === 'string' ? record.sponsor : null;
    const expiresAt = extractExpiryFromClaimants(record.claimants) ?? mergedLink.expiresAt ?? null;

    const hydratedLink: ClaimLinkParams = {
      ...mergedLink,
      amount: onChainAmount ?? mergedLink.amount ?? '0',
      assetCode: parsedAsset.code || mergedLink.assetCode || 'XLM',
      assetIssuer: parsedAsset.issuer ?? mergedLink.assetIssuer ?? null,
      expiresAt,
    };
    await savePendingClaimCheckpoint(resumingStage ?? 'before_passkey', hydratedLink);

    const senderLabel =
      hydratedLink.sender ??
      (sponsor ? `${sponsor.slice(0, 6)}…${sponsor.slice(-4)}` : null);

    return {
      status: 'ready',
      balanceId,
      amount: hydratedLink.amount ?? '0',
      assetCode: hydratedLink.assetCode ?? 'XLM',
      assetIssuer: hydratedLink.assetIssuer ?? null,
      senderLabel,
      note: hydratedLink.note ?? null,
      expiresAt,
      hasExistingWallet: walletReady,
      resumingStage,
      resumeNotice: resumingStage ? CLAIM_STILL_WAITING_MESSAGE : null,
    };
  } catch (err) {
    if (isNotFoundError(err)) {
      const settledToUs = await isBalanceSettledIntoOurWallet(
        server,
        balanceId,
        ourFeePayerPub,
        mergedLink.ephemeralSecret,
      );
      await clearPendingClaimCheckpoint();
      if (settledToUs && storedWallet) {
        return {
          status: 'already_in_wallet',
          balanceId,
          walletAddress: storedWallet,
          message: 'Claim complete — the money is already in your wallet.',
        };
      }
      return {
        status: 'already_claimed',
        balanceId,
        message: CLAIM_ALREADY_CLAIMED_MESSAGE,
      };
    }

    // Transient Horizon read failure while offline/flaky: if link carries amount + asset,
    // keep the preview up and state plainly that the money is waiting rather than dead-ending.
    if (mergedLink.amount && mergedLink.assetCode) {
      return {
        status: 'ready',
        balanceId,
        amount: mergedLink.amount,
        assetCode: mergedLink.assetCode,
        assetIssuer: mergedLink.assetIssuer ?? null,
        senderLabel: mergedLink.sender ?? null,
        note: mergedLink.note ?? null,
        expiresAt: mergedLink.expiresAt ?? null,
        hasExistingWallet: walletReady,
        resumingStage,
        resumeNotice: CLAIM_STILL_WAITING_MESSAGE,
      };
    }
    throw err;
  }
}

async function readFeePayerNativeBalance(
  server: Horizon.Server,
  publicKey: string,
): Promise<{ exists: boolean; xlm: number; trustedAssets: Set<string> }> {
  try {
    const account = await server.loadAccount(publicKey);
    const balances = (account.balances ?? []) as {
      asset_type: string;
      asset_code?: string;
      asset_issuer?: string;
      balance: string;
    }[];
    const native = balances.find((b) => b.asset_type === 'native');
    const trusted = new Set<string>();
    for (const b of balances) {
      if (b.asset_code && b.asset_issuer) {
        trusted.add(`${b.asset_code}:${b.asset_issuer}`);
      }
    }
    return {
      exists: true,
      xlm: Number(native?.balance ?? '0'),
      trustedAssets: trusted,
    };
  } catch (err) {
    if (isNotFoundError(err)) {
      return { exists: false, xlm: 0, trustedAssets: new Set() };
    }
    throw err;
  }
}

/**
 * Fund the claimer's classic fee payer within Veil's documented sponsorship cap
 * (`MAX_SPONSORED_CLAIM_XLM_PER_WALLET = 2 XLM`, `MAX_SPONSORED_CLAIMS_PER_INSTALL = 1`).
 */
export async function ensureClaimFeePayerFunded(
  feePayerPublicKey: string,
  balanceId: string,
): Promise<void> {
  const net = getNetwork();
  const server = new Horizon.Server(net.horizonUrl);
  const current = await readFeePayerNativeBalance(server, feePayerPublicKey);
  if (current.exists && current.xlm >= MIN_FUNDED_FEE_PAYER_XLM) {
    return;
  }

  if (net.name === 'testnet' && net.friendbotUrl) {
    const funded = await fundWithFriendbot(feePayerPublicKey);
    if (funded) return;
  }

  const rawCount = await AsyncStorage.getItem(SPONSORED_CLAIM_COUNT_KEY).catch(() => null);
  const usedCount = rawCount ? Number(rawCount) : 0;
  if (Number.isFinite(usedCount) && usedCount >= MAX_SPONSORED_CLAIMS_PER_INSTALL) {
    throw new Error(
      `Fee-payer sponsorship cap reached (${MAX_SPONSORED_CLAIMS_PER_INSTALL} sponsored wallet per install, up to ${MAX_SPONSORED_CLAIM_XLM_PER_WALLET} XLM). Your money is still waiting in this link.`,
    );
  }

  const endpoint =
    testOverrides.sponsorEndpointUrl !== undefined
      ? testOverrides.sponsorEndpointUrl
      : (process.env['EXPO_PUBLIC_SPONSOR_CLAIM_URL']?.trim() ||
        'https://app.useveilapp.xyz/api/sponsor-claim');

  if (!endpoint) {
    throw new Error(
      'Fee-payer sponsorship is not configured on this build. Your money is still waiting in this link.',
    );
  }

  const fetchFn = testOverrides.fetchImpl ?? fetch;
  const response = await fetchFn(endpoint, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      address: feePayerPublicKey,
      balanceId,
      network: getNetworkName(),
      maxXlm: MAX_SPONSORED_CLAIM_XLM_PER_WALLET,
    }),
  });

  if (!response.ok) {
    throw new Error(
      'Could not fund the wallet fee payer right now. Reopen this link to finish claiming — your money is still waiting.',
    );
  }

  await AsyncStorage.setItem(SPONSORED_CLAIM_COUNT_KEY, String(usedCount + 1));
}

async function resolveOrCreatePrfWallet(
  wallet: RegisterableWallet,
  link: ClaimLinkParams,
): Promise<{ walletAddress: string; feePayer: Keypair; createdNewWallet: boolean }> {
  // Case 1: Device already has a usable wallet — reuse it without touching register().
  if (await hasUsableWallet()) {
    const [existingWallet, existingSecret, existingPasskeyId] = await Promise.all([
      getWalletAddress(),
      getSignerSecret(),
      getPasskeyId(),
    ]);
    if (existingPasskeyId) {
      await requirePasskey();
    }
    if (!existingWallet || !existingSecret) {
      throw new Error('Existing wallet is missing its signing key on this device.');
    }
    return {
      walletAddress: existingWallet,
      feePayer: Keypair.fromSecret(existingSecret),
      createdNewWallet: false,
    };
  }

  const checkpoint = await readEncryptedCheckpoint();

  // Case 2: Resuming after `wallet.register()` already succeeded (`after_passkey`),
  // BEFORE wallet commit. Never call `wallet.register()` again (which would
  // overwrite SDK_KEY_ID and strand the passkey); evaluate PRF directly on the saved keyId.
  let walletAddress =
    checkpoint?.link.balanceId === link.balanceId ? (checkpoint.walletAddress ?? null) : null;
  let publicKeyBytes: Uint8Array | undefined =
    checkpoint?.link.balanceId === link.balanceId && checkpoint.publicKeyHex
      ? new Uint8Array(Buffer.from(checkpoint.publicKeyHex, 'hex'))
      : undefined;
  let keyId =
    checkpoint?.link.balanceId === link.balanceId
      ? (checkpoint.keyId ?? (await readScopedSdkKeyId()))
      : null;

  if (!walletAddress || !keyId) {
    await savePendingClaimCheckpoint('before_passkey', link);
    const registered = await wallet.register('Veil wallet');
    walletAddress = registered.walletAddress;
    publicKeyBytes = registered.publicKeyBytes;
    keyId = await readScopedSdkKeyId();
    if (!keyId) {
      throw new Error('Passkey registration completed without storing a credential ID.');
    }
    await savePendingClaimCheckpoint('after_passkey', link, {
      walletAddress,
      publicKeyHex: publicKeyBytes ? toHex(publicKeyBytes) : null,
      keyId,
    });
  }

  // Strict PRF requirement (#1284 Trap #2): NEVER fall back to a random fee payer.
  let prfFeePayer: Keypair | null = null;
  let prfIssue: 'unsupported' | 'cancelled' | 'failed' = 'failed';
  for (let attempt = 0; attempt < 2 && !prfFeePayer; attempt++) {
    const prf = await evaluatePrf(keyId, FEE_PAYER_PRF_SALT);
    if (prf.outcome === 'ok' && prf.output) {
      prfFeePayer = Keypair.fromRawEd25519Seed(Buffer.from(prf.output.subarray(0, 32)));
    } else {
      prfIssue = prf.outcome === 'ok' ? 'unsupported' : prf.outcome;
      if (prfIssue === 'unsupported' || prfIssue === 'cancelled') break;
    }
  }

  if (!prfFeePayer) {
    if (prfIssue === 'unsupported') {
      // Clear network-scoped SDK registration keys and passkey checkpoint so the
      // user can choose a different, PRF-capable passkey provider on retry
      // without `excludeCredentials` blocking them.
      await clearScopedSdkRegistrationKeys();
      await savePendingClaimCheckpoint('before_passkey', link, {
        walletAddress: null,
        publicKeyHex: null,
        keyId: null,
      });
      throw new PrfUnsupportedClaimError();
    }
    if (prfIssue === 'cancelled') {
      const cancelErr = new Error('Passkey prompt cancelled');
      cancelErr.name = 'NotAllowedError';
      throw cancelErr;
    }
    throw new Error(
      'Passkey recovery check was interrupted before finishing. Tap Claim to resume — your money is still waiting.',
    );
  }

  // Commit the PRF-recoverable wallet to secure storage BEFORE funding/claiming so
  // an interruption during funding or settlement resumes at `after_creation`.
  await Promise.all([
    setWalletAddress(walletAddress),
    setSignerSecret(prfFeePayer.secret()),
    recordFeePayerSource(prfFeePayer.publicKey(), 'prf'),
    publicKeyBytes
      ? setPasskeyCredential(keyId, toHex(publicKeyBytes))
      : setPasskeyId(keyId),
  ]);

  await savePendingClaimCheckpoint('after_creation', link, {
    walletAddress,
    publicKeyHex: publicKeyBytes ? toHex(publicKeyBytes) : null,
    keyId,
    feePayerPublicKey: prfFeePayer.publicKey(),
  });

  return {
    walletAddress,
    feePayer: prfFeePayer,
    createdNewWallet: true,
  };
}

/**
 * Execute the full one-tap claim ceremony (or resume from whichever step was
 * previously interrupted):
 *   `before_passkey` -> `after_passkey` -> `after_creation` -> `during_claim` -> settled.
 */
export async function executeOneTapClaim(
  wallet: RegisterableWallet,
  rawLink: ClaimLinkParams,
): Promise<ExecuteClaimResult> {
  const existing = await readEncryptedCheckpoint();
  const link: ClaimLinkParams = {
    balanceId: rawLink.balanceId.trim(),
    amount: rawLink.amount ?? existing?.link.amount,
    assetCode: rawLink.assetCode ?? existing?.link.assetCode ?? 'XLM',
    assetIssuer: rawLink.assetIssuer ?? existing?.link.assetIssuer ?? null,
    sender: rawLink.sender ?? existing?.link.sender ?? null,
    note: rawLink.note ?? existing?.link.note ?? null,
    expiresAt: rawLink.expiresAt ?? existing?.link.expiresAt ?? null,
    ephemeralSecret: rawLink.ephemeralSecret ?? existing?.link.ephemeralSecret ?? null,
  };

  let resolved: { walletAddress: string; feePayer: Keypair; createdNewWallet: boolean };
  try {
    resolved = await resolveOrCreatePrfWallet(wallet, link);
  } catch (err) {
    if (err instanceof PrfUnsupportedClaimError) {
      return { status: 'prf_unsupported', message: err.message };
    }
    if (isPasskeyCancellation(err)) {
      return { status: 'cancelled' };
    }
    throw err;
  }

  const { walletAddress, feePayer, createdNewWallet } = resolved;

  await ensureClaimFeePayerFunded(feePayer.publicKey(), link.balanceId);

  const pubHex = await getPasskeyPublicKey().catch(() => null);
  const pubBytes =
    pubHex && /^[0-9a-fA-F]{130}$/.test(pubHex) ? new Uint8Array(Buffer.from(pubHex, 'hex')) : null;
  void writeBreadcrumbs(feePayer.secret(), walletAddress, pubBytes).catch(() => undefined);

  await savePendingClaimCheckpoint('during_claim', link, {
    walletAddress,
    feePayerPublicKey: feePayer.publicKey(),
  });

  const net = getNetwork();
  const server = new Horizon.Server(net.horizonUrl);

  // Check on-chain balance state before building the settlement transaction.
  // If a prior `during_claim` attempt actually landed before the connection dropped,
  // recognise the win rather than failing with 404.
  let claimAmount = link.amount ?? '0';
  let claimAssetCode = (link.assetCode ?? 'XLM').toUpperCase();
  let claimAssetIssuer = link.assetIssuer ?? null;

  try {
    const cbRecord = await (
      server as unknown as {
        claimableBalances: () => {
          claimableBalance: (id: string) => { call: () => Promise<Record<string, unknown>> };
        };
      }
    )
      .claimableBalances()
      .claimableBalance(link.balanceId)
      .call();
    const parsed = parseHorizonAsset(String(cbRecord.asset ?? 'native'));
    claimAssetCode = parsed.code;
    claimAssetIssuer = parsed.issuer;
    if (typeof cbRecord.amount === 'string') {
      claimAmount = cbRecord.amount.replace(/\.?0+$/, '') || '0';
    }
  } catch (err) {
    if (isNotFoundError(err)) {
      const settledToUs = await isBalanceSettledIntoOurWallet(
        server,
        link.balanceId,
        feePayer.publicKey(),
        link.ephemeralSecret,
      );
      if (settledToUs) {
        if (link.ephemeralSecret && StrKey.isValidEd25519SecretSeed(link.ephemeralSecret)) {
          const residualEphem = Keypair.fromSecret(link.ephemeralSecret);
          await mergeZeroBalanceEphemeralBestEffort(
            server,
            net.networkPassphrase,
            feePayer,
            residualEphem,
          );
        }
        await clearPendingClaimCheckpoint();
        return {
          status: 'claimed',
          txHash: 'settled',
          walletAddress,
          feePayerAddress: feePayer.publicKey(),
          amount: claimAmount,
          assetCode: claimAssetCode,
          createdNewWallet,
        };
      }
      await clearPendingClaimCheckpoint();
      return { status: 'already_claimed', message: CLAIM_ALREADY_CLAIMED_MESSAGE };
    }
    throw err;
  }

  const isIssued = claimAssetCode !== 'XLM' && Boolean(claimAssetIssuer);
  const stellarAsset =
    isIssued && claimAssetIssuer ? new Asset(claimAssetCode, claimAssetIssuer) : Asset.native();

  const feePayerSnapshot = await readFeePayerNativeBalance(server, feePayer.publicKey());
  const feePayerAccount = await server.loadAccount(feePayer.publicKey());

  const ephemeralKeypair =
    link.ephemeralSecret && StrKey.isValidEd25519SecretSeed(link.ephemeralSecret)
      ? Keypair.fromSecret(link.ephemeralSecret)
      : null;

  const builder = new TransactionBuilder(feePayerAccount, {
    fee: inclusionFee(),
    networkPassphrase: net.networkPassphrase,
  });

  if (isIssued && claimAssetIssuer && !feePayerSnapshot.trustedAssets.has(`${claimAssetCode}:${claimAssetIssuer}`)) {
    builder.addOperation(
      Operation.changeTrust({
        asset: stellarAsset,
        source: feePayer.publicKey(),
      }),
    );
  }

  const usesEphemeral =
    Boolean(ephemeralKeypair) && ephemeralKeypair!.publicKey() !== feePayer.publicKey();

  if (usesEphemeral && ephemeralKeypair) {
    const ephemPub = ephemeralKeypair.publicKey();
    // Stellar Core forbids `createAccount(X)` + `accountMerge(X)` in the same
    // ledger (`ACCOUNT_MERGE_SEQNUM_TOO_FAR` / `op_seq_num_too_far`). Instead,
    // Tx 1 sponsors `ephemPub` with `startingBalance: '0'`, claims the balance,
    // and immediately pays 100% of `claimAmount` (for both native XLM and issued
    // assets) to `feePayer` in one atomic ledger; Tx 2 then `accountMerge`s the
    // zero-balance `ephemPub` in the very next ledger to free the sponsorship.
    builder
      .addOperation(
        Operation.beginSponsoringFutureReserves({
          sponsoredId: ephemPub,
          source: feePayer.publicKey(),
        }),
      )
      .addOperation(
        Operation.createAccount({
          destination: ephemPub,
          startingBalance: '0',
          source: feePayer.publicKey(),
        }),
      );
    if (isIssued) {
      builder.addOperation(
        Operation.changeTrust({
          asset: stellarAsset,
          source: ephemPub,
        }),
      );
    }
    builder
      .addOperation(Operation.endSponsoringFutureReserves({ source: ephemPub }))
      .addOperation(
        Operation.claimClaimableBalance({
          balanceId: link.balanceId,
          source: ephemPub,
        }),
      )
      .addOperation(
        Operation.payment({
          destination: feePayer.publicKey(),
          asset: stellarAsset,
          amount: claimAmount,
          source: ephemPub,
        }),
      );
    if (isIssued) {
      builder.addOperation(
        Operation.changeTrust({
          asset: stellarAsset,
          limit: '0',
          source: ephemPub,
        }),
      );
    }
  } else {
    builder.addOperation(Operation.claimClaimableBalance({ balanceId: link.balanceId }));
  }

  const tx = builder.setTimeout(90).build();
  tx.sign(feePayer);
  if (usesEphemeral && ephemeralKeypair) {
    tx.sign(ephemeralKeypair);
  }

  try {
    const result = await server.submitTransaction(tx);
    if (usesEphemeral && ephemeralKeypair) {
      await mergeZeroBalanceEphemeralBestEffort(
        server,
        net.networkPassphrase,
        feePayer,
        ephemeralKeypair,
      );
    }
    await clearPendingClaimCheckpoint();
    return {
      status: 'claimed',
      txHash: result.hash,
      walletAddress,
      feePayerAddress: feePayer.publicKey(),
      amount: claimAmount,
      assetCode: claimAssetCode,
      createdNewWallet,
    };
  } catch (err) {
    if (isClaimDoesNotExistError(err)) {
      await clearPendingClaimCheckpoint();
      return { status: 'already_claimed', message: CLAIM_ALREADY_CLAIMED_MESSAGE };
    }
    const data = (err as { response?: { data?: unknown } })?.response?.data;
    const readable = horizonErrorMessage(data);
    throw new Error(
      readable
        ? `${readable} Reopen this link to resume — your money is still waiting.`
        : `${err instanceof Error ? err.message : 'Network error during claim.'} Reopen this link to resume — your money is still waiting.`,
    );
  }
}

async function mergeZeroBalanceEphemeralBestEffort(
  server: Horizon.Server,
  networkPassphrase: string,
  feePayer: Keypair,
  ephemeralKeypair: Keypair,
): Promise<void> {
  if (ephemeralKeypair.publicKey() === feePayer.publicKey()) return;
  try {
    const feePayerNext = await server.loadAccount(feePayer.publicKey());
    const mergeTx = new TransactionBuilder(feePayerNext, {
      fee: inclusionFee(),
      networkPassphrase,
    })
      .addOperation(
        Operation.accountMerge({
          destination: feePayer.publicKey(),
          source: ephemeralKeypair.publicKey(),
        }),
      )
      .setTimeout(60)
      .build();
    mergeTx.sign(feePayer);
    mergeTx.sign(ephemeralKeypair);
    await server.submitTransaction(mergeTx);
  } catch {
    // Best-effort post-settlement sponsorship cleanup: 100% of the claimed
    // funds are already in `feePayer` from Tx 1.
  }
}
