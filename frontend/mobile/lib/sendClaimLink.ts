/**
 * Sender-side claim link creation, note sanitization, cost estimation,
 * single-transaction recipient spending-account claim, and live Horizon state
 * resolution (#1285).
 *
 * A claim link wraps a Stellar claimable balance whose unconditional recipient
 * claimant is a single-use ephemeral keypair carried in the URL fragment
 * (`#s=<secret>`), and whose sender claimant unlocks reclaim after `expiresAt`.
 * Because possession of the URL fragment authorizes claiming the funds, every
 * share surface states plainly: "Anyone with this link can claim it."
 *
 * Security invariant: the bearer secret (and the full `#s=` URL containing it)
 * is NEVER persisted to `AsyncStorage` or any disk store. `AsyncStorage` keeps
 * only non-secret public metadata (`balanceId`, `amount`, `assetCode`,
 * `assetIssuer`, `expiresAt`, `createdAt`, `network`, `note`,
 * `ephemeralAddress`, `reclaimedBySender`).
 */
import AsyncStorage from '@react-native-async-storage/async-storage';
import {
  Asset,
  Claimant,
  Horizon,
  Keypair,
  Operation,
  StrKey,
  TransactionBuilder,
} from '@stellar/stellar-sdk';

import { APP_HOST } from './deepLinks';
import {
  ALREADY_CLAIMED_MESSAGE,
  CLAIMABLE_BALANCE_RESERVE_STROOPS,
  CLAIMABLE_BALANCE_RESERVE_XLM,
  decimalToStroops,
  extractHorizonResultCodes,
  extractReclaimDeadlineUnix,
  inspectClaimLinkForOpener,
  isNotFoundError,
  parseHorizonAsset,
  resolveConsumedBalanceHistory,
  stroopsToDecimal,
} from './escrow';
import { inclusionFee } from './fees';
import { horizonErrorMessage } from './horizonError';
import { getNetwork, getNetworkName, type VeilNetworkName } from './network';
import type { WalletSigner } from './sendPayment';

/** Refundable base reserve locked by a 2-claimant Stellar claimable balance (2 * 0.5 XLM). */
export const CLAIM_LINK_RESERVE_STROOPS = CLAIMABLE_BALANCE_RESERVE_STROOPS;
export const CLAIM_LINK_RESERVE_XLM = CLAIMABLE_BALANCE_RESERVE_XLM;

/** Maximum characters allowed in an optional sender note on the claim screen. */
export const MAX_CLAIM_LINK_NOTE_LENGTH = 80;

/** Plain one-line bearer disclosure shown before confirmation and on the share step. */
export const BEARER_LINK_WARNING = 'Anyone with this link can claim it.';

/**
 * Plain pre-confirmation disclosure that reclaiming an expired link depends on
 * this device's spending key.
 */
export const RECLAIM_DEVICE_KEY_WARNING =
  'Only this device\u2019s spending key can reclaim an expired link — uninstalling Veil without a backup can lose access to unclaimed funds.';

/**
 * Plain share-screen warning that Veil does not save the bearer secret, so
 * leaving without copying or sharing locks the funds until expiry.
 */
export const ONE_TIME_SHARE_WARNING =
  'Copy or share this link before leaving this screen. Veil does not store the link secret, so if you leave without saving it you cannot get the link back and the funds wait until expiry.';

const CREATED_LINKS_STORAGE_PREFIX = 'veil_created_claim_links_v1:';

export type LinkExpiryOption = {
  id: '1h' | '24h' | '7d' | '30d';
  label: string;
  seconds: number;
};

export const LINK_EXPIRY_OPTIONS: readonly LinkExpiryOption[] = [
  { id: '1h', label: '1h', seconds: 3_600 },
  { id: '24h', label: '24h', seconds: 86_400 },
  { id: '7d', label: '7d', seconds: 604_800 },
  { id: '30d', label: '30d', seconds: 2_592_000 },
] as const;

export const DEFAULT_LINK_EXPIRY_SECONDS = 604_800;

export type ClaimLinkCostBreakdown = {
  amount: string;
  assetCode: string;
  reserveXlm: string;
  feeXlm: string;
  /** Total XLM needed in the classic account now (amount + reserve + fee for XLM, or reserve + fee for issued assets). */
  totalXlmRequired: string;
};

/**
 * Non-secret metadata persisted locally for the sender's created-links list.
 * Deliberately excludes `claimUrl` and the ephemeral secret seed.
 */
export type StoredSenderLinkMeta = {
  balanceId: string;
  amount: string;
  assetCode: string;
  assetIssuer: string | null;
  expiresAt: number;
  createdAt: number;
  network?: VeilNetworkName;
  note: string | null;
  ephemeralAddress?: string;
  reclaimedBySender?: boolean;
};

export type SenderLinkChainStatus =
  | 'unclaimed'
  | 'claimed'
  | 'expired'
  | 'reclaimed'
  | 'status_unknown';

export type SenderCreatedLinkView = StoredSenderLinkMeta & {
  status: SenderLinkChainStatus;
  canReclaim: boolean;
  reserveHeldXlm: string;
};

export type CreateSenderClaimLinkInput = {
  /** Unique per confirmation session so a double-tap cannot create two links. */
  confirmationId: string;
  signer: WalletSigner;
  amount: string;
  asset?: { code: string; issuer: string | null };
  note?: string;
  expirySeconds?: number;
  nowUnix?: number;
};

