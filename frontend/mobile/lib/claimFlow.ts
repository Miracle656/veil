/**
 * One-tap resumable onboarding, fee-payer reserve verification, and Horizon
 * resume reconciliation for claim links (#1284).
 *
 * Stacked directly on #1356's claim primitives:
 * - On-chain link inspection delegates to `inspectClaimLinkForOpener()` (`lib/escrow.ts`).
 * - In-memory bearer secret handling delegates to `lib/deepLinks.ts`.
 * - On-chain claiming and Tx 2 reserve release delegate to
 *   `claimLinkWithSpendingAccount()` and `retryReleaseClaimReserve()` (`lib/sendClaimLink.ts`).
 * - Wallet creation and sign-in reuse `createPasskeyWallet()` (`lib/passkeyWallet.ts`)
 *   and `loginWithPasskey()` (`lib/passkeyLogin.ts`) — never a parallel registration path
 *   and never calling `recreatePasskeyWallet()` outside `app/create-wallet.tsx`.
 */
import * as SecureStore from 'expo-secure-store';
import { Horizon, Keypair, StrKey } from '@stellar/stellar-sdk';
import { Buffer } from 'buffer';
import { Platform } from 'react-native';

import { fundWithFriendbot } from './classicWallet';
import { clearClaimLinkSecret } from './deepLinks';
import {
  ALREADY_CLAIMED_MESSAGE,
  inspectClaimLinkForOpener,
  isNotFoundError,
  parseHorizonAsset,
  type OpenerLinkInspection,
} from './escrow';
import { getNetwork, type VeilNetworkName } from './network';
import { evaluatePrf } from './passkey';
import { loginWithPasskey } from './passkeyLogin';
import {
  createPasskeyWallet,
  FEE_PAYER_PRF_SALT,
  type PasskeyWalletResult,
} from './passkeyWallet';
import type { PrfOutcome } from './prfOutcome';
import {
  BASE_RESERVE_XLM,
  TRUSTLINE_RESERVE_COST_XLM,
  TRUSTLINE_TX_FEE_BUFFER_XLM,
} from './reserves';
import {
  claimLinkWithSpendingAccount,
  retryReleaseClaimReserve,
} from './sendClaimLink';
import { requireSigner } from './signer';
import type { WalletSigner } from './sendPayment';
import { hasUsableWallet } from './walletStore';

/**
 * Maximum XLM sponsored per newly onboarded wallet to cover Stellar reserves
 * and transaction fees during one-tap claiming.
 *
 * Peak reserve for a fresh 0-subentry spending account claiming an issued asset
 * (e.g. USDC) via a sponsored one-time claimant account is 3.1 XLM:
 *   1.0 XLM own base reserve
 * + 0.5 XLM recipient trustline
 * + 1.0 XLM transient sponsored ephemeral account (released in Tx 2 accountMerge)
 * + 0.5 XLM transient sponsored ephemeral trustline (closed in Tx 1)
 * + 0.1 XLM transaction fee headroom (`TRUSTLINE_TX_FEE_BUFFER_XLM`)
 * = 3.1 XLM peak (2.1 XLM for native XLM).
 *
 * The 3.5 XLM cap covers the 3.1 XLM peak with 0.4 XLM headroom for fee spikes
 * or a Tx 2 reserve-release retry.
 */
export const MAX_SPONSORED_CLAIM_XLM_PER_WALLET = '3.5';

/** Hard per-install cap on sponsored one-tap claim onboardings. */
export const MAX_SPONSORED_CLAIMS_PER_INSTALL = 1;

/** Pending claim checkpoints expire after 24 hours so an old link can never trap launch. */
export const PENDING_CLAIM_TTL_MS = 24 * 60 * 60 * 1000;

/** Plain mainnet disclosure when no opt-in sponsor endpoint is configured. */
export const CLAIM_MAINNET_SPONSOR_UNAVAILABLE_MESSAGE =
  'Creating a new mainnet wallet to claim a link requires XLM sponsorship, which is not enabled on this build yet. Sign in to an existing funded Veil wallet to claim these funds, or open this link again once mainnet sponsorship is live.';

const PENDING_CLAIM_STORAGE_KEY = 'veil_pending_claim_v1';
const SPONSORED_COUNT_STORAGE_KEY = 'veil_sponsored_claim_count_v1';

export type ClaimCheckpointStage =
  | 'before_passkey'
  | 'after_passkey'
  | 'after_creation'
  | 'during_claim';

export type PendingClaimCheckpoint = {
  balanceId: string;
  network?: VeilNetworkName;
  note?: string | null;
  amount?: string | null;
  assetCode?: string | null;
  assetIssuer?: string | null;
  ephemeralSecret?: string | null;
  stage: ClaimCheckpointStage;
  userInitiated: true;
  walletAddress?: string | null;
  passkeyId?: string | null;
  feePayerAddress?: string | null;
  createdNewWallet?: boolean;
  updatedAt: number;
};

export type PendingPrfWallet = Extract<PasskeyWalletResult, { status: 'unsupported' }>;
export type RegisterableWallet = Parameters<typeof createPasskeyWallet>[0];

export type OneTapClaimResult =
  | {
      status: 'claimed';
      txHash: string;
      reserveReleased: boolean;
      reserveReleaseTxHash?: string;
      reserveReleaseError?: string;
      amount: string;
      assetCode: string;
      assetIssuer: string | null;
      createdNewWallet: boolean;
      resumed?: boolean;
    }
  | {
      status: 'already_claimed';
      message: string;
    }
  | {
      status: 'prf_refused';
      issue: Exclude<PrfOutcome, 'ok'>;
      reason: string;
      pendingWallet: PendingPrfWallet;
    }
  | {
      status: 'funding_required';
      reason: string;
      requiredXlm: string;
      availableXlm: string;
      feePayerAddress: string | null;
    };

