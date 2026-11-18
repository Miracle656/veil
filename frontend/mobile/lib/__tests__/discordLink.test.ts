/**
 * Linking a wallet to Discord.
 *
 * Two things are pinned here. The signed text must match the backend's
 * character for character, or every signature is refused. And the passkey must
 * only ever be asked to sign the hash of that text, never a value a server
 * supplied: the same passkey signs payments.
 */

import { createHash } from 'crypto';

import { Keypair } from '@stellar/stellar-sdk';

import {
  DiscordLinkError,
  formatLinkCode,
  getLinkableAccounts,
  linkChallenge,
  linkDiscord,
  linkStatement,
  lookUpLinkCode,
  normalizeLinkCode,
} from '../discordLink';

const WALLET = 'CA5TXFITGGMG6HG6FJIHWOTXSZ43EIR4F5UCTAAY5FJWB5FWBG5Z3WPN';
const spendingKey = Keypair.random();

const mockSign = jest.fn();
const mockOwn = jest.fn();
const mockSecret = jest.fn();
const mockNames = jest.fn();

jest.mock('../passkey', () => ({ signPayloadWithPasskey: (...args: unknown[]) => mockSign(...args) }));
jest.mock('../ownAddresses', () => ({ getOwnAddresses: () => mockOwn() }));
jest.mock('../walletStore', () => ({ getSignerSecret: () => mockSecret() }));
jest.mock('../ownedNames', () => ({ loadOwnedNames: (...args: unknown[]) => mockNames(...args) }));
jest.mock('../network', () => ({ getNetworkName: () => 'mainnet' }));

const fetchMock = jest.fn();

function answer(status: number, body: unknown) {
  return { ok: status >= 200 && status < 300, status, json: async () => body };
}

beforeAll(() => {
  process.env['EXPO_PUBLIC_WRAITH_URL'] = 'https://wraith.test';
});

beforeEach(() => {
  jest.clearAllMocks();
  (globalThis as { fetch: unknown }).fetch = fetchMock;
  mockOwn.mockResolvedValue({ wallet: WALLET, spending: spendingKey.publicKey() });
  mockSecret.mockResolvedValue(spendingKey.secret());
  mockNames.mockResolvedValue({ names: [{ name: 'ada' }], complete: true });
  mockSign.mockResolvedValue({
    publicKey: new Uint8Array(65).fill(4),
    authData: new Uint8Array([1, 2, 3]),
    clientDataJSON: new Uint8Array([4, 5]),
    signature: new Uint8Array(64).fill(9),
  });
});

describe('the link statement', () => {
  const fields = { code: 'ABCD2345', discordUserId: '123456789012345678', wallet: WALLET, spending: null };

  it('is the same text the backend builds, line for line', () => {
    // Kept identical to wraith/src/__tests__/discord/proof.test.ts.
    expect(linkStatement(fields)).toBe(
      'veil-discord-link:v1\ncode=ABCD2345\ndiscord=123456789012345678\n' +
        'wallet=CA5TXFITGGMG6HG6FJIHWOTXSZ43EIR4F5UCTAAY5FJWB5FWBG5Z3WPN\nspending=',
    );
  });

  it('is signed as its SHA-256', () => {
    const expected = createHash('sha256').update(linkStatement(fields), 'utf8').digest();
    expect(Buffer.from(linkChallenge(fields)).equals(expected)).toBe(true);
  });
});

describe('link codes', () => {
  it('are read the way a person types them', () => {
    expect(normalizeLinkCode('abcd-2345')).toBe('ABCD2345');
    expect(normalizeLinkCode(' abcd 2345 ')).toBe('ABCD2345');
    expect(normalizeLinkCode('ABCD0123')).toBeNull(); // 0 and 1 are never used
    expect(normalizeLinkCode('abc')).toBeNull();
    expect(normalizeLinkCode(undefined)).toBeNull();
    expect(formatLinkCode('ABCD2345')).toBe('ABCD-2345');
  });
});

describe('which accounts can be linked', () => {
  it('offers the smart wallet and the spending account', async () => {
    expect(await getLinkableAccounts()).toEqual({ wallet: WALLET, spending: spendingKey.publicKey() });
  });

  it('does not treat a classic wallet address as a smart wallet', async () => {
    mockOwn.mockResolvedValue({ wallet: spendingKey.publicKey(), spending: spendingKey.publicKey() });
    expect(await getLinkableAccounts()).toEqual({ wallet: null, spending: spendingKey.publicKey() });
  });
});

