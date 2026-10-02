/**
 * Tests for SEP-30 recovery.
 *
 * The transport, the server-list handling, the public-key extraction, and the
 * signature attachment are all testable without a network or a device: the
 * SEP-30 client takes an injected `fetch`, and the transaction helpers work on
 * XDR strings.
 */

import {
  Account,
  BASE_FEE,
  Keypair,
  Networks,
  Operation,
  TransactionBuilder,
} from '@stellar/stellar-sdk';

import {
  Sep30Client,
  Sep30Error,
  attachRecoverySignatures,
  collectRecoverySignatures,
  getRememberedRecoveryServers,
  isRecoveryUnlocked,
  isValidRecoveryAddress,
  isValidWalletAddress,
  parseRecoveryServerUrls,
  rememberRecoveryServers,
  simulationMessage,
  spkiToUncompressedP256,
  toHex,
  type CollectedSignature,
  type PendingRecovery,
  type RecoveryServer,
} from '../recovery';

const mockStorage = new Map<string, string>();

// Native modules the recovery flow reaches for on a device. The cases below
// exercise the transport and the transaction helpers, which never touch them.
jest.mock('react-native-passkeys', () => ({
  __esModule: true,
  isSupported: () => false,
  create: jest.fn(),
  get: jest.fn(),
}));

jest.mock('expo-secure-store', () => ({
  __esModule: true,
  getItemAsync: jest.fn(async () => null),
  setItemAsync: jest.fn(async () => undefined),
}));

jest.mock('@react-native-async-storage/async-storage', () => ({
  __esModule: true,
  default: {
    getItem: jest.fn(async (key: string) => mockStorage.get(key) ?? null),
    setItem: jest.fn(async (key: string, value: string) => {
      mockStorage.set(key, value);
    }),
    removeItem: jest.fn(async (key: string) => {
      mockStorage.delete(key);
    }),
  },
}));

const WALLET = 'CA3D5KRYM6CB7OWQ6TWYRR3Z4T7GNZLKERYNZGGA5SOAOPIFY6YQGAXE';
const NOT_A_WALLET = 'GA3D5KRYM6CB7OWQ6TWYRR3Z4T7GNZLKERYNZGGA5SOAOPIFY6YQGAXE';

beforeEach(() => {
  mockStorage.clear();
});

// ── Transport ────────────────────────────────────────────────────────────────

/** A fetch stand-in that records its calls and replays queued responses. */
function stubFetch(
  responses: Array<{ status: number; body: unknown }>
): { impl: typeof fetch; calls: Array<{ url: string; init: RequestInit }> } {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const queue = [...responses];

  const impl = (async (url: string, init: RequestInit = {}) => {
    calls.push({ url, init });
    const next = queue.shift() ?? { status: 500, body: { error: 'no response queued' } };
    return {
      ok: next.status >= 200 && next.status < 300,
      status: next.status,
      text: async () => (typeof next.body === 'string' ? next.body : JSON.stringify(next.body)),
    };
  }) as unknown as typeof fetch;

  return { impl, calls };
}

describe('Sep30Client', () => {
  it('sends the session token and normalises a trailing slash', async () => {
    const { impl, calls } = stubFetch([
      { status: 200, body: { address: WALLET, identities: [], signers: [{ key: 'GABC' }] } },
    ]);
    const client = new Sep30Client({ baseUrl: 'https://recovery.example.com/', authToken: 'jwt' }, impl);

    const account = await client.getAccount(WALLET);

    expect(account.signers[0]!.key).toBe('GABC');
    expect(calls[0]!.url).toBe(`https://recovery.example.com/accounts/${WALLET}`);
    expect((calls[0]!.init.headers as Record<string, string>)['Authorization']).toBe('Bearer jwt');
  });

  it('omits the authorization header when there is no token', async () => {
    const { impl, calls } = stubFetch([{ status: 200, body: { signers: [] } }]);

    await new Sep30Client({ baseUrl: 'https://recovery.example.com' }, impl).getAccount(WALLET);

    expect((calls[0]!.init.headers as Record<string, string>)['Authorization']).toBeUndefined();
  });

  it("surfaces the server's own error message and status", async () => {
    const { impl } = stubFetch([{ status: 401, body: { error: 'identity not authenticated' } }]);
    const client = new Sep30Client({ baseUrl: 'https://recovery.example.com' }, impl);

    await expect(client.getAccount(WALLET)).rejects.toThrow(Sep30Error);
    await expect(client.getAccount(WALLET)).rejects.toThrow(/no response queued|identity/);
  });

  it('posts the transaction to the signer path', async () => {
    const { impl, calls } = stubFetch([
      { status: 200, body: { signature: 'sig', network_passphrase: Networks.TESTNET } },
    ]);
    const client = new Sep30Client({ baseUrl: 'https://recovery.example.com' }, impl);

    const signed = await client.signTransaction(WALLET, 'GSIGNER', 'AAAA');

    expect(signed.signature).toBe('sig');
    expect(calls[0]!.url).toBe(`https://recovery.example.com/accounts/${WALLET}/sign/GSIGNER`);
    expect(calls[0]!.init.body).toBe(JSON.stringify({ transaction: 'AAAA' }));
  });
});

