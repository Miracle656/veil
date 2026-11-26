jest.mock('../network', () => ({
  getNetwork: jest.fn(() => ({
    displayName: 'Stellar Mainnet',
    networkPassphrase: 'Public Global Network',
  })),
}));

import {
  Keypair,
  Networks,
  TransactionBuilder,
  Account,
  Operation,
  Asset,
  Transaction,
} from '@stellar/stellar-sdk';
import {
  discoverAnchorInfo,
  signSep10Challenge,
  validateSep10Challenge,
  getSep10Jwt,
  Sep10ChallengeError,
} from '../sep24';
import { getNetwork } from '../network';

const mockGetNetwork = getNetwork as jest.MockedFunction<typeof getNetwork>;

describe('discoverAnchorInfo', () => {
  it('uses the active mainnet passphrase when the anchor omits NETWORK_PASSPHRASE', async () => {
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      text: async () => [
        'TRANSFER_SERVER_SEP0024 = "https://anchor.example/sep24"',
        'WEB_AUTH_ENDPOINT = "https://anchor.example/auth"',
      ].join('\n'),
    }) as jest.Mock;

    await expect(discoverAnchorInfo('anchor.example')).resolves.toMatchObject({
      networkPassphrase: 'Public Global Network',
      transferServerUrl: 'https://anchor.example/sep24',
    });
  });

  it('fails clearly when the active network has no passphrase', async () => {
    mockGetNetwork.mockReturnValueOnce({
      name: 'mainnet',
      displayName: 'Stellar Mainnet',
      networkPassphrase: '',
      horizonUrl: '',
      rpcUrl: '',
      factoryContractId: '',
      friendbotUrl: null,
    });

    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      text: async () => [
        'TRANSFER_SERVER_SEP0024 = "https://anchor.example/sep24"',
        'WEB_AUTH_ENDPOINT = "https://anchor.example/auth"',
      ].join('\n'),
    }) as jest.Mock;

    await expect(discoverAnchorInfo('anchor.example')).rejects.toThrow(
      'No network passphrase is configured for Stellar Mainnet.',
    );
  });
});

describe('SEP-10 Mobile Challenge Validation', () => {
  const serverKp = Keypair.random();
  const clientKp = Keypair.random();
  const homeDomain = 'mobileanchor.stellar.org';
  const webAuthEndpoint = 'https://mobileanchor.stellar.org/auth';
  const WEB_AUTH_DOMAIN = 'mobileanchor.stellar.org';

  function makeChallenge({
    seq = '-1',
    domain = homeDomain,
    server = serverKp,
    client = clientKp,
    ops = null as any[] | null,
    networkPassphrase = Networks.TESTNET as string,
  } = {}) {
    const acc = new Account(server.publicKey(), seq);
    const builder = new TransactionBuilder(acc, {
      fee: '100',
      networkPassphrase,
    });

    if (ops) {
      ops.forEach((op) => builder.addOperation(op));
    } else {
      const raw = Buffer.alloc(48);
      for (let i = 0; i < 48; i++) raw[i] = i;
      builder.addOperation(
        Operation.manageData({
          source: client.publicKey(),
          name: `${domain} auth`,
          value: raw.toString('base64'),
        }),
      );
    }

    builder.setTimeout(300);
    const tx = builder.build();
    tx.sign(server);
    return tx.toXDR();
  }

  it('rejects a challenge with a manageData op plus a payment op', () => {
    const challengeXdr = makeChallenge({
      ops: [
        Operation.manageData({
          source: clientKp.publicKey(),
          name: `${homeDomain} auth`,
          value: Buffer.alloc(48).toString('base64'),
        }),
        Operation.payment({
          destination: clientKp.publicKey(),
          asset: Asset.native(),
          amount: '10',
        }),
      ],
    });

    expect(() =>
      validateSep10Challenge(challengeXdr, Networks.TESTNET, homeDomain, serverKp.publicKey(), WEB_AUTH_DOMAIN),
    ).toThrow(Sep10ChallengeError);
  });

  it('rejects non-zero sequence number', () => {
    const challengeXdr = makeChallenge({ seq: '0' });
    expect(() =>
      validateSep10Challenge(challengeXdr, Networks.TESTNET, homeDomain, serverKp.publicKey(), WEB_AUTH_DOMAIN),
    ).toThrow(Sep10ChallengeError);
  });

  it('rejects anchor-supplied network_passphrase mismatch in getSep10Jwt', async () => {
    const challengeXdr = makeChallenge({ networkPassphrase: 'Other Passphrase' });

    const mockFetch = jest.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        transaction: challengeXdr,
        network_passphrase: 'Other Passphrase',
      }),
    });

    global.fetch = mockFetch;

    const mockSigner = jest.fn();

    await expect(
      getSep10Jwt(webAuthEndpoint, clientKp.publicKey(), Networks.TESTNET, mockSigner),
    ).rejects.toThrow('Anchor returned network_passphrase "Other Passphrase" which differs from expected');
  });

  it('validates and signs a well-formed challenge', () => {
    const challengeXdr = makeChallenge();
    const signedXdr = signSep10Challenge(
      challengeXdr,
      Networks.TESTNET,
      clientKp,
      homeDomain,
      serverKp.publicKey(),
      WEB_AUTH_DOMAIN,
    );
    expect(signedXdr).toBeDefined();
    expect(signedXdr).not.toEqual(challengeXdr);
  });

  it("keeps the anchor's signature on the challenge it signs", () => {
    // Rebuilding before signing drops the server signature, and an anchor wants
    // the challenge back carrying both.
    const signedXdr = signSep10Challenge(
      makeChallenge(),
      Networks.TESTNET,
      clientKp,
      homeDomain,
      serverKp.publicKey(),
      WEB_AUTH_DOMAIN,
    );
    expect(new Transaction(signedXdr, Networks.TESTNET).signatures).toHaveLength(2);
  });

  it('will not verify a challenge against a key the challenge itself chose', () => {
    // The hazard being pinned: deriving the expected server account from the
    // transaction's own source, or the home domain from its own manage_data
    // name, verifies the challenge against its own claims. An attacker's
    // self-signed challenge then passes every check.
    const attacker = Keypair.random();
    const forged = makeChallenge({ server: attacker, domain: homeDomain });

    expect(() =>
      validateSep10Challenge(forged, Networks.TESTNET, homeDomain, serverKp.publicKey(), WEB_AUTH_DOMAIN),
    ).toThrow(Sep10ChallengeError);
  });

  it('refuses to validate at all when the anchor published no SIGNING_KEY', () => {
    expect(() =>
      validateSep10Challenge(makeChallenge(), Networks.TESTNET, homeDomain, '', WEB_AUTH_DOMAIN),
    ).toThrow(/SIGNING_KEY/);
  });
});
