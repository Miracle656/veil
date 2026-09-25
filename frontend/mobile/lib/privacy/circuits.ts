import { sha256 } from '@noble/hashes/sha2.js';

export type CircuitArtifactName = 'r1cs' | 'provingKey';

export type CircuitArtifact = {
  /** Remote artifact URL published by SPP. */
  url: string;
  /** Lowercase SHA-256 digest from SPP's circuit lockfile. */
  sha256: string;
  /** Optional byte count used for progress when the server omits Content-Length. */
  sizeBytes?: number;
  /** Stable filename; never derived from an untrusted URL. */
  filename: string;
};

export type CircuitSet = {
  r1cs: CircuitArtifact;
  provingKey: CircuitArtifact;
};

/** Small, checked-in/configured metadata; the large binary artifacts are never bundled. */
export type CircuitLockfile = {
  version: string;
  circuits: Record<string, CircuitSet>;
};

export type SppCircuitLockfile = {
  version: string;
  meta: {
    repository: string;
    commit: string;
    [key: string]: string;
  };
  [stem: string]: unknown;
};

type SppCircuitHashes = {
  r1cs: string;
  'graph.bin': string;
  'proving_key.bin': string;
};

/**
 * Convert SPP's published `circuits.json` into the mobile manifest. URLs are
 * supplied by the release integration because SPP publishes a tarball rather
 * than pretending each member is an independently hosted file.
 */
export function circuitLockfileFromSpp(
  sppLockfile: SppCircuitLockfile,
  artifactUrl: (stem: string, kind: CircuitArtifactName) => string
): CircuitLockfile {
  const circuits: Record<string, CircuitSet> = {};
  for (const [stem, value] of Object.entries(sppLockfile)) {
    if (!value || typeof value !== 'object' || !('r1cs' in value) || !('proving_key.bin' in value)) {
      continue;
    }
    const hashes = value as SppCircuitHashes;
    circuits[stem] = {
      r1cs: {
        url: artifactUrl(stem, 'r1cs'),
        sha256: hashes.r1cs,
        filename: `${stem}.r1cs`,
      },
      provingKey: {
        url: artifactUrl(stem, 'provingKey'),
        sha256: hashes['proving_key.bin'],
        filename: `${stem}_proving_key.bin`,
      },
    };
  }
  return { version: sppLockfile.version, circuits };
}

export type CircuitFiles = {
  poolId: string;
  r1cs: string;
  provingKey: string;
};

export type CircuitDownloadProgress = {
  artifact: CircuitArtifactName;
  phase: 'downloading' | 'verifying' | 'complete';
  bytesDownloaded: number;
  totalBytes?: number;
  progress?: number;
  resumed: boolean;
  /** True when cellular data is being used and Wi-Fi is recommended. */
  wifiRecommended: boolean;
};

type FileInfo = { exists: boolean; size?: number };
type DownloadSnapshot = { resumeData?: string };
type DownloadTask = {
  downloadAsync: () => Promise<unknown>;
  savable?: () => Promise<DownloadSnapshot | null>;
};
type DownloadProgressCallback = (progress: {
  totalBytesWritten: number;
  totalBytesExpectedToWrite: number;
}) => void;

type FileSystemAdapter = {
  cacheDirectory: string | null;
  getInfoAsync: (uri: string) => Promise<FileInfo>;
  makeDirectoryAsync: (uri: string) => Promise<void>;
  deleteAsync: (uri: string) => Promise<void>;
  moveAsync: (options: { from: string; to: string }) => Promise<void>;
  readAsStringAsync: (uri: string) => Promise<string>;
  createDownloadResumable: (
    url: string,
    fileUri: string,
    callback: DownloadProgressCallback,
    resumeData?: string
  ) => DownloadTask;
};

type ResumeStore = {
  getItem: (key: string) => Promise<string | null>;
  setItem: (key: string, value: string) => Promise<void>;
  removeItem: (key: string) => Promise<void>;
};

export type CircuitManagerOptions = {
  lockfile: CircuitLockfile;
  fileSystem?: FileSystemAdapter;
  resumeStore?: ResumeStore;
  getConnectionType?: () => Promise<string>;
};

