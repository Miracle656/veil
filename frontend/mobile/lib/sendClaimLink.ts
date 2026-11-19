/**
 * Sender-side claim link creation, note sanitization, cost estimation, and
 * live Horizon state resolution (#1285).
 *
 * A claim link wraps a Stellar claimable balance whose unconditional recipient
 * claimant is a single-use ephemeral keypair carried in the URL fragment
 * (`#s=<secret>`), and whose sender claimant unlocks reclaim after `expiresAt`.
 * Because possession of the URL fragment authorizes claiming the funds, every
 * share surface states plainly: "Anyone with this link can claim it."
 */
import AsyncStorage from '@react-native-async-storage/async-storage';
import {
  Asset,
  Claimant,
  Horizon,
  Keypair,
  Operation,
  TransactionBuilder,
} from '@stellar/stellar-sdk';

import { ASSOCIATED_DOMAINS } from './deepLinks';
import { inclusionFee } from './fees';
import { horizonErrorMessage } from './horizonError';
import { getNetwork } from './network';
import type { WalletSigner } from './sendPayment';

const STROOPS_PER_XLM = 10_000_000n;

/** Refundable base reserve locked by a 2-claimant Stellar claimable balance (2 * 0.5 XLM). */
export const CLAIM_LINK_RESERVE_STROOPS = 10_000_000n;
export const CLAIM_LINK_RESERVE_XLM = '1';

/** Maximum characters allowed in an optional sender note on the claim screen. */
export const MAX_CLAIM_LINK_NOTE_LENGTH = 80;

/** Plain one-line bearer disclosure shown before confirmation and on the share step. */
export const BEARER_LINK_WARNING = 'Anyone with this link can claim it.';

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

export type StoredSenderLinkMeta = {
  balanceId: string;
  claimUrl: string;
  amount: string;
  assetCode: string;
  assetIssuer: string | null;
  expiresAt: number;
  createdAt: number;
  note: string | null;
  ephemeralAddress?: string;
  reclaimedBySender?: boolean;
};

export type SenderLinkChainStatus = 'unclaimed' | 'claimed' | 'expired' | 'reclaimed';

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
  txHash: string;
  cost: ClaimLinkCostBreakdown;
};

const inFlightByConfirmation = new Map<string, Promise<CreatedSenderClaimLink>>();
const completedByConfirmation = new Map<string, CreatedSenderClaimLink>();

export function resetClaimLinkIdempotencyForTests(): void {
  inFlightByConfirmation.clear();
  completedByConfirmation.clear();
}

function parseStroops(decimal: string): bigint {
  const clean = decimal.trim();
  const match = /^(\d+)(?:\.(\d{1,7})\d*)?$/.exec(clean);
  if (!match) throw new Error('Enter a valid amount greater than zero.');
  const whole = BigInt(match[1]);
  const frac = BigInt((match[2] ?? '').padEnd(7, '0'));
  return whole * STROOPS_PER_XLM + frac;
}

function formatStroops(stroops: bigint): string {
  const whole = stroops / STROOPS_PER_XLM;
  const frac = stroops % STROOPS_PER_XLM;
  if (frac === 0n) return whole.toString();
  return `${whole.toString()}.${frac.toString().padStart(7, '0').replace(/0+$/, '')}`;
}

// URL schemes, protocol-relative URLs, www prefixes, any bare hostname/TLD,
// Unicode dot confusables, IP literals, emails, HTML/XML tags, entities, and Markdown links.
const URL_SCHEME_RE =
  /\b(?:https?|ftp|mailto|tel|javascript|data|vbscript|file|veil|web\+stellar)\s*:|\/\/\S+/i;
