/**
 * The Veil names this user already holds.
 *
 * The names screen opened on an empty claim form for the holder of a name, as
 * if they had none (2026-11-11). It could answer "is `jack` yours" once the
 * name was typed, but it could not say "you hold `jack`" unprompted, because
 * the registry cannot be asked that question: it stores `name -> record` and
 * nothing the other way round. `balance(account)` says how many, never which.
 *
 * So the names are found in two steps.
 *
 *   1. Candidates. Every registration a Veil user makes is a transaction from
 *      their spending account: the web wallet registers AS that account, and
 *      the phone uses it as the source of the wallet's own call. Horizon keeps
 *      those operations with their arguments, so the names are read from the
 *      account's history. Names this phone has itself seen to be the user's
 *      are remembered too, which covers a history Horizon no longer has.
 *   2. Proof. A candidate is only a string somebody once registered. Each one
 *      is put to the registry, and it is shown only while it is active AND
 *      points at one of this user's two addresses.
 *
 * A name the user has pointed at somebody else is not listed: from the outside
 * that is indistinguishable from a name they gave away.
 *
 * The scan is incremental. The first visit reads back through the account's
 * history; later visits read only what is newer than the last operation seen.
 */

import AsyncStorage from '@react-native-async-storage/async-storage';
import { nativeToScVal, scValToNative, xdr } from '@stellar/stellar-sdk';

import { simulateRead } from './contractInvoke';
import { normalizeName, validateName } from './names';
import { getNetwork } from './network';
import type { OwnAddresses } from './ownAddresses';
import { namesContractId } from './veilIans';

/** Horizon's largest page. */
const PAGE_SIZE = 200;
/** How far back the first visit reads: 1,000 operations. */
const MAX_PAGES = 5;
const FETCH_TIMEOUT_MS = 10_000;

/** Registry calls that carry a name as their second argument. */
const NAMING_CALLS = new Set(['register', 'renew']);

export interface OwnedName {
  /** The bare name, without the `*useveilapp.xyz` suffix. */
  name: string;
  /** The address the name points at. Always one of the user's own. */
  pointsAt: string;
  /** Which of the user's two accounts that is. */
  account: 'wallet' | 'spending';
  /** When the term runs out, in Unix seconds. Null when it could not be read. */
  expiresAt: number | null;
}

export interface OwnedNames {
  names: OwnedName[];
  /**
   * False when something could not be read. An empty list that is not complete
   * means "could not check", never "you hold no name".
   */
  complete: boolean;
}

interface Stored {
  /** Names worth asking the registry about again. */
  names: string[];
  /** Per account: the newest operation already read. */
  cursors: Record<string, string>;
}

export interface HorizonPage {
  /** 404 is an answer: the account does not exist on this network. */
  status: number;
  records: unknown[];
}

export interface OwnedNamesDeps {
  registryId: string;
  network: string;
  horizonUrl: string;
  fetchPage: (url: string) => Promise<HorizonPage>;
  read: typeof simulateRead;
}

export function knownNamesKey(network: string): string {
  return `veil_known_names_${network}`;
}

async function fetchPage(url: string): Promise<HorizonPage> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(url, { signal: controller.signal });
    if (!res.ok) return { status: res.status, records: [] };
    const body = (await res.json()) as { _embedded?: { records?: unknown } };
    const records = body?._embedded?.records;
    return { status: res.status, records: Array.isArray(records) ? records : [] };
  } finally {
    clearTimeout(timer);
  }
}

function defaultDeps(): OwnedNamesDeps {
  const network = getNetwork();
  return {
    registryId: namesContractId(),
    network: network.name,
    horizonUrl: network.horizonUrl,
    fetchPage,
    read: simulateRead,
  };
}