export class CircuitIntegrityError extends Error {
  readonly code = 'circuit_checksum_mismatch';
  readonly artifact: CircuitArtifactName;
  readonly expected: string;
  readonly actual: string;

  constructor(artifact: CircuitArtifactName, expected: string, actual: string) {
    super(`Circuit ${artifact} failed SHA-256 verification`);
    this.name = 'CircuitIntegrityError';
    this.artifact = artifact;
    this.expected = expected;
    this.actual = actual;
  }
}

const RESUME_KEY_PREFIX = '@veil/privacy-circuit-resume/';
const CACHE_DIRECTORY_NAME = 'veil-privacy-circuits';

function createDefaultFileSystem(): FileSystemAdapter {
  // Keep native modules out of the import path for tests and non-device tooling.
  const fileSystem = require('expo-file-system/legacy') as typeof import('expo-file-system/legacy');
  return {
    cacheDirectory: fileSystem.cacheDirectory,
    getInfoAsync: async (uri) => fileSystem.getInfoAsync(uri),
    makeDirectoryAsync: async (uri) => {
      await fileSystem.makeDirectoryAsync(uri, { intermediates: true });
    },
    deleteAsync: async (uri) => {
      await fileSystem.deleteAsync(uri, { idempotent: true });
    },
    moveAsync: (options) => fileSystem.moveAsync(options),
    readAsStringAsync: (uri) =>
      fileSystem.readAsStringAsync(uri, { encoding: fileSystem.EncodingType.Base64 }),
    createDownloadResumable: (url, fileUri, callback, resumeData) =>
      fileSystem.createDownloadResumable(url, fileUri, {}, callback, resumeData),
  };
}

function createDefaultResumeStore(): ResumeStore {
  const storage = require('@react-native-async-storage/async-storage').default as ResumeStore;
  return storage;
}

async function getDefaultConnectionType(): Promise<string> {
  const netInfo = require('@react-native-community/netinfo').default as typeof import('@react-native-community/netinfo').default;
  return (await netInfo.fetch()).type;
}

function assertPoolId(poolId: string): void {
  if (!poolId || !/^[a-zA-Z0-9._-]+$/.test(poolId)) {
    throw new Error(`Invalid circuit pool id: ${poolId}`);
  }
}

function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
}

function base64ToBytes(value: string): Uint8Array {
  const binary = globalThis.atob(value);
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}

function resumeKey(poolId: string, artifact: CircuitArtifactName, checksum: string): string {
  return `${RESUME_KEY_PREFIX}${poolId}/${artifact}/${checksum}`;
}

function artifactUri(directory: string, poolId: string, artifact: CircuitArtifactName, filename: string): string {
  const safeFilename = filename.replace(/[^a-zA-Z0-9._-]/g, '_');
  return `${directory}${poolId}-${artifact}-${safeFilename}`;
}

export class CircuitManager {
  private readonly lockfile: CircuitLockfile;
  private readonly fileSystem: FileSystemAdapter;
  private readonly resumeStore: ResumeStore;
  private readonly getConnectionType: () => Promise<string>;

  constructor(options: CircuitManagerOptions) {
    this.lockfile = options.lockfile;
    this.fileSystem = options.fileSystem ?? createDefaultFileSystem();
    this.resumeStore = options.resumeStore ?? createDefaultResumeStore();
    this.getConnectionType = options.getConnectionType ?? getDefaultConnectionType;
  }

  /**
   * Return verified file paths. A path is never returned until both artifacts
   * have passed the lockfile checksum; callers can pass these directly to the prover.
   */
  async ensureCircuit(
    poolId: string,
    onProgress?: (progress: CircuitDownloadProgress) => void
  ): Promise<CircuitFiles> {
    assertPoolId(poolId);
    const circuit = this.lockfile.circuits[poolId];
    if (!circuit) throw new Error(`No circuit manifest for pool ${poolId}`);

    const baseDirectory = this.fileSystem.cacheDirectory;
    if (!baseDirectory) throw new Error('The device cache directory is unavailable');
    const directory = `${baseDirectory}${CACHE_DIRECTORY_NAME}/`;
    await this.fileSystem.makeDirectoryAsync(directory);
    const wifiRecommended = (await this.getConnectionType()) !== 'wifi';

    const paths = {} as Record<CircuitArtifactName, string>;
    for (const artifactName of ['r1cs', 'provingKey'] as const) {
      paths[artifactName] = await this.ensureArtifact(
        poolId,
        artifactName,
        circuit[artifactName],
        directory,
        wifiRecommended,
        onProgress
      );
    }

    return { poolId, r1cs: paths.r1cs, provingKey: paths.provingKey };
  }