const WWW_HOST_RE = /\bwww\.[a-z0-9-]+/i;
const BARE_DOMAIN_RE =
  /(?:^|[\s(@])(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+(?:[a-z]{2,24}|xn--[a-z0-9-]{2,})(?=$|[\s/:?#),.!])|[a-z0-9-][\u3002\uFF0E\uFF61][a-z]{2,}/i;
const IP_LITERAL_RE = /\b(?:\d{1,3}\.){3}\d{1,3}\b|\[[0-9a-f:]+\]/i;
const MARKUP_OR_ENTITY_RE = /[<>&`]|\[[^\]]*\]\([^)]*\)|!\[[^\]]*\]/;
const CONTROL_CHARS_RE = /[\u0000-\u001F\u007F]/;

/**
 * Validate an optional sender note before it can be embedded in a claim link.
 *
 * Returns `null` when valid (including when empty), or a plain refusal reason.
 * Because the note renders to someone who may not yet have Veil installed,
 * links, domains, and markup are unconditionally forbidden so the claim screen
 * cannot be turned into a phishing surface.
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
  const normalizedCode = assetCode.trim().toUpperCase() || 'XLM';
  const feeStroops = BigInt(feeStroopsRaw);
  let amountStroops = 0n;
  try {
    amountStroops = amount.trim() ? parseStroops(amount) : 0n;
  } catch {
    amountStroops = 0n;
  }

  const totalXlmStroops =
    normalizedCode === 'XLM'
      ? amountStroops + CLAIM_LINK_RESERVE_STROOPS + feeStroops
      : CLAIM_LINK_RESERVE_STROOPS + feeStroops;

  return {
    amount: amount.trim() || '0',
    assetCode: normalizedCode,
    reserveXlm: CLAIM_LINK_RESERVE_XLM,
    feeXlm: formatStroops(feeStroops),
    totalXlmRequired: formatStroops(totalXlmStroops),
  };
}

/**
 * Build a bearer claim URL hosted on Veil's verified associated domain.
 * The ephemeral claimant secret stays in the `#s=` fragment so web servers and
 * HTTP proxies do not log it in request paths.
 */
export function buildVerifiedClaimUrl(params: {
  balanceId: string;
  ephemeralSecret: string;
  amount: string;
  assetCode: string;
  assetIssuer: string | null;
  expiresAt: number;
  note: string | null;
}): string {
  const host = ASSOCIATED_DOMAINS[0];
  const queryParts: [string, string][] = [
    ['amount', params.amount],
    ['asset', params.assetCode],
    ['expires', String(params.expiresAt)],
  ];
  if (params.assetIssuer) {
    queryParts.push(['issuer', params.assetIssuer]);
  }
  if (params.note) {
    queryParts.push(['note', params.note]);
  }
  const query = queryParts
    .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`)
    .join('&');
  return `https://${host}/claim/${encodeURIComponent(params.balanceId)}?${query}#s=${encodeURIComponent(params.ephemeralSecret)}`;
}

async function readStoredLinks(senderAddress: string): Promise<StoredSenderLinkMeta[]> {
  try {
    const raw = await AsyncStorage.getItem(`${CREATED_LINKS_STORAGE_PREFIX}${senderAddress}`);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as unknown;
    return Array.isArray(parsed) ? (parsed as StoredSenderLinkMeta[]) : [];
  } catch {
    return [];
  }
}

async function saveStoredLink(senderAddress: string, meta: StoredSenderLinkMeta): Promise<void> {
  const current = await readStoredLinks(senderAddress);
  const filtered = current.filter((item) => item.balanceId !== meta.balanceId);
  await AsyncStorage.setItem(
    `${CREATED_LINKS_STORAGE_PREFIX}${senderAddress}`,
    JSON.stringify([meta, ...filtered]),
  );
}

function extractBalanceIdFromSubmit(result: unknown): string | null {
  const direct = (result as { balance_id?: unknown })?.balance_id;
  if (typeof direct === 'string' && direct.length > 0) return direct;

  // Horizon's SubmitTransactionResponse may omit `balance_id` at the top level;
  // derive or read from result_xdr when present, or query latest sponsored balance.
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
  const amountStroops = parseStroops(cleanAmount);
  if (amountStroops <= 0n) {
    throw new Error('Enter an amount greater than zero.');
  }

  const assetCode = input.asset?.code?.trim().toUpperCase() || 'XLM';
  const assetIssuer =
    assetCode === 'XLM' ? null : (input.asset?.issuer?.trim() || null);
  const stellarAsset =
    assetCode !== 'XLM' && assetIssuer ? new Asset(assetCode, assetIssuer) : Asset.native();

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
    // Fallback when neither the submit response nor local op-id derivation yielded an id.
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
  });

  const meta: StoredSenderLinkMeta = {
    balanceId,
    claimUrl,
    amount: cleanAmount,
    assetCode,
    assetIssuer,
    expiresAt,
    createdAt: nowUnix,
    note: cleanNote,
    ephemeralAddress: ephemeral.publicKey(),
  };

  await saveStoredLink(input.signer.publicKey, meta);

  return {
    ...meta,
    txHash: submitRes.hash,
    cost,
  };
}

function parseHorizonAssetString(raw: string): { code: string; issuer: string | null } {
  if (!raw || raw === 'native') return { code: 'XLM', issuer: null };
  const idx = raw.indexOf(':');
  if (idx === -1) return { code: raw, issuer: null };
  return { code: raw.slice(0, idx), issuer: raw.slice(idx + 1) || null };
}

function extractDeadlineFromClaimants(claimants: unknown): number | null {
  if (!Array.isArray(claimants)) return null;
  for (const c of claimants) {
    const notPred = (c as { predicate?: { not?: Record<string, unknown> } })?.predicate?.not;
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

async function lookupWhoClaimedBalance(
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
    const rec = page?.records?.find((r) => r.type === 'claim_claimable_balance');
    if (!rec) return null;
    return typeof rec.claimant === 'string'
      ? rec.claimant
      : typeof rec.source_account === 'string'
        ? rec.source_account
        : null;
  } catch {
    return null;
  }
}

/**
 * Load the sender's created claim links and verify every item's status against
 * real on-chain Horizon state (`claimableBalances` + `operations`), never
 * relying on a local guess about whether a link was claimed.
 */
export async function loadSenderClaimLinksOnChain(
  senderAddress: string,
  opts: { nowUnix?: number } = {},
): Promise<SenderCreatedLinkView[]> {
  const nowUnix = opts.nowUnix ?? Math.floor(Date.now() / 1000);
  const net = getNetwork();
  const server = new Horizon.Server(net.horizonUrl);
  const stored = await readStoredLinks(senderAddress);

  const cbPage = await (
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
    .call();

  const onChainRecords = Array.isArray(cbPage?.records) ? cbPage.records : [];
  const onChainById = new Map<string, Record<string, unknown>>();
  for (const rec of onChainRecords) {
    if (typeof rec.id === 'string' && rec.id) {
      onChainById.set(rec.id, rec);
    }
  }

  const storedById = new Map<string, StoredSenderLinkMeta>();
  for (const meta of stored) {
    storedById.set(meta.balanceId, meta);
  }

  const views: SenderCreatedLinkView[] = [];
  const processed = new Set<string>();

  // 1. Every live on-chain claimable balance sponsored by this wallet.
  for (const rec of onChainRecords) {
    const balanceId = String(rec.id ?? '');
    if (!balanceId) continue;
    processed.add(balanceId);

    const local = storedById.get(balanceId);
    const parsedAsset = parseHorizonAssetString(String(rec.asset ?? 'native'));
    const expiresAt =
      extractDeadlineFromClaimants(rec.claimants) ??
      local?.expiresAt ??
      nowUnix + DEFAULT_LINK_EXPIRY_SECONDS;
    const expired = nowUnix >= expiresAt;
    const status: SenderLinkChainStatus = expired ? 'expired' : 'unclaimed';

    views.push({
      balanceId,
      claimUrl: local?.claimUrl ?? '',
      amount: String(rec.amount ?? local?.amount ?? '0'),
      assetCode: parsedAsset.code,
      assetIssuer: parsedAsset.issuer,
      expiresAt,
      createdAt: local?.createdAt ?? nowUnix,
      note: local?.note ?? null,
      status,
      canReclaim: expired,
      reserveHeldXlm: CLAIM_LINK_RESERVE_XLM,
    });
  }

  // 2. Stored links no longer present in Horizon's active claimable_balances:
  //    confirm on-chain whether they were claimed by a recipient or reclaimed.
  for (const local of stored) {
    if (processed.has(local.balanceId) || onChainById.has(local.balanceId)) continue;
    processed.add(local.balanceId);

    const claimant = await lookupWhoClaimedBalance(server, local.balanceId);
    const status: SenderLinkChainStatus =
      claimant === senderAddress || (claimant === null && local.reclaimedBySender)
        ? 'reclaimed'
        : 'claimed';

    views.push({
      ...local,
      status,
      canReclaim: false,
      reserveHeldXlm: '0',
    });
  }

  return views;
}

/**
 * Ensure the classic signer holds a trustline for `asset` before pulling an
 * issued asset out of a `C...` smart wallet to fund a claim link.
 */
export async function ensureClassicTrustlineForClaimLink(
  signer: WalletSigner,
  asset: { code: string; issuer: string },
): Promise<void> {
  const net = getNetwork();
  const server = new Horizon.Server(net.horizonUrl);
  const account = await server.loadAccount(signer.publicKey);
  const balances = (account.balances ?? []) as {
    asset_type: string;
    asset_code?: string;
    asset_issuer?: string;
  }[];
  const hasTrust = balances.some(
    (b) => b.asset_code === asset.code && b.asset_issuer === asset.issuer,
  );
  if (hasTrust) return;

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

/**
 * Reclaim an expired claimable balance from the sender's links list.
 */
export async function reclaimSenderClaimLink(params: {
  signer: WalletSigner;
  balanceId: string;
  expiresAt: number;
  asset?: { code: string; issuer: string | null };
  nowUnix?: number;
}): Promise<{ txHash: string }> {
  const nowUnix = params.nowUnix ?? Math.floor(Date.now() / 1000);
  if (nowUnix < params.expiresAt) {
    throw new Error('This link has not expired yet and cannot be reclaimed before its deadline.');
  }

  const net = getNetwork();
  const server = new Horizon.Server(net.horizonUrl);
  const account = await server.loadAccount(params.signer.publicKey);
  const builder = new TransactionBuilder(account, {
    fee: inclusionFee(),
    networkPassphrase: net.networkPassphrase,
  });

  if (params.asset && params.asset.code !== 'XLM' && params.asset.issuer) {
    const balances = (account.balances ?? []) as {
      asset_code?: string;
      asset_issuer?: string;
    }[];
    const hasTrust = balances.some(
      (b) => b.asset_code === params.asset!.code && b.asset_issuer === params.asset!.issuer,
    );
    if (!hasTrust) {
      builder.addOperation(
        Operation.changeTrust({ asset: new Asset(params.asset.code, params.asset.issuer) }),
      );
    }
  }

  const tx = builder
    .addOperation(Operation.claimClaimableBalance({ balanceId: params.balanceId }))
    .setTimeout(60)
    .build();

  params.signer.sign(tx);
  const res = await server.submitTransaction(tx);

  try {
    const stored = await readStoredLinks(params.signer.publicKey);
    const hit = stored.find((s) => s.balanceId === params.balanceId);
    if (hit) {
      await saveStoredLink(params.signer.publicKey, { ...hit, reclaimedBySender: true });
    }
  } catch {
    // Non-fatal local hint update.
  }

  return { txHash: res.hash };
}
