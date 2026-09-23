/**
 * Shielded payment pool (SPP) circuit artifacts — download, cache, verify.
 *
 * Proving against a pool policy needs its circuits: an r1cs and a proving
 * key — 8.1 MB + 4.1 MB for the block-list pool, ~12 MB per policy. They must
 * not ship inside the APK (every install would pay for one pool's circuits,
 * frozen at build time), so they are fetched on first use and cached under the
 * app's document directory instead. Nothing here adds an asset or a native
 * dependency: the APK grows by this JavaScript and nothing else.
 *
 * A tampered file must never be used, so every artifact is checked against
 * SPP's published checksums — the circuit lockfile — *before* it is handed
 * out, not only when it lands:
 *
 *   - {@link ensureCircuits} is the only way to obtain artifact paths, and it
 *     never returns one it has not just verified. A checksum mismatch deletes
 *     the file and throws {@link CircuitChecksumError}; there is no code path
 *     that proves with an unverified circuit.
 *   - The lockfile itself is fetched over https from a pinned URL, so the
 *     expected SHA-256 is not attacker-choiceable in transit. A validated copy
 *     is kept so an offline device can still verify the circuits it holds.
 *
 * Downloads are resumable: bytes arrive as ranged chunk requests appended to
 * a `.part` file, so a dropped connection costs only the chunk in flight —
 * the next call continues from the last byte written instead of starting
 * over. Network failures raise {@link CircuitDownloadError} and keep the
 * partial file; only integrity failures delete bytes.
 *
 * Progress is reported through `onProgress`, and the UI can warn cellular
 * users before starting with {@link estimateCircuitDownload} plus
 * {@link circuitDownloadHint}.
 *
 * ```ts
 * const bytes = await estimateCircuitDownload('block-list');
 * const hint = circuitDownloadHint(connectionType, bytes); // Wi-Fi hint
 * const circuits = await ensureCircuits('block-list', { onProgress: report });
 * prove({ r1cs: circuits.r1cs.uri, pk: circuits.provingKey.uri });
 * ```
 */

import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex } from '@noble/hashes/utils.js';
import { Directory, File, Paths } from 'expo-file-system';

import { errorMessage } from '../errorMessage';

// ── Artifact and lockfile types ────────────────────────────────────────────────

/** The artifact kinds that make up a pool policy's circuit set. */
export const CIRCUIT_ARTIFACT_NAMES = ['r1cs', 'provingKey'] as const;

export type CircuitArtifactName = (typeof CIRCUIT_ARTIFACT_NAMES)[number];

/** One artifact's entry in SPP's published circuit lockfile. */
export type CircuitArtifactLock = {
  /** An `https://` URL, or a path relative to the lockfile's own location. */
  path: string;
  /** Exact size in bytes — the progress total and a pre-hash integrity check. */
  sizeBytes: number;
  /** Lowercase hex SHA-256 of the artifact's bytes. */
  sha256: string;
};

/** SPP's published checksums — "the circuit lockfile". */
export type CircuitLockfile = {
  /** Schema generation. A different generation is rejected, never guessed at. */
  version: number;
  /** Checksums keyed by `<pool policy>/<artifact>`, e.g. `block-list/r1cs`. */
  artifacts: Record<string, CircuitArtifactLock>;
};

/** Lockfile schema generation this module understands. */
export const CIRCUIT_LOCKFILE_VERSION = 1;

/**
 * Where the lockfile is published. Override per environment with
 * `EXPO_PUBLIC_SPP_LOCKFILE_URL` — it must be https, since it is the root of
 * trust for everything downloaded after it.
 */
export const DEFAULT_LOCKFILE_URL =
  process.env['EXPO_PUBLIC_SPP_LOCKFILE_URL']?.trim()
  || 'https://app.useveilapp.xyz/spp/circuits.lock.json';

// ── Errors ─────────────────────────────────────────────────────────────────────

/** Base class for every failure this module reports. */
export class CircuitError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CircuitError';
  }
}

/** The lockfile is missing, malformed, unsupported, or lacks the policy. */
export class CircuitLockfileError extends CircuitError {
  constructor(message: string) {
    super(message);
    this.name = 'CircuitLockfileError';
  }
}

