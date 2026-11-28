/**
 * Escrow (Stellar claimable balance) helpers for mobile, including link expiry,
 * pre-expiry reclaim guards, race-safe claim/reclaim outcomes, reserve
 * recovery, and wallet-wide accounting for funds tied up in unclaimed links.
 *
 * The web wallet re-exports the base surface from `sdk/src/claimableBalance.ts`
 * (`frontend/wallet/lib/escrow.ts` is a one-line `export * from '../../../sdk/src/claimableBalance'`).
 * The same relative path resolves from `frontend/mobile/lib` too, but that file
 * imports `@stellar/stellar-sdk`, and the mobile TypeScript program only
 * resolves modules from `frontend/mobile/node_modules` — there is no hoisted
 * root `node_modules`, so `tsc` cannot find `@stellar/stellar-sdk` when the
 * sdk file is pulled in via a blind `export *`. Mobile already depends on
 * `@stellar/stellar-sdk` directly, so this file mirrors the sdk implementation
 * locally instead of reaching outside the mobile package.
 */
import {
  Asset,
  Claimant,
  Horizon,
  Keypair,
  Operation,
  TransactionBuilder,
} from '@stellar/stellar-sdk';

import { APP_HOST } from './deepLinks';
import { inclusionFee } from './fees';
import { getNetwork, type VeilNetworkName } from './network';
import type { WalletSigner } from './sendPayment';
import { requireSigner } from './signer';

const STROOPS_PER_UNIT = 10_000_000n;

/**
 * Each Stellar claimable balance with two claimants (recipient + sender) holds
 * two subentry-equivalents (`2 * 0.5 XLM = 1.0 XLM`) against the sponsoring
 * sender account until either party claims it.
 */
export const CLAIMABLE_BALANCE_RESERVE_STROOPS = 10_000_000n;
export const CLAIMABLE_BALANCE_RESERVE_XLM = '1';

export type ClaimLinkExpiryPresetId = '1h' | '24h' | '7d' | '30d';

export type ClaimLinkExpiryPreset = {
  id: ClaimLinkExpiryPresetId;
  label: string;
  seconds: number;
};

/**
 * Sender-selectable expiry windows, ordered shortest to longest.
 * Default is 7 days: long enough for an async message thread, short enough that
 * forgotten links become reclaimable within a week.
 */
export const CLAIM_LINK_EXPIRY_PRESETS: readonly ClaimLinkExpiryPreset[] = [
  { id: '1h', label: '1 hour', seconds: 3_600 },
  { id: '24h', label: '24 hours', seconds: 86_400 },
  { id: '7d', label: '7 days', seconds: 604_800 },
  { id: '30d', label: '30 days', seconds: 2_592_000 },
] as const;

export const DEFAULT_CLAIM_LINK_EXPIRY_ID: ClaimLinkExpiryPresetId = '7d';
export const DEFAULT_CLAIM_LINK_EXPIRY_SECONDS = 604_800;

export const ALREADY_CLAIMED_MESSAGE = 'This link has already been claimed.';
export const EXPIRED_AND_RECLAIMED_MESSAGE = 'This link expired and was reclaimed by the sender.';
export const ALREADY_RECLAIMED_MESSAGE = 'This link has already been reclaimed.';
export const RECLAIM_BEFORE_EXPIRY_MESSAGE =
  'This link has not expired yet. You can reclaim the funds once the expiry window ends.';
export const MISSING_CLAIMANT_ACCOUNT_MESSAGE =
  'This recipient account has not been created on the Stellar network yet. Fund it with XLM before claiming this link.';
export const HISTORY_CHECK_FAILED_MESSAGE =
  'This balance is no longer active, and its claim history could not be checked. Check your connection and try again.';
export const BALANCE_NOT_FOUND_MESSAGE =
  'No claimable balance with this ID was found on the active Stellar network.';

export type EscrowConfig = {
  /** Stellar Horizon REST API base URL (e.g. "https://horizon-testnet.stellar.org").
   *  Must be a Horizon URL — NOT a Soroban RPC endpoint. */
  horizonUrl: string;
  networkPassphrase: string;
};

export type CreateEscrowOptions = {
  senderKeypair: Keypair;
  recipientAddress: string;
  amount: string;
  asset: Asset;
  /**
   * Duration in seconds from now before the sender can reclaim the balance.
   * Defaults to {@link DEFAULT_CLAIM_LINK_EXPIRY_SECONDS} (7 days).
   */
  claimDeadlineSeconds?: number;
  /** Optional preset identifier overriding `claimDeadlineSeconds`. */
  expiryPreset?: ClaimLinkExpiryPresetId;
  /** Injectable clock (unix seconds) for deterministic testing. */
  nowUnix?: number;
  config: EscrowConfig;
};

export type EscrowResult = {
  balanceId: string;
  claimLink: string;
  expiresAt: number;
  reserveLockedXlm: string;
};

export type ClaimOptions = {
  claimantKeypair: Keypair;
  balanceId: string;
  config: EscrowConfig;
};