export type CreatedSenderClaimLink = StoredSenderLinkMeta & {
  /** Returned once in memory for the immediate QR / Share step; never persisted. */
  claimUrl: string;
  txHash: string;
  cost: ClaimLinkCostBreakdown;
};

export type RecipientClaimResult =
  | {
      status: 'claimed';
      txHash: string;
      mergeTxHash?: string | null;
      /** True only once Tx 2 (`accountMerge`) released the 1 XLM sponsored base reserve. */
      reserveReleased: boolean;
      reserveReleaseTxHash?: string;
      reserveReleaseError?: string;
      amount: string;
      assetCode: string;
      assetIssuer: string | null;
    }
  | {
      status: 'already_claimed';
      message: string;
    };

export type ReserveReleaseRetryResult =
  | {
      released: true;
      txHash: string | null;
    }
  | {
      released: false;
      error: string;
    };

const inFlightByConfirmation = new Map<string, Promise<CreatedSenderClaimLink>>();
const completedByConfirmation = new Map<string, CreatedSenderClaimLink>();
const smartWalletFundedByConfirmation = new Set<string>();

export function resetClaimLinkIdempotencyForTests(): void {
  inFlightByConfirmation.clear();
  completedByConfirmation.clear();
  smartWalletFundedByConfirmation.clear();
}

export function markSmartWalletFundedConfirmation(confirmationId: string): void {
  const key = confirmationId.trim();
  if (key) smartWalletFundedByConfirmation.add(key);
}

export function hasSmartWalletFundedConfirmation(confirmationId: string): boolean {
  const key = confirmationId.trim();
  return key ? smartWalletFundedByConfirmation.has(key) : false;
}

export function parseClaimLinkNetwork(raw: string | null | undefined): VeilNetworkName | null {
  if (!raw) return null;
  const clean = raw.trim().toLowerCase();
  if (clean === 'mainnet' || clean === 'testnet') return clean;
  return null;
}

/**
 * Resolve and validate the asset to lock into a claim link.
 *
 * Refuses an issued asset whose issuer is missing or malformed instead of
 * silently falling back to native XLM — falling back would send the same
 * numerical figure in XLM while recording or labelling the link as USDC.
 */
export function resolveClaimLinkStellarAsset(
  asset: { code: string; issuer: string | null } | undefined,
): { stellarAsset: Asset; assetCode: string; assetIssuer: string | null } {
  if (!asset) {
    return { stellarAsset: Asset.native(), assetCode: 'XLM', assetIssuer: null };
  }
  const rawCode = asset.code.trim();
  const rawIssuer = asset.issuer?.trim() || null;

  if (!rawCode) {
    throw new Error('Choose a valid asset before creating a claim link.');
  }

  if (rawCode.toUpperCase() === 'XLM') {
    if (rawIssuer) {
      throw new Error('Native XLM cannot specify an asset issuer.');
    }
    return { stellarAsset: Asset.native(), assetCode: 'XLM', assetIssuer: null };
  }

  if (!rawIssuer || !StrKey.isValidEd25519PublicKey(rawIssuer)) {
    throw new Error(
      `Cannot create a ${rawCode} claim link without a valid Stellar issuer address.`,
    );
  }

  return {
    stellarAsset: new Asset(rawCode, rawIssuer),
    assetCode: rawCode,
    assetIssuer: rawIssuer,
  };
}

const URL_SCHEME_RE =
  /\b(?:https?|ftp|mailto|tel|javascript|data|vbscript|file|veil|web\+stellar)\s*:|\/\/\S+/i;