/**
 * The download could not run or was interrupted. The bytes received so far
 * are kept, so the next attempt resumes rather than restarting.
 */
export class CircuitDownloadError extends CircuitError {
  constructor(message: string) {
    super(message);
    this.name = 'CircuitDownloadError';
  }
}

/**
 * An artifact does not match the lockfile's SHA-256 — it was altered in
 * transit, at rest, or the lockfile and server disagree. The file is deleted
 * and proving is refused.
 */
export class CircuitChecksumError extends CircuitError {
  constructor(message: string) {
    super(message);
    this.name = 'CircuitChecksumError';
  }
}

// ── Progress ───────────────────────────────────────────────────────────────────

/** A progress event for one artifact of a policy. */
export type CircuitProgress = {
  policy: string;
  artifact: CircuitArtifactName;
  /** `downloading` while bytes arrive, `verifying` while they are hashed. */
  phase: 'downloading' | 'verifying';
  receivedBytes: number;
  totalBytes: number;
  /** `receivedBytes / totalBytes`, clamped to 0…1. */
  fraction: number;
};

function emitProgress(
  onProgress: ((progress: CircuitProgress) => void) | undefined,
  policy: string,
  artifact: CircuitArtifactName,
  phase: CircuitProgress['phase'],
  receivedBytes: number,
  totalBytes: number
): void {
  onProgress?.({
    policy,
    artifact,
    phase,
    receivedBytes,
    totalBytes,
    fraction: totalBytes > 0 ? Math.min(1, receivedBytes / totalBytes) : 0,
  });
}

// ── Network port ───────────────────────────────────────────────────────────────

/**
 * The slice of `fetch` this module needs. Typed structurally so tests can
 * script a range-serving server without a Response polyfill.
 */
export type CircuitFetchResponse = {
  ok: boolean;
  status: number;
  headers: { get(name: string): string | null };
  arrayBuffer(): Promise<ArrayBuffer>;
  text(): Promise<string>;
};

export type CircuitFetch = (
  url: string,
  init?: { headers?: Record<string, string> }
) => Promise<CircuitFetchResponse>;

const defaultFetch: CircuitFetch = (url, init) => fetch(url, init);

// ── Storage port ───────────────────────────────────────────────────────────────

/**
 * The slice of the device filesystem this module needs. Every path is the
 * opaque id returned by {@link CircuitStore.path}, so an in-memory
 * implementation can stand in for tests.
 */
export interface CircuitStore {
  /** Absolute id (a `file://` URI on device) for `name` inside the cache dir. */
  path(name: string): string;
  exists(path: string): Promise<boolean>;
  /** Size in bytes; 0 when the file does not exist. */
  size(path: string): Promise<number>;
  read(path: string): Promise<Uint8Array>;
  readText(path: string): Promise<string>;
  /** Create-or-overwrite. */
  write(path: string, data: Uint8Array): Promise<void>;
  /** Create-or-overwrite with text. */
  writeText(path: string, text: string): Promise<void>;
  /** Create the file if needed and add `data` to its end. */
  append(path: string, data: Uint8Array): Promise<void>;
  remove(path: string): Promise<void>;
  /** Move/rename `from` to `to`, replacing `to` if it exists. */
  move(from: string, to: string): Promise<void>;
}

/** Sub-directory of the document directory the circuit cache lives in. */
const CACHE_DIR_NAME = 'veil-circuits';

/** Cached copy of the last lockfile that parsed successfully. */
const LOCKFILE_CACHE_NAME = 'lockfile.json';

class ExpoCircuitStore implements CircuitStore {
  private readonly directory: Directory;

  constructor(directory: Directory) {
    this.directory = directory;
  }

  path(name: string): string {
    return new File(this.directory, name).uri;
  }

  async exists(path: string): Promise<boolean> {
    return new File(path).exists;
  }

  async size(path: string): Promise<number> {
    const file = new File(path);
    return file.exists ? file.size : 0;
  }

  async read(path: string): Promise<Uint8Array> {
    return new File(path).bytes();
  }

  async readText(path: string): Promise<string> {
    return new File(path).text();
  }