export type ReclaimOptions = {
  /**
   * Active wallet signer (from `requireSigner()`). When omitted and no
   * `senderKeypair` override is given, `reclaimEscrowSafely` resolves it via
   * `requireSigner()`.
   */
  signer?: WalletSigner;
  /** @deprecated Prefer `signer` (`requireSigner()`). Kept for SDK-parity callers. */
  senderKeypair?: Keypair;
  balanceId: string;
  /** Known expiry unix timestamp (seconds) recorded when the link was created. */
  expiresAt?: number;
  /** Optional asset metadata so reclaim can restore a removed trustline before claiming. */
  assetCode?: string;
  assetIssuer?: string | null;
  /** Injectable clock (unix seconds) for deterministic testing. */
  nowUnix?: number;
  /** Defaults to the active network from `getNetwork()`. */
  config?: EscrowConfig;
};

export type ClaimLinkTerminalState =
  | 'active'
  | 'expired_unreclaimed'
  | 'claimed_by_other'
  | 'expired_and_reclaimed'
  | 'status_unknown';

export type ClaimOutcome =
  | { status: 'claimed'; txHash: string }
  | { status: 'already_claimed'; message: string };

export type ReclaimOutcome =
  | {
      status: 'reclaimed';
      txHash: string;
      sweptReserveXlm: string;
    }
  | {
      status: 'before_expiry';
      expiresAt: number;
      remainingSeconds: number;
      message: string;
    }
  | {
      status: 'already_reclaimed';
      message: string;
    }
  | {
      status: 'already_claimed';
      message: string;
    }
  | {
      status: 'status_unknown';
      message: string;
    };

export type OpenerLinkInspectionState =
  | ClaimLinkTerminalState
  | 'not_found'
  | 'network_mismatch';

export type OpenerLinkInspection = {
  balanceId: string;
  state: OpenerLinkInspectionState;
  amount: string | null;
  assetCode: string | null;
  assetIssuer: string | null;
  sponsor: string | null;
  claimantAddresses: string[];
  expiresAt: number | null;
  expiryLabel: string | null;
  linkNetwork?: VeilNetworkName | null;
  activeNetwork?: VeilNetworkName | null;
  message: string;
};

export type KnownSenderClaimLink = {
  balanceId: string;
  amount: string;
  assetCode: string;
  assetIssuer: string | null;
  expiresAt: number;
  createdAt?: number;
  network?: VeilNetworkName;
  ephemeralAddress?: string;
  reclaimedBySender?: boolean;
};

export type SenderClaimLinkItem = {
  balanceId: string;
  amount: string;
  assetCode: string;
  assetIssuer: string | null;
  expiresAt: number;
  senderExpiryLabel: string;
  state: ClaimLinkTerminalState;
  statusLabel: string;
  canReclaim: boolean;
  reserveLockedXlm: string;
};

export type TiedUpAssetSummary = {
  assetKey: string;
  assetCode: string;
  assetIssuer: string | null;
  totalAmount: string;
  reclaimableAmount: string;
  linkCount: number;
};

export type TiedUpLinksSummary = {
  walletAddress: string;
  openLinkCount: number;
  activeLinkCount: number;
  expiredUnreclaimedCount: number;
  lockedReserveXlm: string;
  reclaimableReserveXlm: string;
  assets: TiedUpAssetSummary[];
  links: SenderClaimLinkItem[];
};

export type ConsumedBalanceHistory =
  | { status: 'claimed'; claimant: string; sponsor: string | null }
  | { status: 'no_claim_in_history' }
  | { status: 'lookup_failed' };

export class ReclaimBeforeExpiryError extends Error {
  readonly expiresAt: number;
  readonly remainingSeconds: number;

  constructor(expiresAt: number, nowUnix: number) {
    super(RECLAIM_BEFORE_EXPIRY_MESSAGE);
    this.name = 'ReclaimBeforeExpiryError';
    this.expiresAt = expiresAt;
    this.remainingSeconds = Math.max(1, expiresAt - nowUnix);
  }
}

export function resolveClaimLinkExpirySeconds(
  presetOrSeconds?: ClaimLinkExpiryPresetId | number,
): number {
  if (typeof presetOrSeconds === 'string') {
    const found = CLAIM_LINK_EXPIRY_PRESETS.find((p) => p.id === presetOrSeconds);
    if (!found) {
      throw new Error(`Unknown claim link expiry preset: ${presetOrSeconds}`);
    }
    return found.seconds;
  }
  if (presetOrSeconds === undefined) {
    return DEFAULT_CLAIM_LINK_EXPIRY_SECONDS;
  }
  if (!Number.isFinite(presetOrSeconds) || presetOrSeconds <= 0) {
    throw new Error('Claim link expiry must be a positive duration in seconds.');
  }
  return Math.floor(presetOrSeconds);
}

function formatRelativeDuration(deltaSeconds: number): string {
  const abs = Math.max(0, Math.floor(Math.abs(deltaSeconds)));
  if (abs < 60) return 'less than a minute';
  if (abs < 3_600) {
    const mins = Math.floor(abs / 60);
    return `${mins}m`;
  }
  if (abs < 86_400) {
    const hours = Math.floor(abs / 3_600);
    return `${hours}h`;
  }
  const days = Math.floor(abs / 86_400);
  return `${days}d`;
}