const WWW_HOST_RE = /\bwww\.[a-z0-9-]+/i;
const BARE_DOMAIN_RE =
  /(?:^|[\s(@])(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+(?:[a-z]{2,24}|xn--[a-z0-9-]{2,})(?=$|[\s/:?#),.!])|[a-z0-9-][\u3002\uFF0E\uFF61][a-z]{2,}/i;
const IP_LITERAL_RE = /\b(?:\d{1,3}\.){3}\d{1,3}\b|\[[0-9a-f:]+\]/i;
const MARKUP_OR_ENTITY_RE = /[<>&`]|\[[^\]]*\]\([^)]*\)|!\[[^\]]*\]/;
const CONTROL_CHARS_RE = /[\u0000-\u001F\u007F]/;

/**
 * Validate an optional sender note before it can be embedded in or shown on a
 * claim link.
 */
export function validateClaimLinkNote(rawNote: string | undefined | null): string | null {
  if (!rawNote) return null;
  if (CONTROL_CHARS_RE.test(rawNote)) {
    return 'Notes cannot contain line breaks or control characters.';
  }
  const trimmed = rawNote.trim();
  if (!trimmed) return null;
  if (trimmed.length > MAX_CLAIM_LINK_NOTE_LENGTH) {
    return `Keep the note to ${MAX_CLAIM_LINK_NOTE_LENGTH} characters or fewer.`;
  }
  if (
    URL_SCHEME_RE.test(trimmed) ||
    WWW_HOST_RE.test(trimmed) ||
    BARE_DOMAIN_RE.test(trimmed) ||
    IP_LITERAL_RE.test(trimmed)
  ) {
    return 'Notes cannot include links or web addresses.';
  }
  if (MARKUP_OR_ENTITY_RE.test(trimmed)) {
    return 'Notes must be plain text with no HTML or formatting markup.';
  }
  return null;
}

/**
 * Compute the exact cost of creating a claim link before the user confirms:
 * principal amount, refundable 1 XLM claimable-balance reserve, and network fee.
 */
export function estimateClaimLinkCost(
  amount: string,
  assetCode = 'XLM',
  feeStroopsRaw = inclusionFee(),
): ClaimLinkCostBreakdown {
  const normalizedCode = assetCode.trim() || 'XLM';
  const isNative = normalizedCode.toUpperCase() === 'XLM';
  const feeStroops = BigInt(feeStroopsRaw);
  let amountStroops = 0n;
  try {
    amountStroops = amount.trim() ? decimalToStroops(amount) : 0n;
  } catch {
    amountStroops = 0n;
  }

  const totalXlmStroops = isNative
    ? amountStroops + CLAIM_LINK_RESERVE_STROOPS + feeStroops
    : CLAIM_LINK_RESERVE_STROOPS + feeStroops;

  return {
    amount: amount.trim() || '0',
    assetCode: isNative ? 'XLM' : normalizedCode,
    reserveXlm: CLAIM_LINK_RESERVE_XLM,
    feeXlm: stroopsToDecimal(feeStroops),
    totalXlmRequired: stroopsToDecimal(totalXlmStroops),
  };
}

/**
 * Build a bearer claim URL hosted on Veil's verified associated domain
 * (`APP_HOST`). Encodes `network` (`testnet` | `mainnet`) in the query string
 * so a wallet on the other network never misreports a 404 as claimed, while
 * keeping the ephemeral claimant secret strictly in `#s=`.
 */
export function buildVerifiedClaimUrl(params: {
  balanceId: string;
  ephemeralSecret: string;
  amount: string;
  assetCode: string;
  assetIssuer: string | null;
  expiresAt: number;
  note: string | null;
  network?: VeilNetworkName;
}): string {
  const network = params.network ?? getNetworkName();
  const queryParts: [string, string][] = [['network', network]];
  if (params.note) {
    queryParts.push(['note', params.note]);
  }
  const query = queryParts
    .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`)
    .join('&');
  return `https://${APP_HOST}/claim/${encodeURIComponent(params.balanceId)}?${query}#s=${encodeURIComponent(params.ephemeralSecret)}`;
}

function sanitizeStoredMeta(entry: Record<string, unknown>): StoredSenderLinkMeta | null {
  const balanceId = typeof entry.balanceId === 'string' ? entry.balanceId.trim() : '';
  if (!balanceId) return null;
  const parsedNetwork = parseClaimLinkNetwork(
    typeof entry.network === 'string' ? entry.network : null,
  );
  return {
    balanceId,
    amount: typeof entry.amount === 'string' ? entry.amount : '0',
    assetCode: typeof entry.assetCode === 'string' && entry.assetCode ? entry.assetCode : 'XLM',
    assetIssuer: typeof entry.assetIssuer === 'string' && entry.assetIssuer ? entry.assetIssuer : null,
    expiresAt: typeof entry.expiresAt === 'number' && Number.isFinite(entry.expiresAt) ? entry.expiresAt : 0,
    createdAt: typeof entry.createdAt === 'number' && Number.isFinite(entry.createdAt) ? entry.createdAt : 0,
    ...(parsedNetwork ? { network: parsedNetwork } : {}),
    note: typeof entry.note === 'string' && entry.note ? entry.note : null,
    ...(typeof entry.ephemeralAddress === 'string' && entry.ephemeralAddress
      ? { ephemeralAddress: entry.ephemeralAddress }
      : {}),
    ...(typeof entry.reclaimedBySender === 'boolean'
      ? { reclaimedBySender: entry.reclaimedBySender }
      : {}),
  };
}

async function readStoredLinks(senderAddress: string): Promise<StoredSenderLinkMeta[]> {
  try {
    const key = `${CREATED_LINKS_STORAGE_PREFIX}${senderAddress}`;
    const raw = await AsyncStorage.getItem(key);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    let hadLegacySecretUrl = false;
    const sanitized: StoredSenderLinkMeta[] = [];
    for (const item of parsed) {
      if (!item || typeof item !== 'object') continue;
      const obj = item as Record<string, unknown>;
      if ('claimUrl' in obj || 'ephemeralSecret' in obj) {
        hadLegacySecretUrl = true;
      }
      const clean = sanitizeStoredMeta(obj);
      if (clean) sanitized.push(clean);
    }
    if (hadLegacySecretUrl) {
      await AsyncStorage.setItem(key, JSON.stringify(sanitized)).catch(() => undefined);
    }
    return sanitized;
  } catch {
    return [];
  }
}

async function saveStoredLink(senderAddress: string, meta: StoredSenderLinkMeta): Promise<void> {
  const current = await readStoredLinks(senderAddress);
  const clean = sanitizeStoredMeta(meta as unknown as Record<string, unknown>);
  if (!clean) return;
  const filtered = current.filter((item) => item.balanceId !== clean.balanceId);
  await AsyncStorage.setItem(
    `${CREATED_LINKS_STORAGE_PREFIX}${senderAddress}`,
    JSON.stringify([clean, ...filtered]),
  );
}

export async function markSenderLinkReclaimed(
  senderAddress: string,
  balanceId: string,
): Promise<void> {
  try {
    const stored = await readStoredLinks(senderAddress);
    const hit = stored.find((s) => s.balanceId === balanceId);
    if (hit) {
      await saveStoredLink(senderAddress, { ...hit, reclaimedBySender: true });
    }
  } catch {
    // Non-fatal local hint update.
  }
}

function extractBalanceIdFromSubmit(result: unknown): string | null {
  const direct = (result as { balance_id?: unknown })?.balance_id;
  if (typeof direct === 'string' && direct.length > 0) return direct;
  return null;
}

/**
 * Create a claimable-balance link on Stellar and return its shareable bearer URL.
 *
 * Enforces strict idempotency per `confirmationId`: a double-tap while in flight
 * or after completion resolves to the single created link without submitting a
 * second transaction.
 */
export async function createSenderClaimLink(
  input: CreateSenderClaimLinkInput,
): Promise<CreatedSenderClaimLink> {
  const key = input.confirmationId.trim();
  if (!key) {
    throw new Error('Missing confirmation identifier for claim link creation.');
  }
  const alreadyCompleted = completedByConfirmation.get(key);
  if (alreadyCompleted) return alreadyCompleted;

  const existingInFlight = inFlightByConfirmation.get(key);
  if (existingInFlight) return existingInFlight;

  const task = executeCreateSenderClaimLink(input).then(
    (created) => {
      inFlightByConfirmation.delete(key);
      completedByConfirmation.set(key, created);
      smartWalletFundedByConfirmation.delete(key);
      return created;
    },
    (err) => {
      inFlightByConfirmation.delete(key);
      throw err;
    },
  );

  inFlightByConfirmation.set(key, task);
  return task;
}

async function executeCreateSenderClaimLink(
  input: CreateSenderClaimLinkInput,
): Promise<CreatedSenderClaimLink> {
  const noteError = validateClaimLinkNote(input.note);
  if (noteError) throw new Error(noteError);

  const cleanAmount = input.amount.trim();
  let amountStroops = 0n;
  try {
    amountStroops = decimalToStroops(cleanAmount);
  } catch {
    throw new Error('Enter a valid amount greater than zero.');
  }
  if (amountStroops <= 0n) {
    throw new Error('Enter an amount greater than zero.');
  }

  const { stellarAsset, assetCode, assetIssuer } = resolveClaimLinkStellarAsset(input.asset);

  const expirySeconds = input.expirySeconds ?? DEFAULT_LINK_EXPIRY_SECONDS;
  if (!Number.isFinite(expirySeconds) || expirySeconds <= 0) {
    throw new Error('Choose a valid link expiry duration.');
  }

  const nowUnix = input.nowUnix ?? Math.floor(Date.now() / 1000);
  const expiresAt = nowUnix + Math.floor(expirySeconds);
  const cleanNote = input.note?.trim() ? input.note.trim() : null;
  const feeStr = inclusionFee();
  const cost = estimateClaimLinkCost(cleanAmount, assetCode, feeStr);

  const ephemeral = Keypair.random();
  const claimants = [
    new Claimant(ephemeral.publicKey(), Claimant.predicateUnconditional()),
    new Claimant(
      input.signer.publicKey,
      Claimant.predicateNot(Claimant.predicateBeforeAbsoluteTime(expiresAt.toString())),
    ),
  ];

  const net = getNetwork();
  const server = new Horizon.Server(net.horizonUrl);
  const account = await server.loadAccount(input.signer.publicKey);

  const tx = new TransactionBuilder(account, {
    fee: feeStr,
    networkPassphrase: net.networkPassphrase,
  })
    .addOperation(
      Operation.createClaimableBalance({
        asset: stellarAsset,
        amount: cleanAmount,
        claimants,
      }),
    )
    .setTimeout(60)
    .build();

  input.signer.sign(tx);

  let submitRes: Horizon.HorizonApi.SubmitTransactionResponse;
  try {
    submitRes = await server.submitTransaction(tx);
  } catch (err) {
    const data = (err as { response?: { data?: unknown } })?.response?.data;
    const readable = horizonErrorMessage(data);
    throw new Error(readable || (err instanceof Error ? err.message : 'Could not create claim link.'));
  }

  let balanceId =
    extractBalanceIdFromSubmit(submitRes) ??
    (typeof tx.getClaimableBalanceId === 'function' ? tx.getClaimableBalanceId(0) : null);
  if (!balanceId) {
    const cbPage = await (
      server as unknown as {
        claimableBalances: () => {
          claimant: (addr: string) => {
            limit: (n: number) => {
              order: (dir: 'asc' | 'desc') => {
                call: () => Promise<{ records?: { id?: string }[] }>;
              };
            };
          };
        };
      }
    )
      .claimableBalances()
      .claimant(ephemeral.publicKey())
      .limit(1)
      .order('desc')
      .call();
    balanceId = cbPage?.records?.[0]?.id ?? null;
  }

  if (!balanceId) {
    throw new Error('Claimable balance was submitted, but Horizon did not return its balance ID.');
  }

  const claimUrl = buildVerifiedClaimUrl({
    balanceId,
    ephemeralSecret: ephemeral.secret(),
    amount: cleanAmount,
    assetCode,
    assetIssuer,
    expiresAt,
    note: cleanNote,
    network: net.name,
  });

  const meta: StoredSenderLinkMeta = {
    balanceId,
    amount: cleanAmount,
    assetCode,
    assetIssuer,
    expiresAt,
    createdAt: nowUnix,
    network: net.name,
    note: cleanNote,
    ephemeralAddress: ephemeral.publicKey(),
  };

  await saveStoredLink(input.signer.publicKey, meta);

  return {
    ...meta,
    claimUrl,
    txHash: submitRes.hash,
    cost,
  };
}

/**
 * Load the sender's created claim links and resolve each link's live status
 * from Horizon (`unclaimed`, `claimed`, `expired`, `reclaimed`, or
 * `status_unknown` when history could not be checked).
 */
export async function loadSenderClaimLinksOnChain(
  senderAddress: string,
  opts: { nowUnix?: number } = {},
): Promise<SenderCreatedLinkView[]> {
  const nowUnix = opts.nowUnix ?? Math.floor(Date.now() / 1000);
  const net = getNetwork();
  const server = new Horizon.Server(net.horizonUrl);

  const [storedAll, page] = await Promise.all([
    readStoredLinks(senderAddress),
    (
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
    )
      .claimableBalances()
      .sponsor(senderAddress)
      .limit(100)
      .order('desc')
      .call(),
  ]);

  const stored = storedAll.filter((entry) => !entry.network || entry.network === net.name);
  const liveRecords = Array.isArray(page?.records) ? page.records : [];
  const liveMap = new Map<string, Record<string, unknown>>();
  for (const r of liveRecords) {
    if (typeof r.id === 'string' && r.id) liveMap.set(r.id, r);
  }

  const storedMap = new Map<string, StoredSenderLinkMeta>();
  for (const s of stored) storedMap.set(s.balanceId, s);

  const out: SenderCreatedLinkView[] = [];
  const seen = new Set<string>();

  for (const rec of liveRecords) {
    const id = String(rec.id ?? '');
    if (!id) continue;
    seen.add(id);
    const local = storedMap.get(id);
    const { code, issuer } = parseHorizonAsset(String(rec.asset ?? 'native'));
    const expiresAt =
      extractReclaimDeadlineUnix(rec.claimants) ??
      local?.expiresAt ??
      nowUnix + DEFAULT_LINK_EXPIRY_SECONDS;
    const expired = nowUnix >= expiresAt;

    out.push({
      balanceId: id,
      amount: String(rec.amount ?? local?.amount ?? '0'),
      assetCode: code,
      assetIssuer: issuer,
      expiresAt,
      createdAt: local?.createdAt ?? nowUnix,
      network: net.name,
      note: local?.note ?? null,
      ephemeralAddress: local?.ephemeralAddress,
      reclaimedBySender: false,
      status: expired ? 'expired' : 'unclaimed',
      canReclaim: expired,
      reserveHeldXlm: CLAIM_LINK_RESERVE_XLM,
    });
  }

  for (const local of stored) {
    if (seen.has(local.balanceId) || liveMap.has(local.balanceId)) continue;
    seen.add(local.balanceId);

    const history = await resolveConsumedBalanceHistory(server, local.balanceId);
    let status: SenderLinkChainStatus;
    if (history.status === 'claimed') {
      status = history.claimant === senderAddress ? 'reclaimed' : 'claimed';
    } else {
      status = 'status_unknown';
    }

    out.push({
      ...local,
      status,
      canReclaim: false,
      reserveHeldXlm: '0',
    });
  }

  return out;
}

/**
 * Ensure the sender's classic account holds a trustline for `asset` before
 * routing an issued asset out of the smart wallet to create a claim link.
 */
export async function ensureClassicTrustlineForClaimLink(
  signer: WalletSigner,
  asset: { code: string; issuer: string },
): Promise<void> {
  const net = getNetwork();
  const server = new Horizon.Server(net.horizonUrl);
  const account = await server.loadAccount(signer.publicKey);
  const balances = (account.balances ?? []) as {
    asset_code?: string;
    asset_issuer?: string;
  }[];
  const exists = balances.some(
    (b) => b.asset_code === asset.code && b.asset_issuer === asset.issuer,
  );
  if (exists) return;

  const tx = new TransactionBuilder(account, {
    fee: inclusionFee(),
    networkPassphrase: net.networkPassphrase,
  })
    .addOperation(Operation.changeTrust({ asset: new Asset(asset.code, asset.issuer) }))
    .setTimeout(60)
    .build();
  signer.sign(tx);
  await server.submitTransaction(tx);
}

function isOpDoesNotExist(err: unknown): boolean {
  const { opCodes } = extractHorizonResultCodes(err);
  return opCodes.includes('op_does_not_exist');
}

type BalanceEntryLike = {
  asset_type?: string;
  asset_code?: string;
  asset_issuer?: string;
  balance?: string;
  selling_liabilities?: string;
};

async function waitForNextLedger(
  server: Horizon.Server,
  claimLedger: number | undefined,
): Promise<void> {
  if (typeof claimLedger !== 'number' || !Number.isFinite(claimLedger) || claimLedger <= 0) {
    return;
  }
  const ledgersFn = (
    server as unknown as {
      ledgers?: () => {
        order: (dir: 'asc' | 'desc') => {
          limit: (n: number) => {
            call: () => Promise<{ records?: { sequence?: number }[] }>;
          };
        };
      };
    }
  ).ledgers;
  if (typeof ledgersFn !== 'function') return;

  for (let attempt = 0; attempt < 12; attempt += 1) {
    try {
      const page = await ledgersFn.call(server).order('desc').limit(1).call();
      const latest = page?.records?.[0]?.sequence;
      if (typeof latest === 'number' && latest > claimLedger) {
        return;
      }
    } catch {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 1_200));
  }
}

function hasSweepingWorkForRecipient(
  ephemeralAccount: Horizon.AccountResponse,
  recipientPublicKey: string,
): boolean {
  const ephBalances = (ephemeralAccount.balances ?? []) as BalanceEntryLike[];
  const hasPositiveBalance = ephBalances.some((b) => Number(b.balance ?? '0') > 0);
  if (hasPositiveBalance) return true;
  const sponsor = (ephemeralAccount as unknown as { sponsor?: string }).sponsor;
  return sponsor === recipientPublicKey;
}

async function sweepFundedEphemeralIntoRecipient(params: {
  server: Horizon.Server;
  networkPassphrase: string;
  signer: WalletSigner;
  recipientAccount: Horizon.AccountResponse;
  recipientBalances: BalanceEntryLike[];
  ephemeralKeypair: Keypair;
  ephemeralAccount: Horizon.AccountResponse;
}): Promise<RecipientClaimResult> {
  const {
    server,
    networkPassphrase,
    signer,
    recipientAccount,
    recipientBalances,
    ephemeralKeypair,
    ephemeralAccount,
  } = params;
  const ephPub = ephemeralKeypair.publicKey();
  const ephBalances = (ephemeralAccount.balances ?? []) as BalanceEntryLike[];
  const builder = new TransactionBuilder(recipientAccount, {
    fee: inclusionFee(),
    networkPassphrase,
  });

  let sweptAssetCode = 'XLM';
  let sweptAssetIssuer: string | null = null;
  let sweptAmount = '0';

  for (const b of ephBalances) {
    if (b.asset_type === 'native') {
      sweptAmount = b.balance ?? '0';
      continue;
    }
    if (!b.asset_code || !b.asset_issuer) continue;
    const creditAsset = new Asset(b.asset_code, b.asset_issuer);
    const hasCredit = Number(b.balance ?? '0') > 0;
    if (hasCredit) {
      sweptAssetCode = b.asset_code;
      sweptAssetIssuer = b.asset_issuer;
      sweptAmount = b.balance ?? '0';
      const destHasTrust = recipientBalances.some(
        (rb) => rb.asset_code === b.asset_code && rb.asset_issuer === b.asset_issuer,
      );
      if (!destHasTrust) {
        builder.addOperation(Operation.changeTrust({ asset: creditAsset }));
      }
      builder.addOperation(
        Operation.payment({
          destination: signer.publicKey,
          asset: creditAsset,
          amount: b.balance ?? '0',
          source: ephPub,
        }),
      );
    }
    builder.addOperation(
      Operation.changeTrust({
        asset: creditAsset,
        limit: '0',
        source: ephPub,
      }),
    );
  }

  builder.addOperation(
    Operation.accountMerge({
      destination: signer.publicKey,
      source: ephPub,
    }),
  );

  const tx = builder.setTimeout(60).build();
  signer.sign(tx);
  tx.sign(ephemeralKeypair);
  const res = await server.submitTransaction(tx);

  return {
    status: 'claimed',
    txHash: res.hash,
    mergeTxHash: res.hash,
    reserveReleased: true,
    reserveReleaseTxHash: res.hash,
    amount: sweptAmount,
    assetCode: sweptAssetCode,
    assetIssuer: sweptAssetIssuer,
  };
}

function formatReserveReleaseError(err: unknown): string {
  const data = (err as { response?: { data?: unknown } })?.response?.data;
  const readable = horizonErrorMessage(data);
  if (readable) return readable;
  if (err instanceof Error && err.message) return err.message;
  return 'Could not release the 1 XLM sponsor reserve.';
}

async function submitReserveReleaseMerge(params: {
  server: Horizon.Server;
  networkPassphrase: string;
  signer: WalletSigner;
  ephemeralKeypair: Keypair;
  feeStr: string;
  waitAfterLedger?: number;
  checkAlreadyGoneOnError?: boolean;
}): Promise<ReserveReleaseRetryResult> {
  const {
    server,
    networkPassphrase,
    signer,
    ephemeralKeypair,
    feeStr,
    waitAfterLedger,
    checkAlreadyGoneOnError,
  } = params;
  const ephPub = ephemeralKeypair.publicKey();
  try {
    if (typeof waitAfterLedger === 'number') {
      await waitForNextLedger(server, waitAfterLedger);
    }
    const refreshedRecipient = await server.loadAccount(signer.publicKey);
    const mergeTx = new TransactionBuilder(refreshedRecipient, {
      fee: feeStr,
      networkPassphrase,
    })
      .addOperation(
        Operation.accountMerge({
          destination: signer.publicKey,
          source: ephPub,
        }),
      )
      .setTimeout(60)
      .build();
    signer.sign(mergeTx);
    mergeTx.sign(ephemeralKeypair);
    const mergeRes = await server.submitTransaction(mergeTx);
    return { released: true, txHash: mergeRes.hash };
  } catch (err) {
    if (checkAlreadyGoneOnError) {
      try {
        await server.loadAccount(ephPub);
      } catch (checkErr) {
        if (isNotFoundError(checkErr)) {
          return { released: true, txHash: null };
        }
      }
    }
    return { released: false, error: formatReserveReleaseError(err) };
  }
}

/**
 * Retry Tx 2 (`accountMerge`) to release the 1 XLM sponsored base reserve
 * held on the one-time claimant account after Tx 1 already delivered the funds.
 */
export async function retryReleaseClaimReserve(params: {
  signer: WalletSigner;
  ephemeralSecret: string;
}): Promise<ReserveReleaseRetryResult> {
  const cleanSecret = params.ephemeralSecret.trim();
  if (!StrKey.isValidEd25519SecretSeed(cleanSecret)) {
    return {
      released: false,
      error: 'The link bearer secret is missing. Reopen the original claim link to retry.',
    };
  }
  const net = getNetwork();
  const server = new Horizon.Server(net.horizonUrl);
  return submitReserveReleaseMerge({
    server,
    networkPassphrase: net.networkPassphrase,
    signer: params.signer,
    ephemeralKeypair: Keypair.fromSecret(cleanSecret),
    feeStr: inclusionFee(),
    checkAlreadyGoneOnError: true,
  });
}

/**
 * Claim a bearer link using the recipient's active classic spending signer
 * (`requireSigner()`):
 *  - Tx 1 (atomic claim + immediate delivery): sponsors a `0-XLM` one-time
 *    account (`beginSponsoringFutureReserves` + `createAccount('0')` +
 *    `endSponsoringFutureReserves`), claims the balance, and immediately sends
 *    100% of the claimed XLM or issued asset to `signer.publicKey` in the same
 *    transaction (closing any temporary trustline). Because the one-time
 *    account holds `0` XLM, there is zero bait-link window and zero stranding
 *    of claimed funds, while avoiding Stellar's `op_seq_num_too_far` rule on
 *    merging an account in the ledger that created it.
 *  - Tx 2 (next-ledger reserve release): once the next ledger closes (~5s),
 *    merges the empty sponsored one-time account to release `signer`'s 1 XLM
 *    sponsored base reserve; if interrupted, retry finishes the merge cleanly.
 */
export async function claimLinkWithSpendingAccount(params: {
  signer: WalletSigner;
  balanceId: string;
  ephemeralSecret: string;
  linkNetwork?: VeilNetworkName | null;
}): Promise<RecipientClaimResult> {
  const cleanSecret = params.ephemeralSecret.trim();
  if (!StrKey.isValidEd25519SecretSeed(cleanSecret)) {
    throw new Error(
      'This claim link is missing a valid bearer secret. Open the full link shared with you.',
    );
  }
  const ephemeralKeypair = Keypair.fromSecret(cleanSecret);
  const ephPub = ephemeralKeypair.publicKey();
  const net = getNetwork();
  const server = new Horizon.Server(net.horizonUrl);

  const inspection = await inspectClaimLinkForOpener(
    params.balanceId,
    {
      horizonUrl: net.horizonUrl,
      networkPassphrase: net.networkPassphrase,
    },
    {
      linkNetwork: params.linkNetwork ?? null,
      activeNetwork: net.name,
    },
  );

  if (
    inspection.state === 'network_mismatch' ||
    inspection.state === 'not_found' ||
    inspection.state === 'status_unknown'
  ) {
    throw new Error(inspection.message);
  }

  let recipientAccount: Horizon.AccountResponse;
  try {
    recipientAccount = await server.loadAccount(params.signer.publicKey);
  } catch (err) {
    if (isNotFoundError(err)) {
      throw new Error(
        'Your Spending account has not been funded on this network yet. Add XLM to cover the claim fee and try again.',
      );
    }
    throw err;
  }
  const recipientBalances = (recipientAccount.balances ?? []) as BalanceEntryLike[];

  let ephemeralAccount: Horizon.AccountResponse | null = null;
  try {
    ephemeralAccount = await server.loadAccount(ephPub);
  } catch (err) {
    if (!isNotFoundError(err)) {
      throw err;
    }
  }

  if (inspection.state === 'claimed_by_other' || inspection.state === 'expired_and_reclaimed') {
    if (ephemeralAccount && hasSweepingWorkForRecipient(ephemeralAccount, params.signer.publicKey)) {
      return sweepFundedEphemeralIntoRecipient({
        server,
        networkPassphrase: net.networkPassphrase,
        signer: params.signer,
        recipientAccount,
        recipientBalances,
        ephemeralKeypair,
        ephemeralAccount,
      });
    }
    return { status: 'already_claimed', message: inspection.message };
  }

  if (!inspection.amount || !inspection.assetCode) {
    throw new Error('Could not read the asset or amount of this claimable balance from Horizon.');
  }

  if (
    inspection.claimantAddresses.length > 0 &&
    !inspection.claimantAddresses.includes(ephPub)
  ) {
    throw new Error('This claim link secret does not match the on-chain claimable balance.');
  }

  const isNative = inspection.assetCode === 'XLM' && !inspection.assetIssuer;
  if (!isNative && (!inspection.assetIssuer || !StrKey.isValidEd25519PublicKey(inspection.assetIssuer))) {
    throw new Error(`Invalid issuer on claimable balance for ${inspection.assetCode}.`);
  }
  const issuedAsset = isNative
    ? null
    : new Asset(inspection.assetCode, inspection.assetIssuer as string);

  const nativeEntry = recipientBalances.find((b) => b.asset_type === 'native');
  const nativeBal = Number(nativeEntry?.balance ?? '0');
  const sellingLiab = Number(nativeEntry?.selling_liabilities ?? '0');
  const subentries = Number(
    (recipientAccount as unknown as { subentry_count?: number }).subentry_count ?? 0,
  );
  const numSponsoring = Number(
    (recipientAccount as unknown as { num_sponsoring?: number }).num_sponsoring ?? 0,
  );
  const numSponsored = Number(
    (recipientAccount as unknown as { num_sponsored?: number }).num_sponsored ?? 0,
  );
  const ownReserve = Math.max(0, 2 + subentries + numSponsoring - numSponsored) * 0.5;
  const spareXlm = Math.max(0, nativeBal - ownReserve - sellingLiab);

  const recipientHasTrust = issuedAsset
    ? recipientBalances.some(
        (b) => b.asset_code === issuedAsset.getCode() && b.asset_issuer === issuedAsset.getIssuer(),
      )
    : true;

  const ephemeralExists = ephemeralAccount !== null;
  const ephemeralHasTrust =
    issuedAsset && ephemeralAccount
      ? ((ephemeralAccount.balances ?? []) as BalanceEntryLike[]).some(
          (b) =>
            b.asset_code === issuedAsset.getCode() && b.asset_issuer === issuedAsset.getIssuer(),
        )
      : false;

  const tempSponsoredXlm = ephemeralExists
    ? issuedAsset && !ephemeralHasTrust
      ? 0.5
      : 0
    : issuedAsset
      ? 1.5
      : 1;
  const trustlineXlm = !recipientHasTrust && issuedAsset ? 0.5 : 0;
  const requiredSpare = tempSponsoredXlm + trustlineXlm + 0.05;

  if (spareXlm < requiredSpare) {
    throw new Error(
      `Your Spending account needs at least ${requiredSpare.toFixed(2)} XLM above its reserve to complete this claim (${tempSponsoredXlm > 0 ? 'temporary reserve is released automatically right after claiming' : 'for network fees'}).`,
    );
  }

  const feeStr = inclusionFee();
  const claimBuilder = new TransactionBuilder(recipientAccount, {
    fee: feeStr,
    networkPassphrase: net.networkPassphrase,
  });

  if (issuedAsset && !recipientHasTrust) {
    claimBuilder.addOperation(Operation.changeTrust({ asset: issuedAsset }));
  }
  if (!ephemeralExists) {
    claimBuilder.addOperation(Operation.beginSponsoringFutureReserves({ sponsoredId: ephPub }));
    claimBuilder.addOperation(
      Operation.createAccount({
        destination: ephPub,
        startingBalance: '0',
      }),
    );
    if (issuedAsset) {
      claimBuilder.addOperation(
        Operation.changeTrust({
          asset: issuedAsset,
          source: ephPub,
        }),
      );
    }
    claimBuilder.addOperation(Operation.endSponsoringFutureReserves({ source: ephPub }));
  } else if (issuedAsset && !ephemeralHasTrust) {
    claimBuilder.addOperation(Operation.beginSponsoringFutureReserves({ sponsoredId: ephPub }));
    claimBuilder.addOperation(
      Operation.changeTrust({
        asset: issuedAsset,
        source: ephPub,
      }),
    );
    claimBuilder.addOperation(Operation.endSponsoringFutureReserves({ source: ephPub }));
  }

  claimBuilder
    .addOperation(
      Operation.claimClaimableBalance({
        balanceId: params.balanceId,
        source: ephPub,
      }),
    )
    .addOperation(
      Operation.payment({
        destination: params.signer.publicKey,
        asset: issuedAsset ?? Asset.native(),
        amount: inspection.amount,
        source: ephPub,
      }),
    );

  if (issuedAsset) {
    claimBuilder.addOperation(
      Operation.changeTrust({
        asset: issuedAsset,
        limit: '0',
        source: ephPub,
      }),
    );
  }

  const claimTx = claimBuilder.setTimeout(60).build();
  params.signer.sign(claimTx);
  claimTx.sign(ephemeralKeypair);

  let claimRes: Horizon.HorizonApi.SubmitTransactionResponse;
  try {
    claimRes = await server.submitTransaction(claimTx);
  } catch (err) {
    if (isOpDoesNotExist(err)) {
      return { status: 'already_claimed', message: ALREADY_CLAIMED_MESSAGE };
    }
    const data = (err as { response?: { data?: unknown } })?.response?.data;
    const readable = horizonErrorMessage(data);
    throw new Error(readable || (err instanceof Error ? err.message : 'Could not claim this link.'));
  }

  // Tx 2: release the 1 XLM sponsored base reserve by merging the empty
  // one-time account once the ledger advances past `claimRes.ledger`.
  // Never swallow a failed merge silently — surface it so the caller retains
  // the link secret and lets the user retry releasing the 1 XLM reserve.
  const claimLedger = (claimRes as unknown as { ledger?: number }).ledger;
  const release = await submitReserveReleaseMerge({
    server,
    networkPassphrase: net.networkPassphrase,
    signer: params.signer,
    ephemeralKeypair,
    feeStr,
    waitAfterLedger: !ephemeralExists ? claimLedger : undefined,
  });

  return {
    status: 'claimed',
    txHash: claimRes.hash,
    mergeTxHash: release.released ? release.txHash : null,
    reserveReleased: release.released,
    ...(release.released && release.txHash ? { reserveReleaseTxHash: release.txHash } : {}),
    ...(!release.released ? { reserveReleaseError: release.error } : {}),
    amount: inspection.amount,
    assetCode: inspection.assetCode,
    assetIssuer: inspection.assetIssuer,
  };
}