export type ClaimReserveInputs = {
  isIssuedAsset: boolean;
  recipientHasTrustline?: boolean;
  usesEphemeralClaimant?: boolean;
  ephemeralAccountExists?: boolean;
  ephemeralHasTrustline?: boolean;
  existingSubentries?: number;
  existingNumSponsoring?: number;
  existingNumSponsored?: number;
};

export type FeePayerFundingResult =
  | {
      funded: true;
      availableXlm: string;
      requiredXlm: string;
    }
  | {
      funded: false;
      availableXlm: string;
      requiredXlm: string;
      reason: string;
    };

export type SettledClaimLookup =
  | {
      claimedByRecipient: true;
      txHash: string;
      amount: string | null;
      assetCode: string | null;
      assetIssuer: string | null;
    }
  | {
      claimedByRecipient: false;
    };

// Memory-only checkpoint store used on Expo Web so bearer secrets are never
// written to localStorage, sessionStorage, or AsyncStorage.
let webMemoryCheckpoint: PendingClaimCheckpoint | null = null;
const webSponsoredCountByNetwork = new Map<VeilNetworkName, number>();

export function resetClaimFlowMemoryForTests(): void {
  webMemoryCheckpoint = null;
  webSponsoredCountByNetwork.clear();
}

/**
 * Exact Stellar peak XLM balance required on the recipient's Spending account
 * before submitting Tx 1 (`claimLinkWithSpendingAccount`), derived from
 * `lib/reserves.ts` constants.
 */
export function requiredClaimFeePayerXlm(opts: ClaimReserveInputs): number {
  const usesEphemeral = opts.usesEphemeralClaimant ?? true;
  const subentries = Math.max(0, opts.existingSubentries ?? 0);
  const numSponsoring = Math.max(0, opts.existingNumSponsoring ?? 0);
  const numSponsored = Math.max(0, opts.existingNumSponsored ?? 0);

  const ownBaseReserve = Math.max(0, 2 + subentries + numSponsoring - numSponsored) * BASE_RESERVE_XLM;
  const recipientTrustlineReserve =
    opts.isIssuedAsset && !opts.recipientHasTrustline ? TRUSTLINE_RESERVE_COST_XLM : 0;
  const ephemeralAccountReserve =
    usesEphemeral && !opts.ephemeralAccountExists ? 2 * BASE_RESERVE_XLM : 0;
  const ephemeralTrustlineReserve =
    usesEphemeral && opts.isIssuedAsset && !opts.ephemeralHasTrustline
      ? TRUSTLINE_RESERVE_COST_XLM
      : 0;

  return Number(
    (
      ownBaseReserve +
      recipientTrustlineReserve +
      ephemeralAccountReserve +
      ephemeralTrustlineReserve +
      TRUSTLINE_TX_FEE_BUFFER_XLM
    ).toFixed(7),
  );
}

/**
 * Resolve an explicitly configured HTTPS sponsor endpoint for mainnet one-tap
 * claim onboarding. Returns `null` by default (never calls an unshipped route).
 */
export function getClaimSponsorEndpoint(
  network: VeilNetworkName = getNetwork().name,
): string | null {
  if (network === 'testnet') return null;
  const raw = process.env.EXPO_PUBLIC_SPONSOR_CLAIM_URL?.trim();
  if (!raw || !/^https:\/\/[^/\s]+/i.test(raw)) {
    return null;
  }
  return raw;
}

/**
 * Whether a brand-new walletless install can have its Spending account funded
 * automatically on `network` (Friendbot on testnet, or an explicit opt-in
 * HTTPS sponsor endpoint on mainnet).
 */
export function isClaimSponsorshipAvailable(
  network: VeilNetworkName = getNetwork().name,
): boolean {
  if (network === 'testnet') {
    return Boolean(getNetwork().friendbotUrl);
  }
  return getClaimSponsorEndpoint('mainnet') !== null;
}

function isWebPlatform(): boolean {
  return Platform.OS === 'web';
}

function sponsorCountKey(network: VeilNetworkName): string {
  return `${SPONSORED_COUNT_STORAGE_KEY}_${network}`;
}

async function readSponsoredCount(network: VeilNetworkName): Promise<number> {
  if (isWebPlatform()) {
    return webSponsoredCountByNetwork.get(network) ?? 0;
  }
  try {
    const raw = await SecureStore.getItemAsync(sponsorCountKey(network));
    const parsed = raw ? Number.parseInt(raw, 10) : 0;
    return Number.isFinite(parsed) && parsed > 0 ? parsed : 0;
  } catch {
    return 0;
  }
}

async function incrementSponsoredCount(network: VeilNetworkName): Promise<void> {
  const next = (await readSponsoredCount(network)) + 1;
  if (isWebPlatform()) {
    webSponsoredCountByNetwork.set(network, next);
    return;
  }
  try {
    await SecureStore.setItemAsync(sponsorCountKey(network), String(next));
  } catch {
    // Non-fatal; never fall back to AsyncStorage.
  }
}

/**
 * Persist a user-initiated claim checkpoint.
 *
 * Security invariants:
 * - Only called after explicit user action (`userInitiated: true`), NEVER on
 *   passive link open.
 * - Written strictly to `expo-secure-store` on native (NO `AsyncStorage`
 *   fallback) and kept strictly in memory on Expo Web.
 */
export async function savePendingClaimCheckpoint(
  checkpoint: Omit<PendingClaimCheckpoint, 'updatedAt'> & { updatedAt?: number },
): Promise<boolean> {
  if (!checkpoint.userInitiated || !checkpoint.balanceId.trim()) {
    return false;
  }
  const normalized: PendingClaimCheckpoint = {
    ...checkpoint,
    balanceId: checkpoint.balanceId.trim(),
    userInitiated: true,
    updatedAt: checkpoint.updatedAt ?? Date.now(),
  };
  if (isWebPlatform()) {
    webMemoryCheckpoint = normalized;
    return true;
  }
  try {
    await SecureStore.setItemAsync(PENDING_CLAIM_STORAGE_KEY, JSON.stringify(normalized));
    return true;
  } catch {
    // Fail closed — never downgrade a checkpoint containing a bearer secret to AsyncStorage.
    return false;
  }
}