/**
 * Plain expiry summary shown to the sender at link creation and in their links list.
 */
export function formatClaimLinkExpiryForSender(
  expiresAtUnix: number,
  nowUnix = Math.floor(Date.now() / 1000),
): string {
  const diff = expiresAtUnix - nowUnix;
  if (diff <= 0) {
    return `Expired ${formatRelativeDuration(diff)} ago · ready to reclaim`;
  }
  return `Expires in ${formatRelativeDuration(diff)} — reclaim unlocks after expiry`;
}

/**
 * Plain expiry summary shown to the recipient on the claim screen before claiming.
 */
export function formatClaimLinkExpiryForRecipient(
  expiresAtUnix: number,
  nowUnix = Math.floor(Date.now() / 1000),
): string {
  const diff = expiresAtUnix - nowUnix;
  if (diff <= 0) {
    return `Expired ${formatRelativeDuration(diff)} ago — the sender can now reclaim this link`;
  }
  return `Claim within ${formatRelativeDuration(diff)}`;
}

export function terminalStateLabel(state: ClaimLinkTerminalState): string {
  switch (state) {
    case 'active':
      return 'Unclaimed';
    case 'expired_unreclaimed':
      return 'Expired and not yet reclaimed';
    case 'claimed_by_other':
      return 'Claimed by someone else';
    case 'expired_and_reclaimed':
      return 'Expired and reclaimed';
    case 'status_unknown':
      return 'Could not be checked';
  }
}

/** Parse a Stellar decimal string (`"12.3456789"`) into exact integer stroops. */
export function decimalToStroops(amount: string): bigint {
  const trimmed = amount.trim();
  const match = /^(\d+)(?:\.(\d{1,7})\d*)?$/.exec(trimmed);
  if (!match) {
    throw new Error(`Invalid Stellar amount: "${amount}"`);
  }
  const whole = BigInt(match[1]);
  const fracRaw = (match[2] ?? '').padEnd(7, '0');
  return whole * STROOPS_PER_UNIT + BigInt(fracRaw);
}

/** Format exact integer stroops back to a clean Stellar decimal string. */
export function stroopsToDecimal(stroops: bigint): string {
  const negative = stroops < 0n;
  const abs = negative ? -stroops : stroops;
  const whole = abs / STROOPS_PER_UNIT;
  const frac = abs % STROOPS_PER_UNIT;
  if (frac === 0n) {
    return `${negative ? '-' : ''}${whole.toString()}`;
  }
  const fracStr = frac.toString().padStart(7, '0').replace(/0+$/, '');
  return `${negative ? '-' : ''}${whole.toString()}.${fracStr}`;
}

export function parseHorizonAsset(rawAsset: string): { code: string; issuer: string | null } {
  if (!rawAsset || rawAsset === 'native') {
    return { code: 'XLM', issuer: null };
  }
  const colon = rawAsset.indexOf(':');
  if (colon === -1) {
    return { code: rawAsset, issuer: null };
  }
  return {
    code: rawAsset.slice(0, colon),
    issuer: rawAsset.slice(colon + 1) || null,
  };
}

function extractClaimantDestinations(claimants: unknown): string[] {
  if (!Array.isArray(claimants)) return [];
  const out: string[] = [];
  for (const entry of claimants) {
    const dest = (entry as { destination?: unknown })?.destination;
    if (typeof dest === 'string' && dest) out.push(dest);
  }
  return out;
}

/**
 * Extract the unix timestamp from a `not(abs_before(epoch))` sender reclaim
 * predicate produced by {@link buildEscrowClaimants}.
 */
export function extractReclaimDeadlineUnix(claimants: unknown): number | null {
  if (!Array.isArray(claimants)) return null;
  for (const entry of claimants) {
    const predicate = (entry as { predicate?: Record<string, unknown> })?.predicate;
    const negated = predicate?.not as Record<string, unknown> | undefined;
    if (!negated) continue;
    const epochRaw = negated.abs_before_epoch ?? negated.absBeforeEpoch;
    if (epochRaw !== undefined && epochRaw !== null) {
      const parsed = Number(epochRaw);
      if (Number.isFinite(parsed) && parsed > 0) return Math.floor(parsed);
    }
    const isoRaw = negated.abs_before;
    if (typeof isoRaw === 'string') {
      const ms = Date.parse(isoRaw);
      if (Number.isFinite(ms) && ms > 0) return Math.floor(ms / 1000);
    }
  }
  return null;
}

export function isNotFoundError(err: unknown): boolean {
  const status = (err as { response?: { status?: number } })?.response?.status;
  if (status === 404) return true;
  if (err instanceof Error && err.name === 'NotFoundError') return true;
  return false;
}

export function extractHorizonResultCodes(err: unknown): { txCode?: string; opCodes: string[] } {
  const extras = (
    err as {
      response?: {
        data?: {
          extras?: {
            result_codes?: {
              transaction?: string;
              operations?: string[];
            };
          };
        };
      };
    }
  )?.response?.data?.extras?.result_codes;
  return {
    txCode: extras?.transaction,
    opCodes: Array.isArray(extras?.operations) ? extras.operations : [],
  };
}

