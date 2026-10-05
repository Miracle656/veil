/**
 * @jest-environment node
 */
import { TextEncoder, TextDecoder } from 'util'
import crypto from 'crypto'
Object.assign(globalThis, { TextEncoder, TextDecoder })

const storageMap = new Map<string, string>()
Object.defineProperty(globalThis, 'localStorage', {
  value: {
    getItem: (key: string) => storageMap.get(key) ?? null,
    setItem: (key: string, val: string) => storageMap.set(key, val),
    removeItem: (key: string) => storageMap.delete(key),
    clear: () => storageMap.clear(),
  },
  writable: true,
  configurable: true,
})

import {
  Keypair,
  Networks,
  TransactionBuilder,
  Account,
  Operation,
  TimeoutInfinite,
  Asset,
} from '@stellar/stellar-sdk'
import {
  signSep10Challenge,
  validateSep10Challenge,
  getSep10Jwt,
  Sep10ChallengeError,
} from '../sep24'
import { walletLocal } from '../walletStorage'

describe('SEP-10 Security & Validation Rules', () => {
  const serverKp = Keypair.random()
  const wrongServerKp = Keypair.random()
  const clientKp = Keypair.random()
  const homeDomain = 'testanchor.stellar.org'
  const webAuthEndpoint = 'https://testanchor.stellar.org/auth'

  function makeChallenge({
    seq = '-1',
    domain = homeDomain,
    server = serverKp,
    client = clientKp,
    timeBounds = 300 as number | 'infinite' | 'missing',
    ops = null as any[] | null,
    networkPassphrase = Networks.TESTNET as string,
  } = {}) {
    const acc = new Account(server.publicKey(), seq)
    const builder = new TransactionBuilder(acc, {
      fee: '100',
      networkPassphrase,
    })

    if (ops) {
      ops.forEach((op) => builder.addOperation(op))
    } else {
      builder.addOperation(
        Operation.manageData({
          source: client.publicKey(),
          name: `${domain} auth`,
          value: crypto.randomBytes(48).toString('base64'),
        }),
      )
    }

    if (timeBounds === 'infinite') {
      builder.setTimeout(TimeoutInfinite)
    } else if (typeof timeBounds === 'number') {
      builder.setTimeout(timeBounds)
    }

    const tx = builder.build()
    tx.sign(server)
    return tx.toXDR()
  }

  it('rejects a challenge with a manageData op plus a payment op', () => {
    const challengeXdr = makeChallenge({
      ops: [
        Operation.manageData({
          source: clientKp.publicKey(),
          name: `${homeDomain} auth`,
          value: crypto.randomBytes(48).toString('base64'),
        }),
        Operation.payment({
          destination: clientKp.publicKey(),
          asset: Asset.native(),
          amount: '10',
        }),
      ],
    })

    expect(() =>
      validateSep10Challenge(challengeXdr, Networks.TESTNET, homeDomain, serverKp.publicKey()),
    ).toThrow(Sep10ChallengeError)
  })

  it('rejects wrong server signature or wrong SIGNING_KEY', () => {
    const challengeXdr = makeChallenge({ server: wrongServerKp })
    expect(() =>
      validateSep10Challenge(challengeXdr, Networks.TESTNET, homeDomain, serverKp.publicKey()),
    ).toThrow(Sep10ChallengeError)
  })

  it('rejects non-zero sequence number', () => {
    const challengeXdr = makeChallenge({ seq: '0' })
    expect(() =>
      validateSep10Challenge(challengeXdr, Networks.TESTNET, homeDomain, serverKp.publicKey()),
    ).toThrow(Sep10ChallengeError)
  })

  it('rejects wrong home domain', () => {
    const challengeXdr = makeChallenge({ domain: 'wrongdomain.org' })
    expect(() =>
      validateSep10Challenge(challengeXdr, Networks.TESTNET, homeDomain, serverKp.publicKey()),
    ).toThrow(Sep10ChallengeError)
  })

  it('rejects expired or missing timeBounds', () => {
    const infiniteXdr = makeChallenge({ timeBounds: 'infinite' })
    expect(() =>
      validateSep10Challenge(infiniteXdr, Networks.TESTNET, homeDomain, serverKp.publicKey()),
    ).toThrow(Sep10ChallengeError)
  })

  it('rejects anchor-supplied network_passphrase that differs from caller expected passphrase', async () => {
    const challengeXdr = makeChallenge({ networkPassphrase: 'Wrong Network Passphrase' })

    const mockFetch = jest.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        transaction: challengeXdr,
        network_passphrase: 'Wrong Network Passphrase',
      }),
    })

    await expect(
      getSep10Jwt(
        webAuthEndpoint,
        clientKp.publicKey(),
        Networks.TESTNET,
        homeDomain,
        serverKp.publicKey(),
        mockFetch as unknown as typeof fetch,
      ),
    ).rejects.toThrow('Anchor returned network_passphrase "Wrong Network Passphrase" which differs from expected')
  })

  it('accepts and signs valid challenge via signSep10Challenge helper', () => {
    const challengeXdr = makeChallenge()
    const signedXdr = signSep10Challenge(
      challengeXdr,
      Networks.TESTNET,
      clientKp,
      homeDomain,
      serverKp.publicKey(),
    )
    expect(signedXdr).toBeDefined()
    expect(signedXdr).not.toEqual(challengeXdr)
  })
})