  async write(path: string, data: Uint8Array): Promise<void> {
    const file = new File(path);
    file.create({ overwrite: true, intermediates: true });
    file.write(data);
  }

  async writeText(path: string, text: string): Promise<void> {
    const file = new File(path);
    file.create({ overwrite: true, intermediates: true });
    file.write(text);
  }

  async append(path: string, data: Uint8Array): Promise<void> {
    const file = new File(path);
    if (!file.exists) {
      file.create({ intermediates: true });
      file.write(data);
      return;
    }
    // A handle seeked to the file's end appends in place — rewriting the whole
    // partial on every chunk would rewrite ~12 MB up to a dozen times.
    const end = file.size;
    const handle = file.open();
    try {
      handle.offset = end;
      handle.writeBytes(data);
    } finally {
      handle.close();
    }
  }

  async remove(path: string): Promise<void> {
    const file = new File(path);
    if (file.exists) file.delete();
  }

  async move(from: string, to: string): Promise<void> {
    const source = new File(from);
    const destination = new File(to);
    if (destination.exists) destination.delete();
    source.move(destination);
  }
}

let cachedStore: CircuitStore | undefined;

/**
 * The real device store: `<document dir>/veil-circuits/`. The document
 * directory (not the cache directory) is deliberate — partial downloads and
 * verified artifacts must survive for resume to mean anything; the OS is
 * free to clear a cache directory at any moment.
 */
export function defaultCircuitStore(): CircuitStore {
  if (!cachedStore) {
    const directory = new Directory(Paths.document, CACHE_DIR_NAME);
    if (!directory.exists) directory.create({ intermediates: true });
    cachedStore = new ExpoCircuitStore(directory);
  }
  return cachedStore;
}

// ── Lockfile parsing, keys and URL resolution ─────────────────────────────────

/** `<policy>/<artifact>`, the key an artifact is published under. */
export function circuitArtifactKey(policy: string, artifact: CircuitArtifactName): string {
  return `${policy}/${artifact}`;
}

const POLICY_PATTERN = /^[a-z0-9][a-z0-9-]{0,63}$/;
const ARTIFACT_KEY_PATTERN = new RegExp(
  `^[a-z0-9][a-z0-9-]{0,63}/(${CIRCUIT_ARTIFACT_NAMES.join('|')})$`
);
const SHA256_HEX_PATTERN = /^[0-9a-f]{64}$/i;

/**
 * Policy ids double as file names, so anything that could escape the cache
 * directory (`/`, `..`, dots, uppercase) is rejected up front.
 */
function assertPolicyId(policy: string): void {
  if (!POLICY_PATTERN.test(policy)) {
    throw new CircuitError(
      `Invalid pool policy id "${policy}" — ids are lowercase letters, digits and dashes, because they are used as file names`
    );
  }
}

/**
 * Validate an untrusted JSON value as a circuit lockfile.
 *
 * Everything the download later trusts is checked here: the schema generation,
 * the `<policy>/<artifact>` shape of every key (those keys become file
 * names), a positive integer size, and a hex SHA-256. Checksums are
 * normalised to lowercase so comparison later cannot be defeated by casing.
 *
 * @throws {CircuitLockfileError} on anything that is not a lockfile this
 *                               module provably understands.
 */
