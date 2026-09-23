/**
 * Tests for the SPP circuit download/cache/verify module.
 *
 * The acceptance criteria of backlog #721 are the contract under test:
 *   - a checksum mismatch deletes the file and refuses to prove
 *   - an interrupted download resumes rather than restarting
 *   - the artifacts are never bundled (by construction: the module only
 *     reaches the network and an injected store, so nothing here can grow the
 *     APK — there is no asset path to assert against)
 *
 * Everything device-shaped — the filesystem, `fetch` — is injected, so the
 * suite drives a scripted range-serving "SPP host" and an in-memory store
 * directly: no native modules, no network.
 */

import {
  CIRCUIT_LOCKFILE_VERSION,
  CircuitChecksumError,
  CircuitDownloadError,
  CircuitError,
  CircuitLockfileError,
  type CircuitFetch,
  type CircuitFetchResponse,
  type CircuitLockfile,
  type CircuitProgress,
  type CircuitStore,
  circuitArtifactKey,
  circuitDownloadHint,
  ensureCircuits,
  estimateCircuitDownload,
  formatBytes,
  parseCircuitLockfile,
  resolveArtifactUrl,
  sha256Hex,
} from '../privacy/circuits';

// ── Fixtures ───────────────────────────────────────────────────────────────────

const encoder = new TextEncoder();
const decoder = new TextDecoder();

const LOCKFILE_URL = 'https://circuits.example/spp/circuits.lock.json';
const R1CS_URL = 'https://circuits.example/spp/artifacts/block-list.r1cs';
const PK_URL = 'https://circuits.example/spp/artifacts/block-list.pk';

/** Deterministic, seed-distinguishable bytes so mixed-up files are visible. */
function patternBytes(length: number, seed: number): Uint8Array {
  const bytes = new Uint8Array(length);
  for (let i = 0; i < length; i += 1) bytes[i] = (i * 31 + seed) % 251;
  return bytes;
}

const R1CS = patternBytes(1000, 7);
const PK = patternBytes(600, 13);
const CHUNK_BYTES = 128;

function goodLockfile(): CircuitLockfile {
  return {
    version: CIRCUIT_LOCKFILE_VERSION,
    artifacts: {
      [circuitArtifactKey('block-list', 'r1cs')]: {
        path: 'artifacts/block-list.r1cs',
        sizeBytes: R1CS.length,
        sha256: sha256Hex(R1CS),
      },
      [circuitArtifactKey('block-list', 'provingKey')]: {
        path: 'artifacts/block-list.pk',
        sizeBytes: PK.length,
        sha256: sha256Hex(PK),
      },
    },
  };
}

// ── In-memory CircuitStore ─────────────────────────────────────────────────────

class MemoryCircuitStore implements CircuitStore {
  readonly files = new Map<string, Uint8Array>();

  path(name: string): string {
    return `mem://veil-circuits/${name}`;
  }

  async exists(path: string): Promise<boolean> {
    return this.files.has(path);
  }

  async size(path: string): Promise<number> {
    return this.files.get(path)?.length ?? 0;
  }

  async read(path: string): Promise<Uint8Array> {
    const bytes = this.files.get(path);
    if (!bytes) throw new Error(`ENOENT: ${path}`);
    return bytes.slice();
  }

  async readText(path: string): Promise<string> {
    const bytes = this.files.get(path);
    if (!bytes) throw new Error(`ENOENT: ${path}`);
    return decoder.decode(bytes);
  }

  async write(path: string, data: Uint8Array): Promise<void> {
    this.files.set(path, data.slice());
  }

  async writeText(path: string, text: string): Promise<void> {
    this.files.set(path, encoder.encode(text));
  }

  async append(path: string, data: Uint8Array): Promise<void> {
    const existing = this.files.get(path) ?? new Uint8Array(0);
    const merged = new Uint8Array(existing.length + data.length);
    merged.set(existing);
    merged.set(data, existing.length);
    this.files.set(path, merged);
  }

  async remove(path: string): Promise<void> {
    this.files.delete(path);
  }

  async move(from: string, to: string): Promise<void> {
    const bytes = this.files.get(from);
    if (!bytes) throw new Error(`ENOENT: ${from}`);
    this.files.set(to, bytes);
    this.files.delete(from);
  }
}