/**
 * Read an active, unexpired, user-initiated pending claim checkpoint.
 * Automatically clears expired or malformed records so no link can pin launch.
 */
export async function loadPendingClaimCheckpoint(
  nowMs = Date.now(),
): Promise<PendingClaimCheckpoint | null> {
  if (isWebPlatform()) {
    const cp = webMemoryCheckpoint;
    if (!cp) return null;
    if (!cp.userInitiated || nowMs - cp.updatedAt > PENDING_CLAIM_TTL_MS) {
      webMemoryCheckpoint = null;
      return null;
    }
    return cp;
  }
  try {
    const raw = await SecureStore.getItemAsync(PENDING_CLAIM_STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<PendingClaimCheckpoint> | null;
    if (
      !parsed ||
      parsed.userInitiated !== true ||
      typeof parsed.balanceId !== 'string' ||
      !parsed.balanceId.trim() ||
      typeof parsed.updatedAt !== 'number' ||
      !Number.isFinite(parsed.updatedAt)
    ) {
      await clearPendingClaimCheckpoint();
      return null;
    }
    if (nowMs - parsed.updatedAt > PENDING_CLAIM_TTL_MS) {
      await clearPendingClaimCheckpoint();
      return null;
    }
    return parsed as PendingClaimCheckpoint;
  } catch {
    return null;
  }
}

/** Remove any stored pending claim checkpoint. */
export async function clearPendingClaimCheckpoint(): Promise<void> {
  webMemoryCheckpoint = null;
  if (isWebPlatform()) return;
  try {
    await SecureStore.deleteItemAsync(PENDING_CLAIM_STORAGE_KEY);
  } catch {
    // Ignore storage deletion errors on cleanup.
  }
}

/** Clear both the in-memory bearer secret and any resumable claim checkpoint. */
export async function dismissPendingClaim(balanceId?: string): Promise<void> {
  clearClaimLinkSecret(balanceId);
  await clearPendingClaimCheckpoint();
}

/**
 * Return the in-app `/claim` route to resume an interrupted user-initiated
 * claim on app relaunch, or `null` when none is active.
 *
 * Security invariant: NEVER includes `s=` or the ephemeral bearer secret in
 * the returned route string.
 */
export async function getPendingClaimResumeRoute(nowMs = Date.now()): Promise<string | null> {
  const checkpoint = await loadPendingClaimCheckpoint(nowMs);
  if (!checkpoint) return null;
  const params: [string, string][] = [['id', checkpoint.balanceId]];
  if (checkpoint.network) {
    params.push(['network', checkpoint.network]);
  }
  if (checkpoint.note) {
    params.push(['note', checkpoint.note]);
  }
  const query = params
    .map(([key, value]) => `${encodeURIComponent(key)}=${encodeURIComponent(value)}`)
    .join('&');
  return `/claim?${query}`;
}

function prfRefusalMessage(issue: Exclude<PrfOutcome, 'ok'>): string {
  switch (issue) {
    case 'unsupported':
      return 'Your passkey provider did not return a PRF recovery secret, so Veil stopped before finishing one-tap setup instead of creating an unrecoverable random fee payer. Your funds are still safely waiting in the link. Open Create Wallet to choose a PRF-capable passkey provider or save a recovery file, or sign in to an existing wallet.';
    case 'cancelled':
      return 'The passkey recovery check was cancelled before finishing. Your funds are still safely waiting in the link — try the recovery check again without re-registering.';
    default:
      return 'The passkey recovery check did not complete. Your funds are still safely waiting in the link — try the recovery check again without re-registering.';
  }
}

type HorizonBalanceEntry = {
  asset_type?: string;
  asset_code?: string;
  asset_issuer?: string;
  balance?: string;
};

async function loadAccountOrNull(
  server: Horizon.Server,
  address: string,
): Promise<Horizon.AccountResponse | null> {
  try {
    return await server.loadAccount(address);
  } catch (err) {
    if (isNotFoundError(err)) return null;
    throw err;
  }
}

function nativeBalanceNumber(account: Horizon.AccountResponse | null): number {
  if (!account) return 0;
  const balances = (account.balances ?? []) as HorizonBalanceEntry[];
  const native = balances.find((b) => b.asset_type === 'native');
  const parsed = Number(native?.balance ?? '0');
  return Number.isFinite(parsed) ? parsed : 0;
}

function accountHasTrustline(
  account: Horizon.AccountResponse | null,
  assetCode: string | null,
  assetIssuer: string | null,
): boolean {
  if (!account || !assetCode || !assetIssuer) return false;
  const balances = (account.balances ?? []) as HorizonBalanceEntry[];
  return balances.some((b) => b.asset_code === assetCode && b.asset_issuer === assetIssuer);
}

/**
 * Ensure `feePayerAddress` holds at least the exact Stellar reserve + fee
 * headroom required by `requiredClaimFeePayerXlm()` before submitting Tx 1.
 *
 * - On testnet: funds via Friendbot when the account does not exist or falls
 *   short, then re-verifies on Horizon.
 * - On mainnet: posts ONLY to an explicitly configured HTTPS
 *   `EXPO_PUBLIC_SPONSOR_CLAIM_URL` (capped at `MAX_SPONSORED_CLAIMS_PER_INSTALL`
 *   and `MAX_SPONSORED_CLAIM_XLM_PER_WALLET`). When unconfigured, returns
 *   `funded: false` with exact XLM figures and makes zero sponsor HTTP calls.
 */
export async function ensureClaimFeePayerFunded(params: {
  feePayerAddress: string;
  balanceId: string;
  isIssuedAsset: boolean;
  assetCode?: string | null;
  assetIssuer?: string | null;
  ephemeralPublicKey?: string | null;
  allowSponsorship?: boolean;
}): Promise<FeePayerFundingResult> {
  const net = getNetwork();
  const server = new Horizon.Server(net.horizonUrl);

  const inspectBalances = async () => {
    const [feePayerAccount, ephemeralAccount] = await Promise.all([
      loadAccountOrNull(server, params.feePayerAddress),
      params.ephemeralPublicKey
        ? loadAccountOrNull(server, params.ephemeralPublicKey)
        : Promise.resolve(null),
    ]);

    const subentries = Number(
      (feePayerAccount as unknown as { subentry_count?: number } | null)?.subentry_count ?? 0,
    );
    const numSponsoring = Number(
      (feePayerAccount as unknown as { num_sponsoring?: number } | null)?.num_sponsoring ?? 0,
    );
    const numSponsored = Number(
      (feePayerAccount as unknown as { num_sponsored?: number } | null)?.num_sponsored ?? 0,
    );
    const required = requiredClaimFeePayerXlm({
      isIssuedAsset: params.isIssuedAsset,
      recipientHasTrustline: params.isIssuedAsset
        ? accountHasTrustline(feePayerAccount, params.assetCode ?? null, params.assetIssuer ?? null)
        : true,
      usesEphemeralClaimant: Boolean(params.ephemeralPublicKey),
      ephemeralAccountExists: ephemeralAccount !== null,
      ephemeralHasTrustline: params.isIssuedAsset
        ? accountHasTrustline(ephemeralAccount, params.assetCode ?? null, params.assetIssuer ?? null)
        : false,
      existingSubentries: subentries,
      existingNumSponsoring: numSponsoring,
      existingNumSponsored: numSponsored,
    });
    const available = nativeBalanceNumber(feePayerAccount);
    return { feePayerAccount, required, available };
  };

  let state = await inspectBalances();
  if (state.feePayerAccount && state.available >= state.required) {
    return {
      funded: true,
      availableXlm: state.available.toFixed(7).replace(/\.?0+$/, ''),
      requiredXlm: state.required.toFixed(2),
    };
  }

  const allowSponsorship = params.allowSponsorship ?? true;
  if (allowSponsorship && net.name === 'testnet' && net.friendbotUrl && !state.feePayerAccount) {
    const ok = await fundWithFriendbot(params.feePayerAddress);
    if (ok) {
      state = await inspectBalances();
      if (state.feePayerAccount && state.available >= state.required) {
        return {
          funded: true,
          availableXlm: state.available.toFixed(7).replace(/\.?0+$/, ''),
          requiredXlm: state.required.toFixed(2),
        };
      }
    }
  } else if (allowSponsorship && net.name === 'mainnet') {
    const sponsorUrl = getClaimSponsorEndpoint('mainnet');
    if (sponsorUrl) {
      const used = await readSponsoredCount('mainnet');
      if (used < MAX_SPONSORED_CLAIMS_PER_INSTALL) {
        const res = await fetch(sponsorUrl, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            address: params.feePayerAddress,
            balanceId: params.balanceId,
            network: net.name,
            maxXlm: MAX_SPONSORED_CLAIM_XLM_PER_WALLET,
          }),
        });
        if (res.ok) {
          await incrementSponsoredCount('mainnet');
          state = await inspectBalances();
          if (state.feePayerAccount && state.available >= state.required) {
            return {
              funded: true,
              availableXlm: state.available.toFixed(7).replace(/\.?0+$/, ''),
              requiredXlm: state.required.toFixed(2),
            };
          }
        }
      }
    }
  }

  const availableStr = state.available.toFixed(2);
  const requiredStr = state.required.toFixed(2);
  return {
    funded: false,
    availableXlm: availableStr,
    requiredXlm: requiredStr,
    reason:
      net.name === 'mainnet' && !getClaimSponsorEndpoint('mainnet')
        ? `Your Spending account has ${availableStr} XLM, but claiming this link needs at least ${requiredStr} XLM to cover the Stellar reserve and network fee (temporary sponsor reserves are released after claiming). Fund ${params.feePayerAddress} with XLM and try again.`
        : `Your Spending account has ${availableStr} XLM, which is below the ${requiredStr} XLM needed to cover Stellar reserves and fees for this claim.`,
  };
}