export function parseCircuitLockfile(raw: unknown): CircuitLockfile {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new CircuitLockfileError('SPP lockfile is not a JSON object');
  }
  const source = raw as Record<string, unknown>;
  if (source.version !== CIRCUIT_LOCKFILE_VERSION) {
    throw new CircuitLockfileError(
      `SPP lockfile version ${JSON.stringify(source.version) ?? 'unknown'} is not supported ` +
        `(expected ${CIRCUIT_LOCKFILE_VERSION}) — update the app to use these circuits`
    );
  }
  const artifacts = source.artifacts;
  if (!artifacts || typeof artifacts !== 'object' || Array.isArray(artifacts)) {
    throw new CircuitLockfileError('SPP lockfile has no artifacts map');
  }

  const parsed: Record<string, CircuitArtifactLock> = {};
  for (const [key, value] of Object.entries(artifacts as Record<string, unknown>)) {
    if (!ARTIFACT_KEY_PATTERN.test(key)) {
      throw new CircuitLockfileError(
        `SPP lockfile entry "${key}" is not a <pool policy>/<artifact> pair`
      );
    }
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      throw new CircuitLockfileError(`SPP lockfile entry "${key}" is not an object`);
    }
    const entry = value as Record<string, unknown>;
    if (typeof entry.path !== 'string' || entry.path.trim() === '') {
      throw new CircuitLockfileError(`SPP lockfile entry "${key}" has no artifact path`);
    }
    if (
      typeof entry.sizeBytes !== 'number'
      || !Number.isSafeInteger(entry.sizeBytes)
      || entry.sizeBytes <= 0
    ) {
      throw new CircuitLockfileError(
        `SPP lockfile entry "${key}" has no valid sizeBytes (a positive integer is required)`
      );
    }
    if (typeof entry.sha256 !== 'string' || !SHA256_HEX_PATTERN.test(entry.sha256)) {
      throw new CircuitLockfileError(
        `SPP lockfile entry "${key}" has no valid sha256 (64 hex characters are required)`
      );
    }
    parsed[key] = {
      path: entry.path,
      sizeBytes: entry.sizeBytes,
      sha256: entry.sha256.toLowerCase(),
    };
  }

  if (Object.keys(parsed).length === 0) {
    throw new CircuitLockfileError('SPP lockfile lists no artifacts');
  }
  return { version: CIRCUIT_LOCKFILE_VERSION, artifacts: parsed };
}

/** The lockfile entry for one artifact; a policy we cannot verify is fatal. */
function requireEntry(
  lockfile: CircuitLockfile,
  policy: string,
  artifact: CircuitArtifactName
): CircuitArtifactLock {
  const key = circuitArtifactKey(policy, artifact);
  const entry = lockfile.artifacts[key];
  if (!entry) {
    throw new CircuitLockfileError(
      `SPP lockfile lists no circuit for "${key}" — refusing to prove against a circuit we cannot verify`
    );
  }
  return entry;
}

/** Resolve `.`/`..` segments without ever leaving the URL's origin. */
function normalizeUrlPath(path: string): string {
  const segments: string[] = [];
  for (const segment of path.split('/')) {
    if (segment === '' || segment === '.') continue;
    if (segment === '..') {
      // Popping past the root is a no-op, so `..` can never escape the host.
      segments.pop();
      continue;
    }
    segments.push(segment);
  }
  return `/${segments.join('/')}`;
}

/**
 * Resolve a lockfile artifact path to the URL to fetch.
 *
 * Both sides must be https: the lockfile is the root of trust, and an `http:`
 * or protocol-relative reference would let the checksums themselves be
 * rewritten in transit. Absolute `https://` paths are taken as given;
 * everything else resolves relative to the lockfile's own location.
 *
 * @throws {CircuitLockfileError} for a non-https lockfile URL or artifact path.
 */
export function resolveArtifactUrl(lockfileUrl: string, artifactPath: string): string {
  if (!lockfileUrl.startsWith('https://')) {
    throw new CircuitLockfileError(
      `The SPP lockfile URL must be https:// — checksums fetched over anything else prove nothing (got "${lockfileUrl}")`
    );
  }
  if (artifactPath.startsWith('https://')) return artifactPath;
  if (artifactPath.startsWith('//') || /^[a-z][a-z0-9+.-]*:/i.test(artifactPath)) {
    throw new CircuitLockfileError(
      `Circuit artifact path "${artifactPath}" must be an https:// URL or a path relative to the lockfile`
    );
  }

  const originEnd = lockfileUrl.indexOf('/', 'https://'.length);
  const origin = originEnd === -1 ? lockfileUrl : lockfileUrl.slice(0, originEnd);
  const basePath = originEnd === -1 ? '/' : lockfileUrl.slice(originEnd);

  if (artifactPath.startsWith('/')) return origin + normalizeUrlPath(artifactPath);
  const directory = basePath.slice(0, basePath.lastIndexOf('/') + 1);
  return origin + normalizeUrlPath(directory + artifactPath);
}