// ── Scripted SPP host ──────────────────────────────────────────────────────────

function binaryResponse(
  status: number,
  body: Uint8Array,
  contentRange: string | null
): CircuitFetchResponse {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: {
      get: (name: string) => (name.toLowerCase() === 'content-range' ? contentRange : null),
    },
    arrayBuffer: async () => new Uint8Array(body).buffer,
    text: async () => decoder.decode(body),
  };
}

type RangeRequest = { url: string; range: string | null };

type ServerOptions = {
  /** Served as JSON at {@link LOCKFILE_URL}. */
  lockfile: unknown;
  /** Resolved artifact URL → bytes. A URL missing here fails like a dead host. */
  artifacts: Record<string, Uint8Array>;
  /** Throw from here to drop the connection on that artifact request. */
  onArtifactRequest?: (request: RangeRequest, nthForUrl: number) => void;
  /** Answer every request with HTTP 200 + full body, ignoring Range. */
  ignoreRange?: boolean;
};

type SppServer = {
  fetchFn: CircuitFetch;
  requests: RangeRequest[];
};

function createServer(options: ServerOptions): SppServer {
  const requests: RangeRequest[] = [];
  const seen = new Map<string, number>();

  const fetchFn: CircuitFetch = async (url, init) => {
    const request: RangeRequest = { url, range: init?.headers?.['Range'] ?? null };
    requests.push(request);

    if (url === LOCKFILE_URL) {
      return binaryResponse(200, encoder.encode(JSON.stringify(options.lockfile)), null);
    }

    const body = options.artifacts[url];
    if (!body) throw new TypeError('Network request failed');

    const nth = (seen.get(url) ?? 0) + 1;
    seen.set(url, nth);
    options.onArtifactRequest?.(request, nth);

    if (options.ignoreRange || !request.range) {
      return binaryResponse(200, body, null);
    }
    const match = /^bytes=(\d+)-(\d+)$/.exec(request.range);
    if (!match) throw new TypeError(`malformed Range: ${request.range}`);
    const start = Number(match[1]);
    const end = Math.min(Number(match[2]), body.length - 1);
    if (start >= body.length || start > end) {
      return binaryResponse(416, new Uint8Array(0), null);
    }
    return binaryResponse(206, body.slice(start, end + 1), `bytes ${start}-${end}/${body.length}`);
  };

  return { fetchFn, requests };
}

function optionsFor(server: SppServer, store: MemoryCircuitStore, extra: object = {}) {
  return {
    lockfileUrl: LOCKFILE_URL,
    fetchFn: server.fetchFn,
    store,
    chunkBytes: CHUNK_BYTES,
    ...extra,
  };
}

// ── parseCircuitLockfile ───────────────────────────────────────────────────────

describe('parseCircuitLockfile', () => {
  it('accepts a well-formed lockfile and lowercases its checksums', () => {
    const lockfile = goodLockfile();
    lockfile.artifacts[circuitArtifactKey('block-list', 'r1cs')].sha256 = 'A'.repeat(64);
    const parsed = parseCircuitLockfile(lockfile);
    expect(parsed.artifacts[circuitArtifactKey('block-list', 'r1cs')].sha256).toBe('a'.repeat(64));
    expect(parsed.version).toBe(CIRCUIT_LOCKFILE_VERSION);
  });

  it('rejects anything that is not a JSON object', () => {
    expect(() => parseCircuitLockfile(null)).toThrow(CircuitLockfileError);
    expect(() => parseCircuitLockfile('nope')).toThrow(CircuitLockfileError);
    expect(() => parseCircuitLockfile([])).toThrow(CircuitLockfileError);
  });

  it('rejects an unsupported schema generation instead of guessing', () => {
    const lockfile: Record<string, unknown> = { ...goodLockfile(), version: 2 };
    expect(() => parseCircuitLockfile(lockfile)).toThrow(/version 2 is not supported/);
  });

  it('rejects malformed entries that the download would otherwise trust', () => {
    const badSha = goodLockfile();
    badSha.artifacts[circuitArtifactKey('block-list', 'r1cs')].sha256 = 'deadbeef';
    expect(() => parseCircuitLockfile(badSha)).toThrow(/sha256/);

    const badSize = goodLockfile();
    badSize.artifacts[circuitArtifactKey('block-list', 'r1cs')].sizeBytes = 0;
    expect(() => parseCircuitLockfile(badSize)).toThrow(/sizeBytes/);

    const badKey = goodLockfile();
    const entry = badKey.artifacts[circuitArtifactKey('block-list', 'r1cs')];
    delete badKey.artifacts[circuitArtifactKey('block-list', 'r1cs')];
    badKey.artifacts['block-list/zkey'] = entry;
    expect(() => parseCircuitLockfile(badKey)).toThrow(/<pool policy>\/<artifact>/);

    // A raw entry missing its path — the shape a broken publisher would produce.
    expect(() =>
      parseCircuitLockfile({
        version: CIRCUIT_LOCKFILE_VERSION,
        artifacts: {
          [circuitArtifactKey('block-list', 'r1cs')]: {
            sizeBytes: R1CS.length,
            sha256: sha256Hex(R1CS),
          },
        },
      })
    ).toThrow(/artifact path/);
  });

  it('rejects an empty artifacts map', () => {
    expect(() => parseCircuitLockfile({ version: 1, artifacts: {} })).toThrow(/no artifacts/);
  });
});