const HEX_TX_HASH_RE = /^[0-9a-f]{64}$/i;

/**
 * Resolve the real 64-character Horizon `transaction_hash` for an interrupted
 * claim that already settled Tx 1 on chain, verifying on-chain that
 * `recipientPublicKey` was the transaction source or payment destination.
 *
 * Never fabricates a placeholder hash such as `'settled'`.
 */
export async function resolveSettledClaimOnChain(params: {
  server: Horizon.Server;
  balanceId: string;
  ephemeralPublicKey: string;
  recipientPublicKey: string;
}): Promise<SettledClaimLookup> {
  const { server, balanceId, ephemeralPublicKey, recipientPublicKey } = params;
  const opsApi = (
    server as unknown as {
      operations?: () => {
        forClaimableBalance?: (id: string) => {
          order: (dir: 'asc' | 'desc') => {
            limit: (n: number) => {
              call: () => Promise<{ records?: Record<string, unknown>[] }>;
            };
          };
        };
        forTransaction?: (hash: string) => {
          limit: (n: number) => {
            call: () => Promise<{ records?: Record<string, unknown>[] }>;
          };
        };
      };
    }
  ).operations;

  if (typeof opsApi !== 'function') {
    return { claimedByRecipient: false };
  }

  try {
    const forBalance = opsApi.call(server).forClaimableBalance?.(balanceId);
    if (!forBalance) return { claimedByRecipient: false };
    const page = await forBalance.order('desc').limit(10).call();
    const records = Array.isArray(page?.records) ? page.records : [];

    let claimTxHash: string | null = null;
    let amount: string | null = null;
    let assetCode: string | null = null;
    let assetIssuer: string | null = null;
    let claimOpSourceMatchesRecipient = false;

    for (const op of records) {
      if (op.type === 'create_claimable_balance') {
        if (typeof op.amount === 'string' && !amount) {
          amount = op.amount;
        }
        if (typeof op.asset === 'string' && !assetCode) {
          const parsed = parseHorizonAsset(op.asset);
          assetCode = parsed.code;
          assetIssuer = parsed.issuer;
        }
      }
      if (op.type === 'claim_claimable_balance' && !claimTxHash) {
        const claimant =
          typeof op.claimant === 'string'
            ? op.claimant
            : typeof op.source_account === 'string'
              ? op.source_account
              : null;
        if (claimant !== ephemeralPublicKey && claimant !== recipientPublicKey) {
          continue;
        }
        const hash = typeof op.transaction_hash === 'string' ? op.transaction_hash.trim() : '';
        if (HEX_TX_HASH_RE.test(hash)) {
          claimTxHash = hash;
          claimOpSourceMatchesRecipient = op.source_account === recipientPublicKey;
        }
      }
    }

    if (!claimTxHash) {
      return { claimedByRecipient: false };
    }

    // Confirm on-chain that THIS wallet submitted Tx 1 or received the payment
    // in Tx 1, so a third party racing the same bearer link is never reported
    // as a successful claim for this user.
    let ownedByRecipient = claimOpSourceMatchesRecipient;

    const txApi = (
      server as unknown as {
        transactions?: () => {
          transaction?: (hash: string) => {
            call: () => Promise<{ source_account?: string }>;
          };
        };
      }
    ).transactions;

    if (!ownedByRecipient && typeof txApi === 'function') {
      try {
        const txRecord = await txApi.call(server).transaction?.(claimTxHash).call();
        if (txRecord?.source_account === recipientPublicKey) {
          ownedByRecipient = true;
        }
      } catch {
        // Fall through to transaction operation check below.
      }
    }

    if (!ownedByRecipient) {
      const forTx = opsApi.call(server).forTransaction?.(claimTxHash);
      if (forTx) {
        try {
          const txOpsPage = await forTx.limit(20).call();
          const txOps = Array.isArray(txOpsPage?.records) ? txOpsPage.records : [];
          for (const txOp of txOps) {
            if (txOp.type === 'payment' && txOp.to === recipientPublicKey) {
              ownedByRecipient = true;
              if (!amount && typeof txOp.amount === 'string') {
                amount = txOp.amount;
              }
              if (!assetCode) {
                if (txOp.asset_type === 'native') {
                  assetCode = 'XLM';
                  assetIssuer = null;
                } else if (typeof txOp.asset_code === 'string') {
                  assetCode = txOp.asset_code;
                  assetIssuer = typeof txOp.asset_issuer === 'string' ? txOp.asset_issuer : null;
                }
              }
              break;
            }
          }
        } catch {
          // Unable to verify ownership from tx operations.
        }
      }
    }

    if (!ownedByRecipient) {
      return { claimedByRecipient: false };
    }

    return {
      claimedByRecipient: true,
      txHash: claimTxHash,
      amount,
      assetCode,
      assetIssuer,
    };
  } catch {
    return { claimedByRecipient: false };
  }
}