describe('collectRecoverySignatures', () => {
  function serverThatFails(baseUrl: string): RecoveryServer {
    const { impl } = stubFetch([{ status: 401, body: { error: 'not authenticated' } }]);
    return { client: new Sep30Client({ baseUrl }, impl), baseUrl, signerKey: `${baseUrl}-signer` };
  }

  function serverThatSigns(baseUrl: string, signature: string): RecoveryServer {
    const { impl } = stubFetch([
      { status: 200, body: { signature, network_passphrase: Networks.TESTNET } },
    ]);
    return { client: new Sep30Client({ baseUrl }, impl), baseUrl, signerKey: `${baseUrl}-signer` };
  }

  it('tags each signature with the server that produced it', async () => {
    const servers = [
      serverThatSigns('https://a.example.com', 'sig-a'),
      serverThatSigns('https://b.example.com', 'sig-b'),
    ];

    const signatures = await collectRecoverySignatures(servers, WALLET, 'AAAA');

    expect(signatures.map((s) => [s.baseUrl, s.signature])).toEqual([
      ['https://a.example.com', 'sig-a'],
      ['https://b.example.com', 'sig-b'],
    ]);
  });

  it('rejects when a server fails and every signature is required', async () => {
    const servers = [
      serverThatSigns('https://a.example.com', 'sig-a'),
      serverThatFails('https://b.example.com'),
    ];

    await expect(collectRecoverySignatures(servers, WALLET, 'AAAA')).rejects.toThrow(Sep30Error);
  });

  it('keeps the signatures it did get for an M-of-N threshold', async () => {
    const servers = [
      serverThatSigns('https://a.example.com', 'sig-a'),
      serverThatFails('https://b.example.com'),
    ];

    const signatures = await collectRecoverySignatures(servers, WALLET, 'AAAA', {
      requireAll: false,
    });

    expect(signatures).toHaveLength(1);
    expect(signatures[0]!.signature).toBe('sig-a');
  });
});

// ── Server list ──────────────────────────────────────────────────────────────

describe('parseRecoveryServerUrls', () => {
  it('accepts a comma or whitespace separated list', () => {
    expect(
      parseRecoveryServerUrls('https://a.example.com, https://b.example.com\nhttps://c.example.com')
    ).toEqual(['https://a.example.com', 'https://b.example.com', 'https://c.example.com']);
  });

  it('drops trailing slashes and duplicates', () => {
    expect(parseRecoveryServerUrls('https://a.example.com/,https://a.example.com')).toEqual([
      'https://a.example.com',
    ]);
  });

  it('refuses anything that is not https', () => {
    expect(parseRecoveryServerUrls('http://a.example.com,ftp://b,example.com')).toEqual([]);
    expect(parseRecoveryServerUrls(null)).toEqual([]);
    expect(parseRecoveryServerUrls('')).toEqual([]);
  });
});

describe('remembered servers', () => {
  it('round-trips the server urls', async () => {
    await rememberRecoveryServers(['https://a.example.com', 'https://b.example.com']);

    await expect(getRememberedRecoveryServers()).resolves.toEqual([
      'https://a.example.com',
      'https://b.example.com',
    ]);
  });

  it('ignores stored junk rather than throwing on launch', async () => {
    mockStorage.set('veil_recovery_servers', 'not json');

    await expect(getRememberedRecoveryServers()).resolves.toEqual([]);
  });
});

// ── Addresses ────────────────────────────────────────────────────────────────

describe('address validation', () => {
  it('accepts a contract address as the wallet', () => {
    expect(isValidWalletAddress(WALLET)).toBe(true);
    expect(isValidWalletAddress(` ${WALLET} `)).toBe(true);
    expect(isValidWalletAddress(NOT_A_WALLET)).toBe(false);
    expect(isValidWalletAddress('C123')).toBe(false);
  });

  it('accepts an account address as the recovery key', () => {
    const account = Keypair.random().publicKey();

    expect(isValidRecoveryAddress(account)).toBe(true);
    expect(isValidRecoveryAddress(WALLET)).toBe(false);
  });
});

// ── Public key extraction ────────────────────────────────────────────────────

