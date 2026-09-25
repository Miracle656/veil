import {
  circuitLockfileFromSpp,
  CircuitIntegrityError,
  CircuitManager,
  type CircuitLockfile,
} from '../circuits';

type FakeFileSystem = {
  cacheDirectory: string;
  files: Map<string, string>;
  downloads: Array<{ resumeData?: string }>;
  failOnce: boolean;
  getInfoAsync: (uri: string) => Promise<{ exists: boolean }>;
  makeDirectoryAsync: (uri: string) => Promise<void>;
  deleteAsync: (uri: string) => Promise<void>;
  moveAsync: (options: { from: string; to: string }) => Promise<void>;
  readAsStringAsync: (uri: string) => Promise<string>;
  createDownloadResumable: (
    url: string,
    fileUri: string,
    callback: (progress: { totalBytesWritten: number; totalBytesExpectedToWrite: number }) => void,
    resumeData?: string
  ) => { downloadAsync: () => Promise<void>; savable: () => Promise<{ resumeData: string }> };
};

const HELLO_SHA256 = '2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824';
const lockfile: CircuitLockfile = {
  version: 'test',
  circuits: {
    blocklist: {
      r1cs: { url: 'https://spp.test/r1cs', sha256: HELLO_SHA256, filename: 'circuit.r1cs' },
      provingKey: { url: 'https://spp.test/zkey', sha256: HELLO_SHA256, filename: 'circuit.zkey' },
    },
  },
};

function fakeFileSystem(): FakeFileSystem {
  const files = new Map<string, string>();
  const downloads: Array<{ resumeData?: string }> = [];
  const fake: FakeFileSystem = {
    cacheDirectory: 'cache/',
    files,
    downloads,
    failOnce: false,
    getInfoAsync: async (uri) => ({ exists: files.has(uri) }),
    makeDirectoryAsync: async () => undefined,
    deleteAsync: async (uri) => {
      files.delete(uri);
    },
    moveAsync: async ({ from, to }) => {
      const contents = files.get(from);
      if (contents === undefined) throw new Error(`missing ${from}`);
      files.set(to, contents);
      files.delete(from);
    },
    readAsStringAsync: async (uri) => {
      const contents = files.get(uri);
      if (contents === undefined) throw new Error(`missing ${uri}`);
      return contents;
    },
    createDownloadResumable: (_url, fileUri, callback, resumeData) => {
      downloads.push({ resumeData });
      return {
        downloadAsync: async () => {
          callback({ totalBytesWritten: 5, totalBytesExpectedToWrite: 5 });
          files.set(fileUri, 'aGVsbG8=');
          if (fake.failOnce && !resumeData) throw new Error('connection dropped');
        },
        savable: async () => ({ resumeData: 'resume-token' }),
      };
    },
  };
  return fake;
}

function resumeStore() {
  const values = new Map<string, string>();
  return {
    values,
    getItem: async (key: string) => values.get(key) ?? null,
    setItem: async (key: string, value: string) => {
      values.set(key, value);
    },
    removeItem: async (key: string) => {
      values.delete(key);
    },
  };
}

describe('CircuitManager', () => {
  it('maps SPP circuit lockfile hashes without bundling circuit bytes', () => {
    const manifest = circuitLockfileFromSpp(
      {
        version: '0.4',
        meta: { repository: 'NethermindEth/stellar-private-payments', commit: 'test' },
        blocklist: {
          r1cs: HELLO_SHA256,
          'graph.bin': HELLO_SHA256,
          'proving_key.bin': HELLO_SHA256,
        },
      },
      (stem, artifact) => `https://cdn.test/${stem}-${artifact}`
    );

    expect(manifest.circuits.blocklist.provingKey.sha256).toBe(HELLO_SHA256);
    expect(manifest.circuits.blocklist.r1cs.url).toBe('https://cdn.test/blocklist-r1cs');
  });

  it('deletes a checksum-mismatched artifact and refuses to return circuit files', async () => {
    const fileSystem = fakeFileSystem();
    const mismatchedUri = 'cache/veil-privacy-circuits/blocklist-r1cs-circuit.r1cs';
    fileSystem.files.set(mismatchedUri, 'd3Jvbmc=');
    const manager = new CircuitManager({ lockfile, fileSystem, resumeStore: resumeStore(), getConnectionType: async () => 'wifi' });

    await expect(manager.ensureCircuit('blocklist')).rejects.toBeInstanceOf(CircuitIntegrityError);
    expect(fileSystem.files.has(mismatchedUri)).toBe(false);
  });

  it('passes saved resume data to the next attempt after an interrupted download', async () => {
    const fileSystem = fakeFileSystem();
    fileSystem.failOnce = true;
    const store = resumeStore();
    const manager = new CircuitManager({ lockfile, fileSystem, resumeStore: store, getConnectionType: async () => 'cellular' });

    await expect(manager.ensureCircuit('blocklist')).rejects.toThrow('connection dropped');
    expect(fileSystem.downloads[0].resumeData).toBeUndefined();
    expect(store.values.size).toBe(1);

    fileSystem.failOnce = false;
    const files = await manager.ensureCircuit('blocklist');
    expect(fileSystem.downloads[1].resumeData).toBe('resume-token');
    expect(files.r1cs).toContain('circuit.r1cs');
    expect(files.provingKey).toContain('circuit.zkey');
  });
});