async function reconcileSettledDuringClaim(params: {
  server: Horizon.Server;
  signer: WalletSigner;
  balanceId: string;
  ephemeralSecret: string;
  checkpoint: PendingClaimCheckpoint | null;
  createdNewWallet: boolean;
}): Promise<OneTapClaimResult | null> {
  const { server, signer, balanceId, ephemeralSecret, checkpoint, createdNewWallet } = params;
  const ephPub = Keypair.fromSecret(ephemeralSecret).publicKey();
  const settled = await resolveSettledClaimOnChain({
    server,
    balanceId,
    ephemeralPublicKey: ephPub,
    recipientPublicKey: signer.publicKey,
  });

  if (!settled.claimedByRecipient) {
    return null;
  }

  const amount = settled.amount ?? checkpoint?.amount ?? '0';
  const assetCode = settled.assetCode ?? checkpoint?.assetCode ?? 'XLM';
  const assetIssuer = settled.assetIssuer ?? checkpoint?.assetIssuer ?? null;

  const ephemeralAccount = await loadAccountOrNull(server, ephPub);
  if (!ephemeralAccount) {
    await dismissPendingClaim(balanceId);
    return {
      status: 'claimed',
      txHash: settled.txHash,
      reserveReleased: true,
      amount,
      assetCode,
      assetIssuer,
      createdNewWallet,
      resumed: true,
    };
  }

  // Ephemeral account still exists on chain (interrupted between Tx 1 and Tx 2).
  // If any balance remains on it, delegate to claimLinkWithSpendingAccount() to sweep;
  // otherwise run Tx 2 accountMerge via retryReleaseClaimReserve() while preserving
  // the real Tx 1 claim transaction hash.
  const ephBalances = (ephemeralAccount.balances ?? []) as HorizonBalanceEntry[];
  const hasUnsweptBalance = ephBalances.some((b) => Number(b.balance ?? '0') > 0);
  if (hasUnsweptBalance) {
    const swept = await claimLinkWithSpendingAccount({
      signer,
      balanceId,
      ephemeralSecret,
      linkNetwork: checkpoint?.network ?? null,
    });
    if (swept.status === 'claimed') {
      if (swept.reserveReleased) {
        await dismissPendingClaim(balanceId);
      }
      return {
        status: 'claimed',
        txHash: settled.txHash,
        reserveReleased: swept.reserveReleased,
        reserveReleaseTxHash: swept.reserveReleaseTxHash ?? swept.txHash,
        reserveReleaseError: swept.reserveReleaseError,
        amount: amount !== '0' ? amount : swept.amount,
        assetCode: assetCode || swept.assetCode,
        assetIssuer: assetIssuer ?? swept.assetIssuer,
        createdNewWallet,
        resumed: true,
      };
    }
  }

  const release = await retryReleaseClaimReserve({
    signer,
    ephemeralSecret,
  });
  if (release.released) {
    await dismissPendingClaim(balanceId);
    return {
      status: 'claimed',
      txHash: settled.txHash,
      reserveReleased: true,
      ...(release.txHash ? { reserveReleaseTxHash: release.txHash } : {}),
      amount,
      assetCode,
      assetIssuer,
      createdNewWallet,
      resumed: true,
    };
  }

  return {
    status: 'claimed',
    txHash: settled.txHash,
    reserveReleased: false,
    reserveReleaseError: release.error,
    amount,
    assetCode,
    assetIssuer,
    createdNewWallet,
    resumed: true,
  };
}