// ── Small helpers ──────────────────────────────────────────────────────────────

/** Hex SHA-256 of `bytes`, the form the lockfile publishes. */
export function sha256Hex(bytes: Uint8Array): string {
  return bytesToHex(sha256(bytes));
}

/** `12.2 MB` / `512 KB` — the units the UI quotes for a download. */
export function formatBytes(bytes: number): string {
  if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  if (bytes >= 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${bytes} B`;
}

/**
 * The Wi-Fi hint for a download of `totalBytes`, or `null` when there is
 * nothing to warn about.
 *
 * `connectionType` is `useConnectivity().connectionType` — the NetInfo type
 * (`wifi`, `cellular`, `none`, `unknown`, …). Only cellular earns a hint: on
 * Wi-Fi there is nothing to warn about, and offline is the offline screen's
 * concern, not this one.
 */
export function circuitDownloadHint(connectionType: string, totalBytes: number): string | null {
  if (connectionType !== 'cellular') return null;
  return `${formatBytes(totalBytes)} over mobile data — Wi-Fi recommended.`;
}

/**
 * How many bytes fetching `policy`'s circuits costs, read from the lockfile
 * without downloading the artifacts — what the Wi-Fi hint quotes before the
 * user commits to a download.
 *
 * @throws {CircuitLockfileError} if the lockfile is unavailable, malformed,
 *                               or lacks the policy.
 */
export async function estimateCircuitDownload(
  policy: string,
  options: EnsureCircuitsOptions = {}
): Promise<number> {
  assertPolicyId(policy);
  const store = options.store ?? defaultCircuitStore();
  const fetchFn = options.fetchFn ?? defaultFetch;
  const { lockfile } = await loadLockfile(options, store, fetchFn);
  return (
    requireEntry(lockfile, policy, 'r1cs').sizeBytes
    + requireEntry(lockfile, policy, 'provingKey').sizeBytes
  );
}

// ── Download ───────────────────────────────────────────────────────────────────

/** Bytes per ranged request. A dropped connection loses at most one chunk. */
const DEFAULT_CHUNK_BYTES = 1024 * 1024;

/** `<policy>.<artifact>` — a verified artifact's file name in the cache. */
function finalFileName(policy: string, artifact: CircuitArtifactName): string {
  return `${policy}.${artifact}`;
}

/** `<policy>.<artifact>.part` — the in-progress download. */
function partFileName(policy: string, artifact: CircuitArtifactName): string {
  return `${finalFileName(policy, artifact)}.part`;
}

/** `bytes start-end/total` from a 206 response, or null when unparseable. */
function parseContentRange(
  value: string | null
): { start: number; end: number; total: number } | null {
  const match = /^bytes (\d+)-(\d+)\/(\d+|\*)$/.exec(value ?? '');
  if (!match) return null;
  return {
    start: Number(match[1]),
    end: Number(match[2]),
    total: match[3] === '*' ? -1 : Number(match[3]),
  };
}

type DownloadParams = {
  store: CircuitStore;
  fetchFn: CircuitFetch;
  url: string;
  partPath: string;
  entry: CircuitArtifactLock;
  policy: string;
  artifact: CircuitArtifactName;
  onProgress?: (progress: CircuitProgress) => void;
  chunkBytes: number;
};

/**
 * Fetch `entry` into its `.part` file, continuing from whatever is already
 * there.
 *
 * Each iteration requests the next byte range and appends it, so progress is
 * durable between chunks: a connection drop (or an app killed mid-download)
 * costs only the chunk in flight, and the next call re-requests from the last
 * byte written. The part file is only promoted or discarded by the caller —
 * network failures never delete it; integrity failures do.
 */
async function downloadResumable(params: DownloadParams): Promise<void> {
  const { store, fetchFn, url, partPath, entry, policy, artifact, onProgress, chunkBytes } =
    params;
  const label = circuitArtifactKey(policy, artifact);

  let received = await store.size(partPath);
  if (received > entry.sizeBytes) {
    // Left over from an older lockfile generation — it can never verify
    // against the current one, so start clean rather than resume corrupted.
    await store.remove(partPath);
    received = 0;
  }
  emitProgress(onProgress, policy, artifact, 'downloading', received, entry.sizeBytes);

  let restarted = false;

  while (received < entry.sizeBytes) {
    const start = received;
    const end = Math.min(start + chunkBytes - 1, entry.sizeBytes - 1);

    let response: CircuitFetchResponse;
    let chunk: Uint8Array;
    try {
      response = await fetchFn(url, { headers: { Range: `bytes=${start}-${end}` } });
      if (response.status === 416) {
        // Not a byte on disk's fault — the server cannot serve this range.
        // The partial file stays for the next attempt.
        throw new CircuitDownloadError(
          `${label}: the server rejected the resume range (HTTP 416); try again once reconnected`
        );
      }
      if (response.status !== 200 && response.status !== 206) {
        throw new CircuitDownloadError(`${label}: download failed with HTTP ${response.status}`);
      }
      chunk = new Uint8Array(await response.arrayBuffer());
    } catch (error) {
      if (error instanceof CircuitError) throw error;
      // A dropped connection: everything received so far stays in the part
      // file, and the next call resumes from `start` instead of restarting.
      throw new CircuitDownloadError(
        `${label}: download interrupted after ${formatBytes(start)} of ` +
          `${formatBytes(entry.sizeBytes)} — ${errorMessage(error)}`
      );
    }

    if (chunk.length === 0) {
      throw new CircuitDownloadError(
        `${label}: the server returned an empty body for bytes ${start}-${end}`
      );
    }

    if (response.status === 206) {
      const contentRange = parseContentRange(response.headers.get('content-range'));
      if (contentRange && contentRange.start !== start) {
        // Bytes from an unknown offset cannot be spliced in safely.
        await store.remove(partPath);
        throw new CircuitChecksumError(
          `${label}: the server sent bytes from offset ${contentRange.start} where ` +
            `${start} was requested — the partial file was deleted rather than trusted`
        );
      }
      if (contentRange && contentRange.total !== -1 && contentRange.total !== entry.sizeBytes) {
        // The lockfile and the server disagree about what the artifact even
        // is. Nothing downloaded against both accounts can be trusted.
        await store.remove(partPath);
        throw new CircuitChecksumError(
          `${label}: the server reports ${contentRange.total} bytes but the lockfile ` +
            `pins ${entry.sizeBytes} — the partial file was deleted rather than trusted`
        );
      }
    } else if (start > 0) {
      // HTTP 200 while a range was requested: the server ignored the Range
      // header and is resending from byte 0. That body cannot be appended to
      // what we hold, so discard the prefix and take it as the new start —
      // a resume only degrades to a restart when the server cannot resume.
      if (restarted) {
        throw new CircuitDownloadError(
          `${label}: the server does not support resumable downloads; try again on Wi-Fi`
        );
      }
      restarted = true;
      received = 0;
    }

    if (received + chunk.length > entry.sizeBytes) {
      // More bytes than the lockfile pins: they cannot all belong to this
      // artifact, so nothing written so far can be trusted either.
      await store.remove(partPath);
      throw new CircuitChecksumError(
        `${label}: the server sent more than the ${entry.sizeBytes} bytes the lockfile ` +
          `pins — the partial file was deleted rather than trusted`
      );
    }

    if (received === 0) await store.write(partPath, chunk);
    else await store.append(partPath, chunk);
    received += chunk.length;
    emitProgress(onProgress, policy, artifact, 'downloading', received, entry.sizeBytes);
  }
}

// ── Lockfile loading ───────────────────────────────────────────────────────────

/** The last lockfile that validated — what an offline device verifies against. */
async function readCachedLockfile(store: CircuitStore): Promise<CircuitLockfile | null> {
  try {
    const path = store.path(LOCKFILE_CACHE_NAME);
    if (!(await store.exists(path))) return null;
    return parseCircuitLockfile(JSON.parse(await store.readText(path)) as unknown);
  } catch {
    return null;
  }
}

/**
 * Load SPP's lockfile: fresh over https when the network cooperates, falling
 * back to the last copy that validated so a device that already has its
 * circuits can still verify them offline. The fresh copy is cached only after
 * it parses, so the fallback is never a file we failed to understand.
 *
 * @throws {CircuitLockfileError} when neither the network nor the cache can
 *                               supply a valid lockfile.
 */
async function loadLockfile(
  options: EnsureCircuitsOptions,
  store: CircuitStore,
  fetchFn: CircuitFetch
): Promise<{ lockfile: CircuitLockfile; url: string }> {
  const url = options.lockfileUrl ?? DEFAULT_LOCKFILE_URL;
  if (!url.startsWith('https://')) {
    throw new CircuitLockfileError(
      `The SPP lockfile URL must be https:// — checksums fetched over anything else prove nothing (got "${url}")`
    );
  }

  try {
    const response = await fetchFn(url, { headers: { Accept: 'application/json' } });
    if (!response.ok) {
      throw new CircuitLockfileError(`SPP lockfile request failed with HTTP ${response.status}`);
    }
    const body = await response.text();
    const lockfile = parseCircuitLockfile(JSON.parse(body) as unknown);
    try {
      await store.writeText(store.path(LOCKFILE_CACHE_NAME), body);
    } catch {
      // Losing the offline copy is harmless while we are online.
    }
    return { lockfile, url };
  } catch (error) {
    const cached = await readCachedLockfile(store);
    if (cached) return { lockfile: cached, url };
    throw error instanceof CircuitError
      ? error
      : new CircuitLockfileError(`SPP lockfile could not be loaded: ${errorMessage(error)}`);
  }
}