async function readStore(network: string): Promise<Stored> {
  try {
    const raw = await AsyncStorage.getItem(knownNamesKey(network));
    const parsed = raw ? (JSON.parse(raw) as Partial<Stored>) : null;
    const names = Array.isArray(parsed?.names)
      ? parsed.names.filter((n): n is string => typeof n === 'string' && isName(n))
      : [];
    const cursors: Record<string, string> = {};
    if (parsed?.cursors && typeof parsed.cursors === 'object') {
      for (const [account, cursor] of Object.entries(parsed.cursors)) {
        if (typeof cursor === 'string' && cursor) cursors[account] = cursor;
      }
    }
    return { names, cursors };
  } catch {
    return { names: [], cursors: {} };
  }
}

async function writeStore(network: string, stored: Stored): Promise<void> {
  try {
    await AsyncStorage.setItem(knownNamesKey(network), JSON.stringify(stored));
  } catch {
    // The list is rebuilt from the chain on the next visit.
  }
}

function isName(value: string): boolean {
  return value.length > 0 && value === normalizeName(value) && validateName(value) === null;
}

function decode(param: unknown): unknown {
  const value = (param as { value?: unknown } | null)?.value;
  if (typeof value !== 'string') return null;
  try {
    return scValToNative(xdr.ScVal.fromXDR(value, 'base64'));
  } catch {
    return null;
  }
}

function pagingToken(record: unknown): string | null {
  const token = (record as { paging_token?: unknown } | null)?.paging_token;
  return typeof token === 'string' && token ? token : null;
}

/**
 * The names an account's operations registered or renewed with `registryId`.
 *
 * Horizon lists a contract call's arguments as `[contract, function, ...args]`,
 * each a base64 `ScVal`. Both `register(buyer, name, years)` and
 * `renew(payer, name, years)` carry the name fourth. Anything that does not
 * decode to a well-formed name is skipped: this reads a public API's JSON.
 */
export function namesFromOperations(records: readonly unknown[], registryId: string): string[] {
  const found = new Set<string>();
  for (const record of records) {
    const op = record as {
      type?: unknown;
      transaction_successful?: unknown;
      parameters?: unknown;
    } | null;
    if (!op || op.type !== 'invoke_host_function') continue;
    if (op.transaction_successful === false) continue;
    const params = op.parameters;
    if (!Array.isArray(params) || params.length < 4) continue;
    if (decode(params[0]) !== registryId) continue;
    const method = decode(params[1]);
    if (typeof method !== 'string' || !NAMING_CALLS.has(method)) continue;
    const name = decode(params[3]);
    if (typeof name === 'string' && isName(name)) found.add(name);
  }
  return [...found];
}

interface Scan {
  names: string[];
  /** The newest operation read, to resume from. Null when nothing was read. */
  cursor: string | null;
  complete: boolean;
}

/**
 * Read an account's operations for names.
 *
 * With `since`, only what came after it, oldest first. Without, the most
 * recent `MAX_PAGES` pages, newest first.
 */
async function scanAccount(
  account: string,
  since: string | null,
  deps: OwnedNamesDeps
): Promise<Scan> {
  const base =
    `${deps.horizonUrl.replace(/\/+$/, '')}/accounts/${account}/operations` +
    `?limit=${PAGE_SIZE}&include_failed=false&order=${since ? 'asc' : 'desc'}`;

  const names = new Set<string>();
  let newest = since;
  let next = since;

  try {
    for (let page = 0; page < MAX_PAGES; page += 1) {
      const res = await deps.fetchPage(next ? `${base}&cursor=${next}` : base);
      if (res.status === 404) return { names: [], cursor: since, complete: true };
      if (res.status < 200 || res.status >= 300) {
        return { names: [...names], cursor: since, complete: false };
      }

      for (const name of namesFromOperations(res.records, deps.registryId)) names.add(name);

      const last = pagingToken(res.records[res.records.length - 1]);
      if (since) {
        // Oldest first: each page moves the resume point forward.
        if (last) newest = last;
      } else if (page === 0) {
        // Newest first: the first record of the first page is the newest.
        newest = pagingToken(res.records[0]);
      }

      if (res.records.length < PAGE_SIZE || !last) break;
      next = last;
    }
    return { names: [...names], cursor: newest, complete: true };
  } catch {
    // Keep the old resume point so the same stretch is read again next time.
    return { names: [...names], cursor: since, complete: false };
  }
}