/**
 * Check whether an interrupted `during_claim` checkpoint already settled on
 * chain for the active wallet, resolving its real 64-character Horizon tx hash
 * and finishing Tx 2 reserve release if the one-time account is still unmerged.
 */
export async function resumeInterruptedClaimOnChain(params: {
  balanceId: string;
  ephemeralSecret: string;
  checkpoint?: PendingClaimCheckpoint | null;
}): Promise<OneTapClaimResult | null> {
  const cleanSecret = params.ephemeralSecret.trim();
  if (!StrKey.isValidEd25519SecretSeed(cleanSecret)) {
    return null;
  }
  const checkpoint = params.checkpoint ?? (await loadPendingClaimCheckpoint());
  if (!checkpoint || checkpoint.balanceId !== params.balanceId || checkpoint.stage !== 'during_claim') {
    return null;
  }
  const signer = await requireSigner();
  const net = getNetwork();
  const server = new Horizon.Server(net.horizonUrl);
  return reconcileSettledDuringClaim({
    server,
    signer,
    balanceId: params.balanceId,
    ephemeralSecret: cleanSecret,
    checkpoint,
    createdNewWallet: Boolean(checkpoint.createdNewWallet),
  });
}

async function submitClaimWithCheckpoints(params: {
  balanceId: string;
  ephemeralSecret: string;
  linkNetwork?: VeilNetworkName | null;
  note?: string | null;
  inspection?: OpenerLinkInspection | null;
  createdNewWallet: boolean;
  verifyFeePayerFunding: boolean;
  existingCheckpoint?: PendingClaimCheckpoint | null;
}): Promise<OneTapClaimResult> {
  const cleanSecret = params.ephemeralSecret.trim();
  if (!StrKey.isValidEd25519SecretSeed(cleanSecret)) {
    throw new Error(
      'This claim link is missing a valid bearer secret. Open the full link shared with you.',
    );
  }
  const signer = await requireSigner();
  const net = getNetwork();
  const server = new Horizon.Server(net.horizonUrl);
  const ephPub = Keypair.fromSecret(cleanSecret).publicKey();

  const checkpoint =
    params.existingCheckpoint !== undefined
      ? params.existingCheckpoint
      : await loadPendingClaimCheckpoint();
  const isResumingDuringClaim =
    checkpoint?.balanceId === params.balanceId && checkpoint.stage === 'during_claim';

  if (isResumingDuringClaim) {
    const inspected = await inspectClaimLinkForOpener(
      params.balanceId,
      { horizonUrl: net.horizonUrl, networkPassphrase: net.networkPassphrase },
      { linkNetwork: params.linkNetwork ?? null, activeNetwork: net.name },
    );
    if (inspected.state === 'claimed_by_other') {
      const reconciled = await reconcileSettledDuringClaim({
        server,
        signer,
        balanceId: params.balanceId,
        ephemeralSecret: cleanSecret,
        checkpoint,
        createdNewWallet: params.createdNewWallet,
      });
      if (reconciled) {
        return reconciled;
      }
      await dismissPendingClaim(params.balanceId);
      return { status: 'already_claimed', message: ALREADY_CLAIMED_MESSAGE };
    }
  }

  if (params.verifyFeePayerFunding) {
    const isIssuedAsset = Boolean(params.inspection?.assetIssuer);
    const funding = await ensureClaimFeePayerFunded({
      feePayerAddress: signer.publicKey,
      balanceId: params.balanceId,
      isIssuedAsset,
      assetCode: params.inspection?.assetCode ?? null,
      assetIssuer: params.inspection?.assetIssuer ?? null,
      ephemeralPublicKey: ephPub,
      allowSponsorship: params.createdNewWallet,
    });
    if (!funding.funded) {
      await savePendingClaimCheckpoint({
        balanceId: params.balanceId,
        network: params.linkNetwork ?? net.name,
        note: params.note ?? null,
        amount: params.inspection?.amount ?? checkpoint?.amount ?? null,
        assetCode: params.inspection?.assetCode ?? checkpoint?.assetCode ?? null,
        assetIssuer: params.inspection?.assetIssuer ?? checkpoint?.assetIssuer ?? null,
        ephemeralSecret: cleanSecret,
        stage: 'after_creation',
        userInitiated: true,
        feePayerAddress: signer.publicKey,
        createdNewWallet: params.createdNewWallet,
      });
      return {
        status: 'funding_required',
        reason: funding.reason,
        requiredXlm: funding.requiredXlm,
        availableXlm: funding.availableXlm,
        feePayerAddress: signer.publicKey,
      };
    }
  }

  await savePendingClaimCheckpoint({
    balanceId: params.balanceId,
    network: params.linkNetwork ?? net.name,
    note: params.note ?? null,
    amount: params.inspection?.amount ?? checkpoint?.amount ?? null,
    assetCode: params.inspection?.assetCode ?? checkpoint?.assetCode ?? null,
    assetIssuer: params.inspection?.assetIssuer ?? checkpoint?.assetIssuer ?? null,
    ephemeralSecret: cleanSecret,
    stage: 'during_claim',
    userInitiated: true,
    feePayerAddress: signer.publicKey,
    createdNewWallet: params.createdNewWallet,
  });

  const claimRes = await claimLinkWithSpendingAccount({
    signer,
    balanceId: params.balanceId,
    ephemeralSecret: cleanSecret,
    linkNetwork: params.linkNetwork ?? null,
  });

  if (claimRes.status === 'already_claimed') {
    const reconciled = await reconcileSettledDuringClaim({
      server,
      signer,
      balanceId: params.balanceId,
      ephemeralSecret: cleanSecret,
      checkpoint: {
        balanceId: params.balanceId,
        network: params.linkNetwork ?? net.name,
        amount: params.inspection?.amount ?? checkpoint?.amount ?? null,
        assetCode: params.inspection?.assetCode ?? checkpoint?.assetCode ?? null,
        assetIssuer: params.inspection?.assetIssuer ?? checkpoint?.assetIssuer ?? null,
        stage: 'during_claim',
        userInitiated: true,
        updatedAt: Date.now(),
      },
      createdNewWallet: params.createdNewWallet,
    });
    if (reconciled) {
      return reconciled;
    }
    await dismissPendingClaim(params.balanceId);
    return { status: 'already_claimed', message: claimRes.message };
  }

  if (claimRes.reserveReleased) {
    await dismissPendingClaim(params.balanceId);
  }

  return {
    status: 'claimed',
    txHash: claimRes.txHash,
    reserveReleased: claimRes.reserveReleased,
    reserveReleaseTxHash: claimRes.reserveReleaseTxHash,
    reserveReleaseError: claimRes.reserveReleaseError,
    amount: claimRes.amount,
    assetCode: claimRes.assetCode,
    assetIssuer: claimRes.assetIssuer,
    createdNewWallet: params.createdNewWallet,
  };
}