// ── Verification ───────────────────────────────────────────────────────────────

/** Does the file at `path` have exactly the bytes the lockfile pins? */
async function matchesEntry(
  store: CircuitStore,
  path: string,
  entry: CircuitArtifactLock
): Promise<boolean> {
  // Size first: a truncated or padded file is already wrong, and skipping the
  // hash for it saves hashing a file that can never match.
  const bytes = await store.read(path);
  return bytes.length === entry.sizeBytes && sha256Hex(bytes) === entry.sha256;
}

type EnsureArtifactParams = {
  store: CircuitStore;
  fetchFn: CircuitFetch;
  lockfileUrl: string;
  policy: string;
  artifact: CircuitArtifactName;
  entry: CircuitArtifactLock;
  onProgress?: (progress: CircuitProgress) => void;
  chunkBytes: number;
};

/**
 * Return a verified local file for one artifact, downloading it on first use.
 *
 * The cached copy is re-hashed on every call — a file altered at rest is
 * caught here, not at prove time — and the freshly downloaded bytes are
 * hashed before they are promoted out of their `.part` name. Both mismatch
 * paths delete the file and throw {@link CircuitChecksumError}; nothing
 * unverified ever leaves this function.
 */
async function ensureArtifact(params: EnsureArtifactParams): Promise<CircuitArtifactFile> {
  const { store, fetchFn, lockfileUrl, policy, artifact, entry, onProgress, chunkBytes } =
    params;
  const key = circuitArtifactKey(policy, artifact);
  const finalPath = store.path(finalFileName(policy, artifact));
  const partPath = store.path(partFileName(policy, artifact));
  const file: CircuitArtifactFile = {
    name: artifact,
    uri: finalPath,
    sizeBytes: entry.sizeBytes,
    sha256: entry.sha256,
  };

  if (await store.exists(finalPath)) {
    emitProgress(onProgress, policy, artifact, 'verifying', entry.sizeBytes, entry.sizeBytes);
    if (await matchesEntry(store, finalPath, entry)) {
      // A part file beside a verified artifact is debris (a crash can leave
      // one behind); clear it so it cannot be resumed against later.
      if (await store.exists(partPath)) await store.remove(partPath);
      return file;
    }
    await store.remove(finalPath);
    throw new CircuitChecksumError(
      `${key} failed checksum verification. The file was deleted, and proving is ` +
        `refused until it can be downloaded again`
    );
  }

  await downloadResumable({
    store,
    fetchFn,
    url: resolveArtifactUrl(lockfileUrl, entry.path),
    partPath,
    entry,
    policy,
    artifact,
    onProgress,
    chunkBytes,
  });

  emitProgress(onProgress, policy, artifact, 'verifying', entry.sizeBytes, entry.sizeBytes);
  if (!(await matchesEntry(store, partPath, entry))) {
    await store.remove(partPath);
    throw new CircuitChecksumError(
      `${key} failed checksum verification after download. The file was deleted, ` +
        `and proving is refused until it can be downloaded again`
    );
  }

  await store.move(partPath, finalPath);
  return file;
}