describe('looking up a code', () => {
  it('returns whose code it is', async () => {
    fetchMock.mockResolvedValue(answer(200, { discordUserId: '123456789012345678', discordUsername: 'ada' }));
    expect(await lookUpLinkCode('ABCD2345')).toEqual({
      code: 'ABCD2345',
      discordUserId: '123456789012345678',
      discordUsername: 'ada',
    });
    expect(fetchMock.mock.calls[0][0]).toBe('https://wraith.test/discord/link/ABCD2345');
  });

  it("passes on the backend's own words when the code has run out", async () => {
    fetchMock.mockResolvedValue(answer(410, { error: 'That code is not valid any more.', code: 'code_invalid' }));
    await expect(lookUpLinkCode('ABCD2345')).rejects.toMatchObject({
      name: 'DiscordLinkError',
      code: 'code_invalid',
      message: 'That code is not valid any more.',
    });
  });

  it('refuses an answer with no usable Discord id, since the id is part of what gets signed', async () => {
    fetchMock.mockResolvedValue(answer(200, { discordUserId: 'x\nwallet=evil', discordUsername: 'ada' }));
    await expect(lookUpLinkCode('ABCD2345')).rejects.toBeInstanceOf(DiscordLinkError);
  });

  it('says so when Veil cannot be reached', async () => {
    fetchMock.mockRejectedValue(new Error('network down'));
    await expect(lookUpLinkCode('ABCD2345')).rejects.toMatchObject({ code: 'network' });
  });
});

describe('linking', () => {
  const info = { code: 'ABCD2345', discordUserId: '123456789012345678', discordUsername: 'ada' };
  const accounts = { wallet: WALLET, spending: spendingKey.publicKey() };

  it('asks the passkey to sign the statement hash and nothing else', async () => {
    fetchMock.mockResolvedValue(answer(200, { linked: true, roles: ['Veil Wallet'], incomplete: false, inServer: true }));
    await linkDiscord(info, accounts);

    const expected = linkChallenge({ ...info, wallet: accounts.wallet, spending: accounts.spending });
    expect(mockSign).toHaveBeenCalledTimes(1);
    expect(Buffer.from(mockSign.mock.calls[0][0]).equals(Buffer.from(expected))).toBe(true);
  });

  it('sends a spending-key signature the backend can verify, and the names as hints', async () => {
    fetchMock.mockResolvedValue(answer(200, { linked: true, roles: ['Veil Wallet', 'Name Holder'], incomplete: false, inServer: true }));
    const result = await linkDiscord(info, accounts);

    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('https://wraith.test/discord/link');
    const sent = JSON.parse(init.body);
    expect(sent).toMatchObject({ code: 'ABCD2345', wallet: WALLET, spending: accounts.spending, names: ['ada'] });
    expect(Object.keys(sent.passkey).sort()).toEqual(['authData', 'clientDataJSON', 'publicKey', 'signature']);

    const challenge = Buffer.from(linkChallenge({ ...info, wallet: accounts.wallet, spending: accounts.spending }));
    expect(spendingKey.verify(challenge, Buffer.from(sent.spendingSignature, 'base64url'))).toBe(true);
    expect(result).toEqual({ roles: ['Veil Wallet', 'Name Holder'], incomplete: false, inServer: true });
  });

  it('never sends the spending secret', async () => {
    fetchMock.mockResolvedValue(answer(200, { linked: true, roles: [] }));
    await linkDiscord(info, accounts);
    expect(fetchMock.mock.calls[0][1].body).not.toContain(spendingKey.secret());
  });

  it('links a classic wallet with no passkey prompt', async () => {
    fetchMock.mockResolvedValue(answer(200, { linked: true, roles: [] }));
    await linkDiscord(info, { wallet: null, spending: accounts.spending });
    expect(mockSign).not.toHaveBeenCalled();
    expect(JSON.parse(fetchMock.mock.calls[0][1].body).passkey).toBeUndefined();
  });

  it('sends nothing when the passkey prompt is cancelled', async () => {
    mockSign.mockRejectedValue(new Error('cancelled'));
    await expect(linkDiscord(info, accounts)).rejects.toThrow('cancelled');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('still links when the names cannot be listed', async () => {
    mockNames.mockRejectedValue(new Error('horizon down'));
    fetchMock.mockResolvedValue(answer(200, { linked: true, roles: [] }));
    await linkDiscord(info, accounts);
    expect(JSON.parse(fetchMock.mock.calls[0][1].body).names).toEqual([]);
  });

  it('refuses to sign for a spending account whose key is not on this phone', async () => {
    mockSecret.mockResolvedValue(Keypair.random().secret());
    await expect(linkDiscord(info, accounts)).rejects.toMatchObject({ code: 'no_spending_key' });
    expect(mockSign).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