// ── resolveArtifactUrl ─────────────────────────────────────────────────────────

describe('resolveArtifactUrl', () => {
  it('resolves a path relative to the lockfile location', () => {
    expect(resolveArtifactUrl(LOCKFILE_URL, 'artifacts/block-list.r1cs')).toBe(R1CS_URL);
    expect(resolveArtifactUrl(LOCKFILE_URL, '/artifacts/block-list.pk')).toBe(
      'https://circuits.example/artifacts/block-list.pk'
    );
  });

  it('keeps absolute https URLs as given', () => {
    expect(resolveArtifactUrl(LOCKFILE_URL, R1CS_URL)).toBe(R1CS_URL);
  });

  it('normalizes .. segments without ever leaving the lockfile origin', () => {
    expect(resolveArtifactUrl(LOCKFILE_URL, '../artifacts/x.r1cs')).toBe(
      'https://circuits.example/artifacts/x.r1cs'
    );
    expect(resolveArtifactUrl(LOCKFILE_URL, '../../../../../../x')).toBe(
      'https://circuits.example/x'
    );
  });

  it('rejects anything that would leave https or the pinned origin scheme', () => {
    expect(() => resolveArtifactUrl(LOCKFILE_URL, 'http://evil.example/x')).toThrow(
      CircuitLockfileError
    );
    expect(() => resolveArtifactUrl(LOCKFILE_URL, '//evil.example/x')).toThrow(
      CircuitLockfileError
    );
    expect(() => resolveArtifactUrl(LOCKFILE_URL, 'ftp://evil.example/x')).toThrow(
      CircuitLockfileError
    );
    expect(() => resolveArtifactUrl('http://circuits.example/lock.json', 'x.r1cs')).toThrow(
      /must be https/
    );
  });
});

// ── Wi-Fi hint ─────────────────────────────────────────────────────────────────

describe('circuitDownloadHint', () => {
  it('quotes the download size and recommends Wi-Fi on cellular', () => {
    // The issue's own figure: ~12 MB of circuits per pool policy.
    const hint = circuitDownloadHint('cellular', 12_800_000);
    expect(hint).toContain(formatBytes(12_800_000));
    expect(hint).toContain('Wi-Fi recommended');
  });

  it('stays silent where there is nothing to warn about', () => {
    expect(circuitDownloadHint('wifi', 12_800_000)).toBeNull();
    expect(circuitDownloadHint('unknown', 12_800_000)).toBeNull();
    expect(circuitDownloadHint('none', 12_800_000)).toBeNull();
  });
});

// ── estimateCircuitDownload ───────────────────────────────────────────────────