// ── The gate ───────────────────────────────────────────────────────────────────

/** Options shared by {@link ensureCircuits} and {@link estimateCircuitDownload}. */
export type EnsureCircuitsOptions = {
  /** Overrides {@link DEFAULT_LOCKFILE_URL}; must be https. */
  lockfileUrl?: string;
  /** Injected network — tests script a range-serving server through this. */
  fetchFn?: CircuitFetch;
  /** Injected storage — defaults to {@link defaultCircuitStore}. */
  store?: CircuitStore;
  /** Progress for the UI; may not fire for a call that joins a shared run. */
  onProgress?: (progress: CircuitProgress) => void;
  /** Bytes per ranged request; defaults to 1 MiB. */
  chunkBytes?: number;
};

/** A verified artifact ready to be handed to the prover. */
export type CircuitArtifactFile = {
  name: CircuitArtifactName;
  /** `file://` URI of the verified file. */
  uri: string;
  sizeBytes: number;
  sha256: string;
};

/** Everything the prover needs for one pool policy, all checksum-verified. */
export type VerifiedCircuits = {
  policy: string;
  r1cs: CircuitArtifactFile;
  provingKey: CircuitArtifactFile;
  /** Both artifacts' sizes combined — what a receipt or hint quotes. */
  totalBytes: number;
};

