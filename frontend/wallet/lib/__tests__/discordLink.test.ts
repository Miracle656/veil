/**
 * @jest-environment node
 *
 * The web half of Discord linking. The signed text must match the backend's
 * and the phone's character for character, and the passkey must only ever be
 * asked to sign the hash of that text.
 */
import { createHash } from 'crypto'

import { Keypair } from '@stellar/stellar-sdk'

const store = new Map<string, string>()
const storage = { getItem: (key: string) => store.get(key) ?? null }
jest.mock('../walletStorage', () => ({ walletLocal: storage, walletSession: storage }))
jest.mock('../network', () => ({ getNetworkName: () => 'mainnet' }))

const mockSign = jest.fn()
jest.mock('../passkeySigner', () => ({ buildSignAuthEntry: () => mockSign }))

import {
  getLinkableAccounts,
  linkChallenge,
  linkDiscord,
  linkStatement,
  normalizeLinkCode,
} from '../discordLink'

const WALLET = 'CA5TXFITGGMG6HG6FJIHWOTXSZ43EIR4F5UCTAAY5FJWB5FWBG5Z3WPN'
const spendingKey = Keypair.random()
const info = { code: 'ABCD2345', discordUserId: '123456789012345678', discordUsername: 'ada' }
const fetchMock = jest.fn()

beforeEach(() => {
  store.clear()
  jest.clearAllMocks()
  process.env.NEXT_PUBLIC_WRAITH_URL = 'https://wraith.test/'
  ;(globalThis as { fetch: unknown }).fetch = fetchMock
  fetchMock.mockResolvedValue({ ok: true, status: 200, json: async () => ({ linked: true, roles: ['Veil Wallet'] }) })
  mockSign.mockResolvedValue({
    publicKey: new Uint8Array(65).fill(4),
    authData: new Uint8Array([1, 2, 3]),
    clientDataJSON: new Uint8Array([4, 5]),
    signature: new Uint8Array(64).fill(9),
  })
})

it('builds the same statement as the backend and the phone', () => {
  const fields = { code: 'ABCD2345', discordUserId: '123456789012345678', wallet: WALLET, spending: null }
  expect(linkStatement(fields)).toBe(
    'veil-discord-link:v1\ncode=ABCD2345\ndiscord=123456789012345678\n' +
      'wallet=CA5TXFITGGMG6HG6FJIHWOTXSZ43EIR4F5UCTAAY5FJWB5FWBG5Z3WPN\nspending=',
  )
  const expected = createHash('sha256').update(linkStatement(fields), 'utf8').digest()
  expect(Buffer.from(linkChallenge(fields)).equals(expected)).toBe(true)
})

it('reads a code the way a person types it', () => {
  expect(normalizeLinkCode('abcd-2345')).toBe('ABCD2345')
  expect(normalizeLinkCode('ABCD0123')).toBeNull()
})

describe('what this browser can link', () => {
  it('offers the wallet only when its passkey is here', () => {
    store.set('invisible_wallet_address', WALLET)
    store.set('veil_signer_secret', spendingKey.secret())
    expect(getLinkableAccounts()).toEqual({ wallet: null, spending: spendingKey.publicKey() })

    store.set('invisible_wallet_key_id', 'abc')
    store.set('invisible_wallet_public_key', '04')
    expect(getLinkableAccounts()).toEqual({ wallet: WALLET, spending: spendingKey.publicKey() })
  })

  it('offers nothing in a browser with no wallet', () => {
    expect(getLinkableAccounts()).toEqual({ wallet: null, spending: null })
  })
})

describe('linking', () => {
  const accounts = { wallet: WALLET, spending: spendingKey.publicKey() }
  beforeEach(() => store.set('veil_signer_secret', spendingKey.secret()))

  it('asks the passkey to sign the statement hash and nothing else', async () => {
    await linkDiscord(info, accounts)
    const expected = linkChallenge({ ...info, wallet: accounts.wallet, spending: accounts.spending })
    expect(mockSign).toHaveBeenCalledTimes(1)
    expect(Buffer.from(mockSign.mock.calls[0][0]).equals(Buffer.from(expected))).toBe(true)
  })

  it('sends a spending signature the backend can verify, and never the secret', async () => {
    const result = await linkDiscord(info, accounts)
    const [url, init] = fetchMock.mock.calls[0]
    expect(url).toBe('https://wraith.test/discord/link')
    const sent = JSON.parse(init.body)
    const challenge = Buffer.from(linkChallenge({ ...info, wallet: accounts.wallet, spending: accounts.spending }))
    expect(spendingKey.verify(challenge, Buffer.from(sent.spendingSignature, 'base64url'))).toBe(true)
    expect(init.body).not.toContain(spendingKey.secret())
    expect(result).toEqual({ roles: ['Veil Wallet'], incomplete: false, inServer: true })
  })

  it('sends nothing when the passkey prompt is dismissed', async () => {
    mockSign.mockResolvedValue(null)
    expect(await linkDiscord(info, accounts)).toBeNull()
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it("passes on the backend's own words when it refuses", async () => {
    fetchMock.mockResolvedValue({
      ok: false,
      status: 401,
      json: async () => ({ error: 'That passkey is not one of this wallet\'s keys.', code: 'not_a_signer' }),
    })
    await expect(linkDiscord(info, accounts)).rejects.toMatchObject({ code: 'not_a_signer' })
  })
})