describe('spkiToUncompressedP256', () => {
  /** DER SubjectPublicKeyInfo header for an uncompressed prime256v1 key. */
  const P256_SPKI_HEADER = [
    0x30, 0x59, 0x30, 0x13, 0x06, 0x07, 0x2a, 0x86, 0x48, 0xce, 0x3d, 0x02, 0x01, 0x06, 0x08,
    0x2a, 0x86, 0x48, 0xce, 0x3d, 0x03, 0x01, 0x07, 0x03, 0x42, 0x00,
  ];

  function spki(point: Uint8Array): Uint8Array {
    return new Uint8Array([...P256_SPKI_HEADER, ...point]);
  }

  function samplePoint(): Uint8Array {
    const point = new Uint8Array(65).fill(0x11);
    point[0] = 0x04;
    return point;
  }

  it('returns the 65-byte uncompressed point', () => {
    const point = samplePoint();

    const extracted = spkiToUncompressedP256(spki(point));

    expect(extracted).toHaveLength(65);
    expect(toHex(extracted)).toBe(toHex(point));
  });

  it('rejects a key on another curve rather than truncating it', () => {
    // Same length, ed25519 OID (1.3.101.112) in place of the P-256 pair.
    const ed25519 = new Uint8Array([
      0x30, 0x2a, 0x30, 0x05, 0x06, 0x03, 0x2b, 0x65, 0x70, ...samplePoint(),
    ]);

    expect(() => spkiToUncompressedP256(ed25519)).toThrow(/P-256/);
  });

  it('rejects a compressed point', () => {
    const compressed = samplePoint();
    compressed[0] = 0x02;

    expect(() => spkiToUncompressedP256(spki(compressed))).toThrow(/P-256/);
  });

  it('rejects a truncated structure', () => {
    expect(() => spkiToUncompressedP256(new Uint8Array(40))).toThrow(/P-256/);
  });
});

// ── Signature attachment ─────────────────────────────────────────────────────

describe('attachRecoverySignatures', () => {
  const network = {
    name: 'testnet',
    displayName: 'Stellar Testnet',
    networkPassphrase: Networks.TESTNET,
    horizonUrl: 'https://horizon-testnet.stellar.org',
    rpcUrl: 'https://soroban-testnet.stellar.org',
    factoryContractId: '',
    friendbotUrl: 'https://friendbot.stellar.org',
  } as const;

  /** A signed transaction, used only as a source of a real signature and XDR. */
  function signedSample(): { xdr: string; signerKey: string; signature: string } {
    const keypair = Keypair.random();
    const tx = new TransactionBuilder(new Account(keypair.publicKey(), '1'), {
      fee: BASE_FEE,
      networkPassphrase: Networks.TESTNET,
    })
      .addOperation(Operation.bumpSequence({ bumpTo: '2' }))
      .setTimeout(60)
      .build();

    const unsigned = tx.toXDR();
    tx.sign(keypair);
    const signature = tx.signatures[0]!.signature().toString('base64');

    return { xdr: unsigned, signerKey: keypair.publicKey(), signature };
  }

  it('attaches a signature to the transaction it was produced for', () => {
    const sample = signedSample();
    const collected: CollectedSignature = {
      signature: sample.signature,
      network_passphrase: Networks.TESTNET,
      signerKey: sample.signerKey,
      baseUrl: 'https://a.example.com',
    };

    const result = attachRecoverySignatures(sample.xdr, [collected], network);

    const parsed = TransactionBuilder.fromXDR(result, Networks.TESTNET);
    expect(parsed.signatures).toHaveLength(1);
  });

  it('refuses a signature issued for another network', () => {
    const sample = signedSample();
    const collected: CollectedSignature = {
      signature: sample.signature,
      network_passphrase: Networks.PUBLIC,
      signerKey: sample.signerKey,
      baseUrl: 'https://a.example.com',
    };

    expect(() => attachRecoverySignatures(sample.xdr, [collected], network)).toThrow(
      /different network/
    );
  });

  it('refuses to submit a transaction no server signed', () => {
    const sample = signedSample();

    expect(() => attachRecoverySignatures(sample.xdr, [], network)).toThrow(/No recovery server/);
  });
});

// ── Timelock and errors ──────────────────────────────────────────────────────

describe('isRecoveryUnlocked', () => {
  const pending: PendingRecovery = {
    walletAddress: WALLET,
    recoveryAddress: 'GABC',
    credentialId: 'cred',
    publicKeyHex: '04',
    requestedAt: 1_000,
    unlockAt: 1_000 + 604_800,
    txHash: 'hash',
  };

  it('stays locked until the timelock has passed', () => {
    expect(isRecoveryUnlocked(pending, pending.unlockAt - 1)).toBe(false);
    // The contract requires strictly greater than unlock_at.
    expect(isRecoveryUnlocked(pending, pending.unlockAt)).toBe(false);
    expect(isRecoveryUnlocked(pending, pending.unlockAt + 1)).toBe(true);
  });
});

describe('simulationMessage', () => {
  it('translates the recovery contract errors', () => {
    expect(simulationMessage('HostError: Error(Contract, #13)')).toMatch(/already pending/);
    expect(simulationMessage('HostError: Error(Contract, #15)')).toMatch(/timelock/);
    expect(simulationMessage('HostError: Error(Contract, #22)')).toMatch(/no recovery key/i);
  });

  it('passes anything else through', () => {
    expect(simulationMessage('some rpc failure')).toBe('Simulation failed: some rpc failure');
  });
});