/**
 * One-tap create-wallet-and-claim entrypoint for fresh walletless installs.
 *
 * - Stops BEFORE creating any passkey on mainnet when no opt-in sponsor route
 *   is configured.
 * - Reuses `createPasskeyWallet()` (`lib/passkeyWallet.ts`) and NEVER calls
 *   `recreatePasskeyWallet()` or commits a random non-recoverable fee payer.
 * - Delegates on-chain claiming to `#1356`'s `claimLinkWithSpendingAccount()`.
 */
export async function createWalletAndClaim(params: {
  wallet: RegisterableWallet;
  balanceId: string;
  ephemeralSecret: string;
  linkNetwork?: VeilNetworkName | null;
  note?: string | null;
  inspection?: OpenerLinkInspection | null;
}): Promise<OneTapClaimResult> {
  const net = getNetwork();
  const existingCheckpoint = await loadPendingClaimCheckpoint();
  const matchingCheckpoint =
    existingCheckpoint?.balanceId === params.balanceId ? existingCheckpoint : null;

  // If the wallet was already created in an earlier attempt before interruption,
  // resume straight into funding & claiming without re-registering a second passkey.
  if (await hasUsableWallet().catch(() => false)) {
    return submitClaimWithCheckpoints({
      balanceId: params.balanceId,
      ephemeralSecret: params.ephemeralSecret,
      linkNetwork: params.linkNetwork,
      note: params.note,
      inspection: params.inspection,
      createdNewWallet: Boolean(matchingCheckpoint?.createdNewWallet),
      verifyFeePayerFunding: true,
      existingCheckpoint: matchingCheckpoint,
    });
  }

  if (!isClaimSponsorshipAvailable(net.name)) {
    const required = requiredClaimFeePayerXlm({
      isIssuedAsset: Boolean(params.inspection?.assetIssuer),
      usesEphemeralClaimant: true,
    });
    return {
      status: 'funding_required',
      reason: CLAIM_MAINNET_SPONSOR_UNAVAILABLE_MESSAGE,
      requiredXlm: required.toFixed(2),
      availableXlm: '0.00',
      feePayerAddress: null,
    };
  }

  await savePendingClaimCheckpoint({
    balanceId: params.balanceId,
    network: params.linkNetwork ?? net.name,
    note: params.note ?? null,
    amount: params.inspection?.amount ?? null,
    assetCode: params.inspection?.assetCode ?? null,
    assetIssuer: params.inspection?.assetIssuer ?? null,
    ephemeralSecret: params.ephemeralSecret.trim(),
    stage: 'before_passkey',
    userInitiated: true,
    createdNewWallet: true,
  });

  const created = await createPasskeyWallet(params.wallet);
  if (created.status === 'unsupported') {
    // Refuse to call `created.commit()` with a random fee payer and leave SDK
    // credential keys untouched so retrying PRF does not orphan a passkey.
    await savePendingClaimCheckpoint({
      balanceId: params.balanceId,
      network: params.linkNetwork ?? net.name,
      note: params.note ?? null,
      amount: params.inspection?.amount ?? null,
      assetCode: params.inspection?.assetCode ?? null,
      assetIssuer: params.inspection?.assetIssuer ?? null,
      ephemeralSecret: params.ephemeralSecret.trim(),
      stage: 'after_passkey',
      userInitiated: true,
      walletAddress: created.walletAddress,
      passkeyId: created.keyId,
      createdNewWallet: true,
    });
    return {
      status: 'prf_refused',
      issue: created.issue,
      reason: prfRefusalMessage(created.issue),
      pendingWallet: created,
    };
  }

  await savePendingClaimCheckpoint({
    balanceId: params.balanceId,
    network: params.linkNetwork ?? net.name,
    note: params.note ?? null,
    amount: params.inspection?.amount ?? null,
    assetCode: params.inspection?.assetCode ?? null,
    assetIssuer: params.inspection?.assetIssuer ?? null,
    ephemeralSecret: params.ephemeralSecret.trim(),
    stage: 'after_creation',
    userInitiated: true,
    walletAddress: created.wallet.address,
    createdNewWallet: true,
  });

  return submitClaimWithCheckpoints({
    balanceId: params.balanceId,
    ephemeralSecret: params.ephemeralSecret,
    linkNetwork: params.linkNetwork,
    note: params.note,
    inspection: params.inspection,
    createdNewWallet: true,
    verifyFeePayerFunding: true,
    existingCheckpoint: null,
  });
}