/** In-flight runs by policy, so two callers cannot interleave one download. */
const inFlight = new Map<string, Promise<VerifiedCircuits>>();

/**
 * Fetch and verify every circuit artifact for `policy`.
 *
 * First use downloads each artifact (ranged, resumable, with progress);
 * later calls find the files already on disk and re-verify them. Either way
 * this resolves only with files whose SHA-256 matches the published lockfile:
 * a mismatch deletes the file and throws {@link CircuitChecksumError} —
 * there is no path through this module that returns an unverified circuit,
 * which is what "refuses to prove" means here. A failed or interrupted
 * download throws {@link CircuitDownloadError} and keeps its partial bytes so
 * the next call resumes rather than restarting.
 *
 * Concurrent calls for the same policy share one run; the second caller may
 * not receive its own progress events.
 */
export async function ensureCircuits(
  policy: string,
  options: EnsureCircuitsOptions = {}
): Promise<VerifiedCircuits> {
  assertPolicyId(policy);
  const running = inFlight.get(policy);
  if (running) return running;
  const promise = runEnsureCircuits(policy, options).finally(() => {
    inFlight.delete(policy);
  });
  inFlight.set(policy, promise);
  return promise;
}

async function runEnsureCircuits(
  policy: string,
  options: EnsureCircuitsOptions
): Promise<VerifiedCircuits> {
  const store = options.store ?? defaultCircuitStore();
  const fetchFn = options.fetchFn ?? defaultFetch;
  const chunkBytes = Math.max(1, options.chunkBytes ?? DEFAULT_CHUNK_BYTES);
  const onProgress = options.onProgress;

  const { lockfile, url: lockfileUrl } = await loadLockfile(options, store, fetchFn);
  // Resolve both entries before downloading either: a policy the lockfile
  // only half-describes must fail before 8 MB has been fetched for it.
  const r1csEntry = requireEntry(lockfile, policy, 'r1cs');
  const provingKeyEntry = requireEntry(lockfile, policy, 'provingKey');
  const shared = { store, fetchFn, lockfileUrl, policy, onProgress, chunkBytes };

  const r1cs = await ensureArtifact({ ...shared, artifact: 'r1cs', entry: r1csEntry });
  const provingKey = await ensureArtifact({
    ...shared,
    artifact: 'provingKey',
    entry: provingKeyEntry,
  });

  return { policy, r1cs, provingKey, totalBytes: r1cs.sizeBytes + provingKey.sizeBytes };
}