type Verdict = OwnedName | 'unreadable' | 'lapsed' | 'not-mine';

const str = (value: string) => nativeToScVal(value, { type: 'string' });

async function askRegistry(
  name: string,
  own: OwnAddresses,
  deps: OwnedNamesDeps
): Promise<Verdict> {
  const state = await deps.read(deps.registryId, 'state', [str(name)]);
  const code = typeof state === 'bigint' ? Number(state) : state;
  // 0 Active, 1 Recovery, 2 Open.
  if (code === 2) return 'not-mine';
  if (code === 1) return 'lapsed';
  if (code !== 0) return 'unreadable';

  const target = await deps.read(deps.registryId, 'resolve', [str(name)]);
  // An active name always resolves, so nothing here is a read that failed.
  if (typeof target !== 'string') return 'unreadable';

  const account = target === own.wallet ? 'wallet' : target === own.spending ? 'spending' : null;
  if (!account) return 'not-mine';

  const expiry = await deps.read(deps.registryId, 'expires_at', [str(name)]);
  const expiresAt =
    typeof expiry === 'bigint' ? Number(expiry) : typeof expiry === 'number' ? expiry : null;

  return { name, pointsAt: target, account, expiresAt };
}

/**
 * The names held by either of the user's accounts.
 *
 * Never throws. What could not be read is reported through `complete`.
 */
export async function loadOwnedNames(
  own: OwnAddresses,
  deps: OwnedNamesDeps = defaultDeps()
): Promise<OwnedNames> {
  if (!deps.registryId) return { names: [], complete: true };
  if (!own.wallet && !own.spending) return { names: [], complete: true };

  const stored = await readStore(deps.network);
  const candidates = new Set(stored.names);
  const cursors = { ...stored.cursors };
  let complete = true;

  // Horizon only knows classic accounts, and every registration is sent from
  // this one whichever account ends up holding the name.
  if (own.spending) {
    const scan = await scanAccount(own.spending, cursors[own.spending] ?? null, deps);
    for (const name of scan.names) candidates.add(name);
    if (scan.cursor) cursors[own.spending] = scan.cursor;
    if (!scan.complete) complete = false;
  }

  const verdicts = await Promise.all(
    [...candidates].map(async (name) => ({ name, verdict: await askRegistry(name, own, deps) }))
  );

  const names: OwnedName[] = [];
  const keep: string[] = [];
  for (const { name, verdict } of verdicts) {
    if (verdict === 'not-mine') continue;
    keep.push(name);
    if (verdict === 'unreadable') complete = false;
    else if (verdict !== 'lapsed') names.push(verdict);
  }
  names.sort((a, b) => a.name.localeCompare(b.name));

  await writeStore(deps.network, { names: keep.sort(), cursors });
  return { names, complete };
}

/**
 * Remember a name this phone has just seen to be the user's: one it registered,
 * or one the registry said points at them. It is still proved against the
 * registry every time it is shown.
 */
export async function rememberOwnName(name: string, network = getNetwork().name): Promise<void> {
  const bare = normalizeName(name);
  if (!isName(bare)) return;
  const stored = await readStore(network);
  if (stored.names.includes(bare)) return;
  await writeStore(network, { ...stored, names: [...stored.names, bare].sort() });
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** `9 Nov 2027`, in the phone's own timezone. */
export function formatNameDate(unixSeconds: number): string {
  const date = new Date(unixSeconds * 1000);
  return `${date.getDate()} ${MONTHS[date.getMonth()]} ${date.getFullYear()}`;
}