/**
 * True ONLY when a transaction submission rejected `claim_claimable_balance`
 * with `op_does_not_exist` (meaning the claimable balance itself is gone).
 *
 * Deliberately does NOT treat HTTP 404 as "already claimed": `claimEscrow`
 * calls `server.loadAccount(claimant)` before submitting, and a 404 there
 * means the claimant's account does not exist on the ledger yet — NOT that the
 * balance was claimed.
 */
function isClaimConsumedHorizonError(err: unknown): boolean {
  const { opCodes } = extractHorizonResultCodes(err);
  return opCodes.includes('op_does_not_exist');
}

function isCannotClaimYetHorizonError(err: unknown): boolean {
  const { opCodes } = extractHorizonResultCodes(err);
  return opCodes.includes('op_cannot_claim');
}

/**
 * Inspect Horizon operation history for `balanceId` so a missing claimable
 * balance is reported as claimed ONLY when a `claim_claimable_balance`
 * operation actually exists, and a failed lookup is reported as
 * `'lookup_failed'` rather than guessed as claimed or reclaimed.
 */
export async function resolveConsumedBalanceHistory(
  server: Horizon.Server,
  balanceId: string,
): Promise<ConsumedBalanceHistory> {
  try {
    const opsBuilder = (
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
    const forBalance = opsBuilder?.forClaimableBalance?.(balanceId);
    if (!forBalance) return { status: 'lookup_failed' };
    const page = await forBalance.order('desc').limit(10).call();
    const records = Array.isArray(page?.records) ? page.records : [];
    let claimant: string | null = null;
    let sponsor: string | null = null;
    for (const op of records) {
      if (op.type === 'claim_claimable_balance' && !claimant) {
        const found =
          typeof op.claimant === 'string'
            ? op.claimant
            : typeof op.source_account === 'string'
              ? op.source_account
              : null;
        if (found) claimant = found;
      }
      if (op.type === 'create_claimable_balance' && !sponsor) {
        if (typeof op.source_account === 'string' && op.source_account) {
          sponsor = op.source_account;
        }
      }
    }
    if (claimant) {
      return { status: 'claimed', claimant, sponsor };
    }
    return { status: 'no_claim_in_history' };
  } catch (err) {
    if (isNotFoundError(err)) {
      return { status: 'no_claim_in_history' };
    }
    return { status: 'lookup_failed' };
  }
}

export function buildClaimLink(balanceId: string, network?: VeilNetworkName): string {
  const base = `https://${APP_HOST}/claim/${balanceId}`;
  if (network === 'mainnet' || network === 'testnet') {
    return `${base}?network=${network}`;
  }
  return base;
}

/**
 * Build the two Stellar Claimant entries for an escrow balance:
 *  - recipient: may claim unconditionally at any time.
 *  - sender: may reclaim ONLY after `deadlineUnix` (unix timestamp).
 *
 * A Stellar claimable balance is consumed by the first successful claim.
 * Once either party claims, the balance is gone — the other party's subsequent
 * claim will be rejected by the Stellar network. Design UIs accordingly.
 */
export function buildEscrowClaimants(
  recipientAddress: string,
  senderAddress: string,
  deadlineUnix: number,
): Claimant[] {
  const recipientClaimant = new Claimant(recipientAddress, Claimant.predicateUnconditional());
  const senderClaimant = new Claimant(
    senderAddress,
    Claimant.predicateNot(Claimant.predicateBeforeAbsoluteTime(deadlineUnix.toString())),
  );
  return [recipientClaimant, senderClaimant];
}

/**
 * Create a Stellar claimable balance escrow.
 *
 * The recipient may claim immediately (unconditional predicate).
 * The sender may reclaim after `claimDeadlineSeconds` has elapsed.
 * Claim and reclaim are mutually exclusive — the first successful claim
 * consumes the balance.
 *
 * @throws If Horizon does not return a balance_id in its response.
 */
export async function createEscrow(options: CreateEscrowOptions): Promise<EscrowResult> {
  const { senderKeypair, recipientAddress, amount, asset, config } = options;
  const deadlineSeconds = resolveClaimLinkExpirySeconds(
    options.expiryPreset ?? options.claimDeadlineSeconds,
  );
  const nowUnix = options.nowUnix ?? Math.floor(Date.now() / 1000);
  const server = new Horizon.Server(config.horizonUrl);

  const account = await server.loadAccount(senderKeypair.publicKey());
  const expiresAt = nowUnix + deadlineSeconds;

  const claimants = buildEscrowClaimants(recipientAddress, senderKeypair.publicKey(), expiresAt);

  const tx = new TransactionBuilder(account, {
    fee: inclusionFee(),
    networkPassphrase: config.networkPassphrase,
  })
    .addOperation(
      Operation.createClaimableBalance({
        asset,
        amount,
        claimants,
      }),
    )
    .setTimeout(180)
    .build();

  tx.sign(senderKeypair);

  const result = await server.submitTransaction(tx);
  const balanceId =
    (result as unknown as { balance_id?: string }).balance_id ??
    (typeof tx.getClaimableBalanceId === 'function' ? tx.getClaimableBalanceId(0) : undefined);
  if (!balanceId) {
    throw new Error('create_claimable_balance: missing balance_id in Horizon response');
  }

  return {
    balanceId,
    claimLink: buildClaimLink(balanceId),
    expiresAt,
    reserveLockedXlm: CLAIMABLE_BALANCE_RESERVE_XLM,
  };
}

/**
 * Claim a claimable balance as the recipient.
 *
 * Once claimed the balance is consumed. A subsequent reclaimEscrow() call
 * by the sender will be rejected by the Stellar network.
 */
export async function claimEscrow(options: ClaimOptions): Promise<{ txHash: string }> {
  const { claimantKeypair, balanceId, config } = options;
  const server = new Horizon.Server(config.horizonUrl);

  let account: Horizon.AccountResponse;
  try {
    account = await server.loadAccount(claimantKeypair.publicKey());
  } catch (err) {
    if (isNotFoundError(err)) {
      throw new Error(MISSING_CLAIMANT_ACCOUNT_MESSAGE);
    }
    throw err;
  }

  const tx = new TransactionBuilder(account, {
    fee: inclusionFee(),
    networkPassphrase: config.networkPassphrase,
  })
    .addOperation(Operation.claimClaimableBalance({ balanceId }))
    .setTimeout(180)
    .build();

  tx.sign(claimantKeypair);

  const result = await server.submitTransaction(tx);
  return { txHash: result.hash };
}

/**
 * Race-safe recipient claim that translates a consumed balance (`op_does_not_exist`)
 * into a plain human-readable outcome rather than throwing a raw Horizon failure.
 *
 * A missing claimant account (`loadAccount` 404) throws a plain sentence
 * ({@link MISSING_CLAIMANT_ACCOUNT_MESSAGE}) rather than raw `"Not Found"` or
 * misreporting the link as already claimed.
 */
export async function claimEscrowOutcome(options: ClaimOptions): Promise<ClaimOutcome> {
  try {
    const { txHash } = await claimEscrow(options);
    return { status: 'claimed', txHash };
  } catch (err) {
    if (isClaimConsumedHorizonError(err)) {
      return { status: 'already_claimed', message: ALREADY_CLAIMED_MESSAGE };
    }
    throw err;
  }
}

function networkDisplayLabel(network: VeilNetworkName): string {
  return network === 'mainnet' ? 'Stellar Mainnet' : 'Stellar Testnet';
}

/**
 * Inspect a claim link on Horizon before prompting or submitting.
 *
 * Only reports `"This link has already been claimed."` when a
 * `claim_claimable_balance` operation is present in Horizon history; separates
 * network mismatches, mistyped/missing IDs, and failed history lookups into
 * distinct plain-language states.
 */
export async function inspectClaimLinkForOpener(
  balanceId: string,
  config: EscrowConfig,
  opts: {
    senderAddress?: string;
    nowUnix?: number;
    linkNetwork?: VeilNetworkName | null;
    activeNetwork?: VeilNetworkName;
  } = {},
): Promise<OpenerLinkInspection> {
  if (opts.linkNetwork && opts.activeNetwork && opts.linkNetwork !== opts.activeNetwork) {
    return {
      balanceId,
      state: 'network_mismatch',
      amount: null,
      assetCode: null,
      assetIssuer: null,
      sponsor: opts.senderAddress ?? null,
      claimantAddresses: [],
      expiresAt: null,
      expiryLabel: null,
      linkNetwork: opts.linkNetwork,
      activeNetwork: opts.activeNetwork,
      message: `This link was created on ${networkDisplayLabel(opts.linkNetwork)}, while your wallet is set to ${networkDisplayLabel(opts.activeNetwork)}. Switch networks in Settings to open it.`,
    };
  }

  const nowUnix = opts.nowUnix ?? Math.floor(Date.now() / 1000);
  const server = new Horizon.Server(config.horizonUrl);

  try {
    const cbCall = (
      server as unknown as {
        claimableBalances: () => {
          claimableBalance: (id: string) => { call: () => Promise<Record<string, unknown>> };
        };
      }
    )
      .claimableBalances()
      .claimableBalance(balanceId);
    const record = await cbCall.call();
    const { code, issuer } = parseHorizonAsset(String(record.asset ?? 'native'));
    const amount = typeof record.amount === 'string' ? record.amount : null;
    const sponsor = typeof record.sponsor === 'string' ? record.sponsor : (opts.senderAddress ?? null);
    const claimantAddresses = extractClaimantDestinations(record.claimants);
    const expiresAt = extractReclaimDeadlineUnix(record.claimants);
    const expired = expiresAt !== null && nowUnix >= expiresAt;
    const expiryLabel = expiresAt !== null ? formatClaimLinkExpiryForRecipient(expiresAt, nowUnix) : null;

    return {
      balanceId,
      state: expired ? 'expired_unreclaimed' : 'active',
      amount,
      assetCode: code,
      assetIssuer: issuer,
      sponsor,
      claimantAddresses,
      expiresAt,
      expiryLabel,
      linkNetwork: opts.linkNetwork ?? null,
      activeNetwork: opts.activeNetwork ?? null,
      message: expired
        ? 'This link has passed its expiry window, but the funds are still unclaimed.'
        : 'Ready to claim.',
    };
  } catch (err) {
    if (!isNotFoundError(err)) {
      throw err;
    }
    const history = await resolveConsumedBalanceHistory(server, balanceId);
    if (history.status === 'lookup_failed') {
      return {
        balanceId,
        state: 'status_unknown',
        amount: null,
        assetCode: null,
        assetIssuer: null,
        sponsor: opts.senderAddress ?? null,
        claimantAddresses: [],
        expiresAt: null,
        expiryLabel: null,
        linkNetwork: opts.linkNetwork ?? null,
        activeNetwork: opts.activeNetwork ?? null,
        message: HISTORY_CHECK_FAILED_MESSAGE,
      };
    }
    if (history.status === 'no_claim_in_history') {
      return {
        balanceId,
        state: 'not_found',
        amount: null,
        assetCode: null,
        assetIssuer: null,
        sponsor: opts.senderAddress ?? null,
        claimantAddresses: [],
        expiresAt: null,
        expiryLabel: null,
        linkNetwork: opts.linkNetwork ?? null,
        activeNetwork: opts.activeNetwork ?? null,
        message: BALANCE_NOT_FOUND_MESSAGE,
      };
    }
    const effectiveSender = opts.senderAddress ?? history.sponsor;
    const reclaimedBySender = Boolean(effectiveSender && history.claimant === effectiveSender);
    if (reclaimedBySender) {
      return {
        balanceId,
        state: 'expired_and_reclaimed',
        amount: null,
        assetCode: null,
        assetIssuer: null,
        sponsor: effectiveSender ?? null,
        claimantAddresses: [],
        expiresAt: null,
        expiryLabel: null,
        linkNetwork: opts.linkNetwork ?? null,
        activeNetwork: opts.activeNetwork ?? null,
        message: EXPIRED_AND_RECLAIMED_MESSAGE,
      };
    }
    return {
      balanceId,
      state: 'claimed_by_other',
      amount: null,
      assetCode: null,
      assetIssuer: null,
      sponsor: effectiveSender ?? null,
      claimantAddresses: [],
      expiresAt: null,
      expiryLabel: null,
      linkNetwork: opts.linkNetwork ?? null,
      activeNetwork: opts.activeNetwork ?? null,
      message: ALREADY_CLAIMED_MESSAGE,
    };
  }
}

async function resolveReclaimSigner(options: ReclaimOptions): Promise<WalletSigner> {
  if (options.signer) return options.signer;
  if (options.senderKeypair) {
    const kp = options.senderKeypair;
    return {
      publicKey: kp.publicKey(),
      sign: (tx) => tx.sign(kp),
    };
  }
  return requireSigner();
}

/**
 * Reclaim a claimable balance as the sender after the deadline has passed.
 *
 * Refuses before expiry with {@link ReclaimBeforeExpiryError} so the sender
 * cannot race an in-progress recipient claim, and returns the 1 XLM
 * claimable-balance reserve to the sponsoring account.
 */
export async function reclaimEscrow(options: ReclaimOptions): Promise<{ txHash: string }> {
  const outcome = await reclaimEscrowSafely(options);
  if (outcome.status === 'reclaimed') {
    return { txHash: outcome.txHash };
  }
  if (outcome.status === 'before_expiry') {
    throw new ReclaimBeforeExpiryError(
      outcome.expiresAt,
      outcome.expiresAt - outcome.remainingSeconds,
    );
  }
  throw new Error(outcome.message);
}

async function classifyMissingReclaimBalance(
  server: Horizon.Server,
  balanceId: string,
  senderAddress: string,
): Promise<ReclaimOutcome> {
  const history = await resolveConsumedBalanceHistory(server, balanceId);
  if (history.status === 'lookup_failed') {
    return { status: 'status_unknown', message: HISTORY_CHECK_FAILED_MESSAGE };
  }
  if (history.status === 'no_claim_in_history') {
    return { status: 'status_unknown', message: BALANCE_NOT_FOUND_MESSAGE };
  }
  if (history.claimant !== senderAddress) {
    return { status: 'already_claimed', message: ALREADY_CLAIMED_MESSAGE };
  }
  return { status: 'already_reclaimed', message: ALREADY_RECLAIMED_MESSAGE };
}

/**
 * Single unified reclaim implementation for sender claim links.
 *
 * Uses `requireSigner()` (unless an explicit `WalletSigner` was already
 * resolved by the caller) and bids `inclusionFee()` rather than `BASE_FEE` so
 * mainnet reclaims survive surge pricing. Returns explicit terminal outcomes
 * (`reclaimed`, `before_expiry`, `already_reclaimed`, `already_claimed`,
 * `status_unknown`).
 */
export async function reclaimEscrowSafely(options: ReclaimOptions): Promise<ReclaimOutcome> {
  const activeSigner = await resolveReclaimSigner(options);
  const senderAddress = activeSigner.publicKey;
  const activeConfig = options.config ?? getNetwork();
  const { balanceId } = options;
  const nowUnix = options.nowUnix ?? Math.floor(Date.now() / 1000);
  const server = new Horizon.Server(activeConfig.horizonUrl);

  if (options.expiresAt !== undefined && nowUnix < options.expiresAt) {
    return {
      status: 'before_expiry',
      expiresAt: options.expiresAt,
      remainingSeconds: options.expiresAt - nowUnix,
      message: RECLAIM_BEFORE_EXPIRY_MESSAGE,
    };
  }

  // When Horizon exposes claimableBalances(), verify on-chain state & deadline
  // before building a transaction that would fail on-chain.
  const cbApi = (
    server as unknown as {
      claimableBalances?: () => {
        claimableBalance?: (id: string) => { call: () => Promise<Record<string, unknown>> };
      };
    }
  ).claimableBalances?.();
  const cbLookup = cbApi?.claimableBalance?.(balanceId);

  let onChainDeadline = options.expiresAt ?? null;
  let resolvedAssetCode = options.assetCode ?? null;
  let resolvedAssetIssuer = options.assetIssuer ?? null;
  if (cbLookup) {
    try {
      const record = await cbLookup.call();
      if (typeof record.asset === 'string') {
        const parsed = parseHorizonAsset(record.asset);
        resolvedAssetCode = parsed.code;
        resolvedAssetIssuer = parsed.issuer;
      }
      const extracted = extractReclaimDeadlineUnix(record.claimants);
      if (extracted !== null) {
        onChainDeadline = extracted;
      }
      if (onChainDeadline !== null && nowUnix < onChainDeadline) {
        return {
          status: 'before_expiry',
          expiresAt: onChainDeadline,
          remainingSeconds: onChainDeadline - nowUnix,
          message: RECLAIM_BEFORE_EXPIRY_MESSAGE,
        };
      }
    } catch (err) {
      if (isNotFoundError(err)) {
        return classifyMissingReclaimBalance(server, balanceId, senderAddress);
      }
      throw err;
    }
  }

  const account = await server.loadAccount(senderAddress);
  const builder = new TransactionBuilder(account, {
    fee: inclusionFee(),
    networkPassphrase: activeConfig.networkPassphrase,
  });

  if (
    resolvedAssetCode &&
    resolvedAssetCode !== 'XLM' &&
    resolvedAssetIssuer &&
    Array.isArray(account.balances)
  ) {
    const senderBalances = account.balances as {
      asset_code?: string;
      asset_issuer?: string;
    }[];
    const hasTrust = senderBalances.some(
      (b) => b.asset_code === resolvedAssetCode && b.asset_issuer === resolvedAssetIssuer,
    );
    if (!hasTrust) {
      builder.addOperation(
        Operation.changeTrust({ asset: new Asset(resolvedAssetCode, resolvedAssetIssuer) }),
      );
    }
  }

  const tx = builder
    .addOperation(Operation.claimClaimableBalance({ balanceId }))
    .setTimeout(180)
    .build();

  activeSigner.sign(tx);

  try {
    const result = await server.submitTransaction(tx);
    return {
      status: 'reclaimed',
      txHash: result.hash,
      sweptReserveXlm: stroopsToDecimal(CLAIMABLE_BALANCE_RESERVE_STROOPS),
    };
  } catch (err) {
    if (isCannotClaimYetHorizonError(err)) {
      const effectiveExpiry = onChainDeadline ?? nowUnix + 60;
      return {
        status: 'before_expiry',
        expiresAt: effectiveExpiry,
        remainingSeconds: Math.max(1, effectiveExpiry - nowUnix),
        message: RECLAIM_BEFORE_EXPIRY_MESSAGE,
      };
    }
    if (isClaimConsumedHorizonError(err)) {
      return classifyMissingReclaimBalance(server, balanceId, senderAddress);
    }
    throw err;
  }
}

/**
 * Pure aggregator answering "what is tied up in unclaimed links?" from resolved
 * sender link items using exact integer stroop arithmetic.
 */
export function summarizeTiedUpClaimLinks(
  walletAddress: string,
  links: SenderClaimLinkItem[],
): TiedUpLinksSummary {
  let openLinkCount = 0;
  let activeLinkCount = 0;
  let expiredUnreclaimedCount = 0;
  let lockedReserveStroops = 0n;
  let reclaimableReserveStroops = 0n;

  const byAsset = new Map<
    string,
    {
      assetCode: string;
      assetIssuer: string | null;
      totalStroops: bigint;
      reclaimableStroops: bigint;
      linkCount: number;
    }
  >();

  for (const link of links) {
    const isOpen = link.state === 'active' || link.state === 'expired_unreclaimed';
    if (!isOpen) continue;

    openLinkCount += 1;
    const reserveStroops = decimalToStroops(link.reserveLockedXlm);
    lockedReserveStroops += reserveStroops;

    if (link.state === 'active') {
      activeLinkCount += 1;
    } else {
      expiredUnreclaimedCount += 1;
      reclaimableReserveStroops += reserveStroops;
    }

    const assetKey = `${link.assetCode}:${link.assetIssuer ?? 'native'}`;
    const amountStroops = decimalToStroops(link.amount);
    const existing = byAsset.get(assetKey) ?? {
      assetCode: link.assetCode,
      assetIssuer: link.assetIssuer,
      totalStroops: 0n,
      reclaimableStroops: 0n,
      linkCount: 0,
    };
    existing.totalStroops += amountStroops;
    if (link.state === 'expired_unreclaimed') {
      existing.reclaimableStroops += amountStroops;
    }
    existing.linkCount += 1;
    byAsset.set(assetKey, existing);
  }

  const assets: TiedUpAssetSummary[] = [];
  for (const [assetKey, agg] of byAsset.entries()) {
    assets.push({
      assetKey,
      assetCode: agg.assetCode,
      assetIssuer: agg.assetIssuer,
      totalAmount: stroopsToDecimal(agg.totalStroops),
      reclaimableAmount: stroopsToDecimal(agg.reclaimableStroops),
      linkCount: agg.linkCount,
    });
  }

  return {
    walletAddress,
    openLinkCount,
    activeLinkCount,
    expiredUnreclaimedCount,
    lockedReserveXlm: stroopsToDecimal(lockedReserveStroops),
    reclaimableReserveXlm: stroopsToDecimal(reclaimableReserveStroops),
    assets,
    links,
  };
}

/**
 * Query Horizon for every claimable balance sponsored by `walletAddress` (plus
 * any locally remembered links whose balances have already been consumed) and
 * compute the live tied-up principal + reserve summary.
 */
export async function fetchWalletTiedUpSummary(
  walletAddress: string,
  config: EscrowConfig,
  opts: { knownLinks?: KnownSenderClaimLink[]; nowUnix?: number } = {},
): Promise<TiedUpLinksSummary> {
  const nowUnix = opts.nowUnix ?? Math.floor(Date.now() / 1000);
  const server = new Horizon.Server(config.horizonUrl);

  const cbBuilder = (
    server as unknown as {
      claimableBalances: () => {
        sponsor: (addr: string) => {
          limit: (n: number) => {
            order: (dir: 'asc' | 'desc') => {
              call: () => Promise<{ records?: Record<string, unknown>[] }>;
            };
          };
        };
      };
    }
  ).claimableBalances();

  const page = await cbBuilder.sponsor(walletAddress).limit(200).order('desc').call();
  const liveRecords = Array.isArray(page?.records) ? page.records : [];

  const liveById = new Map<string, Record<string, unknown>>();
  for (const rec of liveRecords) {
    const id = typeof rec.id === 'string' ? rec.id : '';
    if (id) liveById.set(id, rec);
  }

  const items: SenderClaimLinkItem[] = [];
  const seenIds = new Set<string>();

  for (const rec of liveRecords) {
    const id = String(rec.id ?? '');
    if (!id) continue;
    seenIds.add(id);
    const { code, issuer } = parseHorizonAsset(String(rec.asset ?? 'native'));
    const amount = String(rec.amount ?? '0');
    const known = opts.knownLinks?.find((k) => k.balanceId === id);
    const expiresAt =
      extractReclaimDeadlineUnix(rec.claimants) ??
      known?.expiresAt ??
      nowUnix + DEFAULT_CLAIM_LINK_EXPIRY_SECONDS;
    const expired = nowUnix >= expiresAt;
    const state: ClaimLinkTerminalState = expired ? 'expired_unreclaimed' : 'active';

    items.push({
      balanceId: id,
      amount,
      assetCode: code,
      assetIssuer: issuer,
      expiresAt,
      senderExpiryLabel: formatClaimLinkExpiryForSender(expiresAt, nowUnix),
      state,
      statusLabel: terminalStateLabel(state),
      canReclaim: expired,
      reserveLockedXlm: CLAIMABLE_BALANCE_RESERVE_XLM,
    });
  }

  // Resolve any previously created links that are no longer in the live
  // claimable_balances table: only report claimed/reclaimed when a claim
  // operation is confirmed in Horizon history; otherwise say it could not be checked.
  for (const known of opts.knownLinks ?? []) {
    if (seenIds.has(known.balanceId) || liveById.has(known.balanceId)) continue;
    seenIds.add(known.balanceId);

    const history = await resolveConsumedBalanceHistory(server, known.balanceId);
    let state: ClaimLinkTerminalState;
    let senderExpiryLabel: string;

    if (history.status === 'claimed') {
      state = history.claimant === walletAddress ? 'expired_and_reclaimed' : 'claimed_by_other';
      senderExpiryLabel =
        state === 'expired_and_reclaimed'
          ? 'Expired · reclaimed by you'
          : 'Claimed before expiry';
    } else {
      state = 'status_unknown';
      senderExpiryLabel =
        history.status === 'lookup_failed'
          ? 'Claim history could not be checked'
          : 'Not found on this network — could not be checked';
    }

    items.push({
      balanceId: known.balanceId,
      amount: known.amount,
      assetCode: known.assetCode,
      assetIssuer: known.assetIssuer,
      expiresAt: known.expiresAt,
      senderExpiryLabel,
      state,
      statusLabel: terminalStateLabel(state),
      canReclaim: false,
      reserveLockedXlm: '0',
    });
  }

  return summarizeTiedUpClaimLinks(walletAddress, items);
}