  private async ensureArtifact(
    poolId: string,
    artifactName: CircuitArtifactName,
    artifact: CircuitArtifact,
    directory: string,
    wifiRecommended: boolean,
    onProgress?: (progress: CircuitDownloadProgress) => void
  ): Promise<string> {
    const finalUri = artifactUri(directory, poolId, artifactName, artifact.filename);
    const partUri = `${finalUri}.part`;
    const info = await this.fileSystem.getInfoAsync(finalUri);
    if (info.exists) {
      try {
        await this.verify(finalUri, artifactName, artifact, onProgress, wifiRecommended);
        return finalUri;
      } catch (error) {
        if (!(error instanceof CircuitIntegrityError)) throw error;
        await this.fileSystem.deleteAsync(finalUri);
        throw error;
      }
    }

    const key = resumeKey(poolId, artifactName, artifact.sha256);
    const savedResumeData = await this.resumeStore.getItem(key);
    let resumed = Boolean(savedResumeData);
    const connectionType = await this.getConnectionType();
    wifiRecommended = connectionType !== 'wifi';
    const existingPart = await this.fileSystem.getInfoAsync(partUri);
    if (existingPart.exists && !savedResumeData) {
      await this.fileSystem.deleteAsync(partUri);
    }

    const task = this.fileSystem.createDownloadResumable(
      artifact.url,
      partUri,
      (progress) => {
        onProgress?.({
          artifact: artifactName,
          phase: 'downloading',
          bytesDownloaded: progress.totalBytesWritten,
          totalBytes: progress.totalBytesExpectedToWrite || artifact.sizeBytes,
          progress: progress.totalBytesExpectedToWrite
            ? progress.totalBytesWritten / progress.totalBytesExpectedToWrite
            : undefined,
          resumed,
          wifiRecommended,
        });
      },
      savedResumeData ?? undefined
    );

    try {
      await task.downloadAsync();
    } catch (error) {
      const snapshot = await task.savable?.();
      if (snapshot?.resumeData) await this.resumeStore.setItem(key, snapshot.resumeData);
      throw error;
    }

    await this.resumeStore.removeItem(key);
    try {
      await this.verify(partUri, artifactName, artifact, onProgress, wifiRecommended);
      await this.fileSystem.deleteAsync(finalUri);
      await this.fileSystem.moveAsync({ from: partUri, to: finalUri });
      return finalUri;
    } catch (error) {
      await this.fileSystem.deleteAsync(partUri);
      await this.resumeStore.removeItem(key);
      throw error;
    }
  }

  private async verify(
    uri: string,
    artifactName: CircuitArtifactName,
    artifact: CircuitArtifact,
    onProgress: ((progress: CircuitDownloadProgress) => void) | undefined,
    wifiRecommended: boolean
  ): Promise<void> {
    onProgress?.({
      artifact: artifactName,
      phase: 'verifying',
      bytesDownloaded: artifact.sizeBytes ?? 0,
      totalBytes: artifact.sizeBytes,
      progress: undefined,
      resumed: false,
      wifiRecommended,
    });
    const encoded = await this.fileSystem.readAsStringAsync(uri);
    const actual = bytesToHex(sha256(base64ToBytes(encoded)));
    const expected = artifact.sha256.toLowerCase();
    if (!/^[a-f0-9]{64}$/.test(expected) || actual !== expected) {
      throw new CircuitIntegrityError(artifactName, expected, actual);
    }
    onProgress?.({
      artifact: artifactName,
      phase: 'complete',
      bytesDownloaded: artifact.sizeBytes ?? 0,
      totalBytes: artifact.sizeBytes,
      progress: 1,
      resumed: false,
      wifiRecommended,
    });
  }
}

export function createCircuitManager(options: CircuitManagerOptions): CircuitManager {
  return new CircuitManager(options);
}