/**
 * Retry WebAuthn PRF evaluation against the pending passkey credential returned
 * by `createPasskeyWallet()` after a transient cancellation or failure, without
 * re-registering a second passkey.
 */
export async function retryPendingPrfAndClaim(params: {
  pendingWallet: PendingPrfWallet;
  balanceId: string;
  ephemeralSecret: string;
  linkNetwork?: VeilNetworkName | null;
  note?: string | null;
  inspection?: OpenerLinkInspection | null;
}): Promise<OneTapClaimResult> {
  const { pendingWallet } = params;
  if (!pendingWallet.keyId) {
    return {
      status: 'prf_refused',
      issue: 'failed',
      reason: prfRefusalMessage('failed'),
      pendingWallet,
    };
  }

  const prf = await evaluatePrf(pendingWallet.keyId, FEE_PAYER_PRF_SALT);
  if (prf.outcome !== 'ok' || !prf.output || prf.output.length < 32) {
    const nextIssue: Exclude<PrfOutcome, 'ok'> =
      prf.outcome === 'ok' ? 'unsupported' : prf.outcome;
    return {
      status: 'prf_refused',
      issue: nextIssue,
      reason: prfRefusalMessage(nextIssue),
      pendingWallet: { ...pendingWallet, issue: nextIssue },
    };
  }

  const prfFeePayer = Keypair.fromRawEd25519Seed(Buffer.from(prf.output.subarray(0, 32)));
  const committed = await pendingWallet.commit(prfFeePayer);
  const net = getNetwork();

  await savePendingClaimCheckpoint({
    balanceId: params.balanceId,
    network: params.linkNetwork ?? net.name,
    note: params.note ?? null,
    amount: params.inspection?.amount ?? null,
    assetCode: params.inspection?.assetCode ?? null,
    assetIssuer: params.inspection?.assetIssuer ?? null,
    ephemeralSecret: params.ephemeralSecret.trim(),
    stage: 'after_creation',
    userInitiated: true,
    walletAddress: committed.address,
    createdNewWallet: true,
  });

  return submitClaimWithCheckpoints({
    balanceId: params.balanceId,
    ephemeralSecret: params.ephemeralSecret,
    linkNetwork: params.linkNetwork,
    note: params.note,
    inspection: params.inspection,
    createdNewWallet: true,
    verifyFeePayerFunding: true,
    existingCheckpoint: null,
  });
}

/**
 * Sign in to an existing passkey wallet via `loginWithPasskey()` (e.g. after a
 * reinstall) and immediately complete the claim without creating a second wallet.
 */
export async function signInAndClaim(params: {
  balanceId: string;
  ephemeralSecret: string;
  linkNetwork?: VeilNetworkName | null;
  note?: string | null;
  inspection?: OpenerLinkInspection | null;
}): Promise<OneTapClaimResult> {
  const net = getNetwork();
  await savePendingClaimCheckpoint({
    balanceId: params.balanceId,
    network: params.linkNetwork ?? net.name,
    note: params.note ?? null,
    amount: params.inspection?.amount ?? null,
    assetCode: params.inspection?.assetCode ?? null,
    assetIssuer: params.inspection?.assetIssuer ?? null,
    ephemeralSecret: params.ephemeralSecret.trim(),
    stage: 'before_passkey',
    userInitiated: true,
    createdNewWallet: false,
  });

  const login = await loginWithPasskey();

  await savePendingClaimCheckpoint({
    balanceId: params.balanceId,
    network: params.linkNetwork ?? net.name,
    note: params.note ?? null,
    amount: params.inspection?.amount ?? null,
    assetCode: params.inspection?.assetCode ?? null,
    assetIssuer: params.inspection?.assetIssuer ?? null,
    ephemeralSecret: params.ephemeralSecret.trim(),
    stage: 'after_creation',
    userInitiated: true,
    walletAddress: login.address,
    createdNewWallet: false,
  });

  return submitClaimWithCheckpoints({
    balanceId: params.balanceId,
    ephemeralSecret: params.ephemeralSecret,
    linkNetwork: params.linkNetwork,
    note: params.note,
    inspection: params.inspection,
    createdNewWallet: false,
    verifyFeePayerFunding: true,
    existingCheckpoint: null,
  });
}

/**
 * Claim with the active local wallet while keeping user-initiated checkpoint
 * and interrupted-claim resume support active on top of `#1356`'s
 * `claimLinkWithSpendingAccount()`.
 */
export async function claimWithExistingWallet(params: {
  balanceId: string;
  ephemeralSecret: string;
  linkNetwork?: VeilNetworkName | null;
  note?: string | null;
  inspection?: OpenerLinkInspection | null;
}): Promise<OneTapClaimResult> {
  const existing = await loadPendingClaimCheckpoint();
  const matching = existing?.balanceId === params.balanceId ? existing : null;
  return submitClaimWithCheckpoints({
    balanceId: params.balanceId,
    ephemeralSecret: params.ephemeralSecret,
    linkNetwork: params.linkNetwork,
    note: params.note,
    inspection: params.inspection,
    createdNewWallet: Boolean(matching?.createdNewWallet),
    verifyFeePayerFunding: Boolean(matching?.createdNewWallet),
    existingCheckpoint: matching,
  });
}