describe('estimateCircuitDownload', () => {
  it('quotes the policy total from the lockfile alone', async () => {
    const store = new MemoryCircuitStore();
    const server = createServer({ lockfile: goodLockfile(), artifacts: {} });

    await expect(
      estimateCircuitDownload('block-list', optionsFor(server, store))
    ).resolves.toBe(R1CS.length + PK.length);
    // The lockfile and nothing else — no artifact bytes moved.
    expect(server.requests).toHaveLength(1);
    expect(server.requests[0].url).toBe(LOCKFILE_URL);
  });

  it('refuses to quote a policy the lockfile does not cover', async () => {
    const store = new MemoryCircuitStore();
    const lockfile = goodLockfile();
    delete lockfile.artifacts[circuitArtifactKey('block-list', 'provingKey')];
    const server = createServer({ lockfile, artifacts: {} });

    await expect(estimateCircuitDownload('block-list', optionsFor(server, store))).rejects.toThrow(
      CircuitLockfileError
    );
  });
});

// ── ensureCircuits ────────────────────────────────────────────────────────────

describe('ensureCircuits', () => {
  it('downloads on first use, verifies, and caches both artifacts with progress', async () => {
    const store = new MemoryCircuitStore();
    const server = createServer({
      lockfile: goodLockfile(),
      artifacts: { [R1CS_URL]: R1CS, [PK_URL]: PK },
    });
    const progress: CircuitProgress[] = [];

    const circuits = await ensureCircuits(
      'block-list',
      optionsFor(server, store, { onProgress: (p: CircuitProgress) => progress.push(p) })
    );

    // The result points at verified files holding exactly the published bytes.
    expect(circuits.r1cs.uri).toBe(store.path('block-list.r1cs'));
    expect(circuits.provingKey.uri).toBe(store.path('block-list.provingKey'));
    expect(circuits.totalBytes).toBe(R1CS.length + PK.length);
    expect(circuits.r1cs.sha256).toBe(sha256Hex(R1CS));
    expect(store.files.get(circuits.r1cs.uri)).toEqual(R1CS);
    expect(store.files.get(circuits.provingKey.uri)).toEqual(PK);

    // Nothing is left half-written, and the lockfile copy is kept for offline.
    expect(store.files.has(store.path('block-list.r1cs.part'))).toBe(false);
    expect(store.files.has(store.path('block-list.provingKey.part'))).toBe(false);
    expect(store.files.has(store.path('lockfile.json'))).toBe(true);

    // The bytes arrived as ranged chunks covering the whole file.
    const r1csRanges = server.requests.filter((r) => r.url === R1CS_URL).map((r) => r.range);
    expect(r1csRanges[0]).toBe('bytes=0-127');
    expect(r1csRanges[r1csRanges.length - 1]).toBe('bytes=896-999');

    // Progress: per-artifact, bounded, monotonic while downloading, and a
    // verifying event once the bytes are on device.
    const r1csProgress = progress.filter((p) => p.artifact === 'r1cs');
    expect(r1csProgress.some((p) => p.phase === 'verifying')).toBe(true);
    const downloading = r1csProgress.filter((p) => p.phase === 'downloading');
    expect(downloading[0].receivedBytes).toBe(0);
    expect(downloading[downloading.length - 1].fraction).toBe(1);
    for (let i = 1; i < downloading.length; i += 1) {
      expect(downloading[i].receivedBytes).toBeGreaterThanOrEqual(downloading[i - 1].receivedBytes);
    }
    expect(progress.some((p) => p.artifact === 'provingKey')).toBe(true);
    expect(progress.every((p) => p.fraction >= 0 && p.fraction <= 1)).toBe(true);
  });

  it('serves a verified cache without fetching artifact bytes again', async () => {
    const store = new MemoryCircuitStore();
    const first = createServer({
      lockfile: goodLockfile(),
      artifacts: { [R1CS_URL]: R1CS, [PK_URL]: PK },
    });
    await ensureCircuits('block-list', optionsFor(first, store));

    // If the second run touches an artifact, the host is dead: it will throw.
    const second = createServer({ lockfile: goodLockfile(), artifacts: {} });
    const circuits = await ensureCircuits('block-list', optionsFor(second, store));

    expect(circuits.r1cs.uri).toBe(store.path('block-list.r1cs'));
    expect(second.requests).toHaveLength(1);
    expect(second.requests[0].url).toBe(LOCKFILE_URL);
  });

  it('resumes an interrupted download instead of restarting it', async () => {
    const store = new MemoryCircuitStore();
    // The proving key's second chunk drops the connection; r1cs completes first.
    const interrupted = createServer({
      lockfile: goodLockfile(),
      artifacts: { [R1CS_URL]: R1CS, [PK_URL]: PK },
      onArtifactRequest: (request, nth) => {
        if (request.url === PK_URL && nth === 2) throw new TypeError('Network request failed');
      },
    });

    await expect(
      ensureCircuits('block-list', optionsFor(interrupted, store))
    ).rejects.toThrow(CircuitDownloadError);

    // The completed artifact and the partial proving key both survive...
    expect(store.files.get(store.path('block-list.r1cs'))).toEqual(R1CS);
    expect(store.files.get(store.path('block-list.provingKey.part'))).toEqual(PK.slice(0, 128));
    expect(store.files.has(store.path('block-list.provingKey'))).toBe(false);

    // ...and the retry picks up at byte 128 rather than starting over.
    const retry = createServer({
      lockfile: goodLockfile(),
      artifacts: { [R1CS_URL]: R1CS, [PK_URL]: PK },
    });
    const circuits = await ensureCircuits('block-list', optionsFor(retry, store));

    const pkRanges = retry.requests.filter((r) => r.url === PK_URL).map((r) => r.range);
    expect(pkRanges[0]).toBe('bytes=128-255');
    expect(retry.requests.some((r) => r.url === R1CS_URL)).toBe(false);
    expect(store.files.get(circuits.provingKey.uri)).toEqual(PK);
    expect(store.files.has(store.path('block-list.provingKey.part'))).toBe(false);
  });

  it('deletes a downloaded file that fails its checksum and refuses to prove', async () => {
    const store = new MemoryCircuitStore();
    // Right size, wrong bytes' checksum — only the hash can catch this one.
    const tampered = goodLockfile();
    tampered.artifacts[circuitArtifactKey('block-list', 'r1cs')] = {
      ...tampered.artifacts[circuitArtifactKey('block-list', 'r1cs')],
      sha256: sha256Hex(patternBytes(R1CS.length, 999)),
    };
    const server = createServer({
      lockfile: tampered,
      artifacts: { [R1CS_URL]: R1CS, [PK_URL]: PK },
    });

    await expect(ensureCircuits('block-list', optionsFor(server, store))).rejects.toThrow(
      CircuitChecksumError
    );

    // The file is gone — neither the cache name nor the partial survives.
    expect(store.files.has(store.path('block-list.r1cs'))).toBe(false);
    expect(store.files.has(store.path('block-list.r1cs.part'))).toBe(false);
    // Proving was refused outright: the policy's second artifact was never fetched.
    expect(server.requests.some((r) => r.url === PK_URL)).toBe(false);
  });

  it('detects a cached artifact altered at rest, deletes it, and refuses to prove', async () => {
    const store = new MemoryCircuitStore();
    const corrupted = R1CS.slice();
    corrupted[500] ^= 0xff;
    await store.write(store.path('block-list.r1cs'), corrupted);

    // No artifact is served: fetching anything would mean the cache was trusted.
    const server = createServer({ lockfile: goodLockfile(), artifacts: {} });
    await expect(ensureCircuits('block-list', optionsFor(server, store))).rejects.toThrow(
      CircuitChecksumError
    );
    expect(store.files.has(store.path('block-list.r1cs'))).toBe(false);
  });

  it('treats a cached artifact of the wrong length as a mismatch', async () => {
    const store = new MemoryCircuitStore();
    await store.write(store.path('block-list.r1cs'), R1CS.slice(0, R1CS.length - 1));

    const server = createServer({ lockfile: goodLockfile(), artifacts: {} });
    await expect(ensureCircuits('block-list', optionsFor(server, store))).rejects.toThrow(
      CircuitChecksumError
    );
    expect(store.files.has(store.path('block-list.r1cs'))).toBe(false);
  });

  it('verifies a cached policy offline from the last lockfile it saw', async () => {
    const store = new MemoryCircuitStore();
    const online = createServer({
      lockfile: goodLockfile(),
      artifacts: { [R1CS_URL]: R1CS, [PK_URL]: PK },
    });
    await ensureCircuits('block-list', optionsFor(online, store));

    const offline: CircuitFetch = async () => {
      throw new TypeError('Network request failed');
    };
    const circuits = await ensureCircuits('block-list', {
      lockfileUrl: LOCKFILE_URL,
      fetchFn: offline,
      store,
      chunkBytes: CHUNK_BYTES,
    });
    expect(circuits.r1cs.uri).toBe(store.path('block-list.r1cs'));
    expect(circuits.provingKey.uri).toBe(store.path('block-list.provingKey'));
  });

  it('refuses to run at all when no lockfile can be obtained', async () => {
    const offline: CircuitFetch = async () => {
      throw new TypeError('Network request failed');
    };
    await expect(
      ensureCircuits('block-list', {
        lockfileUrl: LOCKFILE_URL,
        fetchFn: offline,
        store: new MemoryCircuitStore(),
      })
    ).rejects.toThrow(CircuitLockfileError);
  });

  it('downloads nothing when the lockfile only half-covers the policy', async () => {
    const store = new MemoryCircuitStore();
    const lockfile = goodLockfile();
    delete lockfile.artifacts[circuitArtifactKey('block-list', 'provingKey')];
    const server = createServer({ lockfile, artifacts: { [R1CS_URL]: R1CS, [PK_URL]: PK } });

    await expect(ensureCircuits('block-list', optionsFor(server, store))).rejects.toThrow(
      CircuitLockfileError
    );
    expect(server.requests.every((r) => r.url === LOCKFILE_URL)).toBe(true);
  });

  it('rejects a policy id that could escape the cache directory', async () => {
    const store = new MemoryCircuitStore();
    const server = createServer({ lockfile: goodLockfile(), artifacts: {} });

    await expect(ensureCircuits('../evil', optionsFor(server, store))).rejects.toThrow(
      CircuitError
    );
    expect(server.requests).toHaveLength(0);
  });

  it('reports an HTTP failure as a download error without caching anything', async () => {
    const store = new MemoryCircuitStore();
    const server = createServer({
      lockfile: goodLockfile(),
      artifacts: { [R1CS_URL]: R1CS, [PK_URL]: PK },
    });
    const failing: CircuitFetch = async (url, init) =>
      url === LOCKFILE_URL
        ? server.fetchFn(url, init)
        : {
            ok: false,
            status: 503,
            headers: { get: () => null },
            arrayBuffer: async () => new ArrayBuffer(0),
            text: async () => '',
          };

    await expect(
      ensureCircuits('block-list', {
        lockfileUrl: LOCKFILE_URL,
        fetchFn: failing,
        store,
        chunkBytes: CHUNK_BYTES,
      })
    ).rejects.toThrow('HTTP 503');
    expect(store.files.has(store.path('block-list.r1cs'))).toBe(false);
  });

  it('restarts cleanly when a server ignores Range, and still verifies', async () => {
    const store = new MemoryCircuitStore();
    // A partial file exists, so the first request asks to resume from byte 128.
    await store.write(store.path('block-list.r1cs.part'), R1CS.slice(0, 128));
    const server = createServer({
      lockfile: goodLockfile(),
      artifacts: { [R1CS_URL]: R1CS, [PK_URL]: PK },
      ignoreRange: true,
    });

    const circuits = await ensureCircuits('block-list', optionsFor(server, store));

    // A 200 instead of a 206 means the body starts at byte 0 — the stale
    // prefix was dropped rather than spliced, and the result still verifies.
    const firstRequest = server.requests.filter((r) => r.url === R1CS_URL)[0];
    expect(firstRequest.range).toBe('bytes=128-255');
    expect(store.files.get(circuits.r1cs.uri)).toEqual(R1CS);
    expect(store.files.get(circuits.provingKey.uri)).toEqual(PK);
  });

  it('collapses concurrent calls into a single download', async () => {
    const store = new MemoryCircuitStore();
    const server = createServer({
      lockfile: goodLockfile(),
      artifacts: { [R1CS_URL]: R1CS, [PK_URL]: PK },
    });
    const opts = optionsFor(server, store);

    const [first, second] = await Promise.all([
      ensureCircuits('block-list', opts),
      ensureCircuits('block-list', opts),
    ]);
    expect(second).toBe(first);
    // 8 chunks per artifact: 1000/128 rounds up, and nothing was fetched twice.
    expect(server.requests.filter((r) => r.url === R1CS_URL)).toHaveLength(8);
    expect(server.requests.filter((r) => r.url === PK_URL)).toHaveLength(5);
  });
});
