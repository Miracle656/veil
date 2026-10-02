import { TextEncoder, TextDecoder } from 'util'
Object.assign(globalThis, { TextEncoder, TextDecoder })

import { Keypair, Networks, TransactionBuilder, Account, Operation } from '@stellar/stellar-sdk'
import {
  parseAnchorToml,
  registerDiscoveredAsset,
  authenticateSep10,
  HostileTomlInjectionError,
  VERIFIED_ASSET_REGISTRY,
  isValidStellarPublicKey,
  isValidAssetCode,
  type DiscoveredCurrency,
} from '../anchorDirectory'

const VALID_ISSUER_1 = Keypair.random().publicKey()
const VALID_ISSUER_2 = Keypair.random().publicKey()
const ONDO_USDY_ISSUER = VERIFIED_ASSET_REGISTRY.USDY.issuer

describe('isValidStellarPublicKey', () => {
  it('validates Ed25519 public keys', () => {
    expect(isValidStellarPublicKey(VALID_ISSUER_1)).toBe(true)
    expect(isValidStellarPublicKey('INVALID_KEY')).toBe(false)
    expect(isValidStellarPublicKey('')).toBe(false)
  })
})

describe('isValidAssetCode', () => {
  it('validates 1 to 12 character alphanumeric codes', () => {
    expect(isValidAssetCode('USDC')).toBe(true)
    expect(isValidAssetCode('USDY')).toBe(true)
    expect(isValidAssetCode('VERYLONGASSET12')).toBe(false)
    expect(isValidAssetCode('BAD_CODE!')).toBe(false)
  })
})

describe('parseAnchorToml', () => {
  it('parses valid TOML endpoints, accounts and currencies with issuer verification', async () => {
    const toml = `
TRANSFER_SERVER_SEP0024 = "https://anchor.example.com/sep24"
WEB_AUTH_ENDPOINT = "https://anchor.example.com/auth"
NETWORK_PASSPHRASE = "Test SDF Network ; September 2015"
ACCOUNTS = ["${VALID_ISSUER_1}"]

[[CURRENCIES]]
code = "TOKEN1"
issuer = "${VALID_ISSUER_1}"
name = "Token One"

[[CURRENCIES]]
code = "XLM"
`
    const info = await parseAnchorToml(toml, 'example.com')
    expect(info.transferServerSep24).toBe('https://anchor.example.com/sep24')
    expect(info.webAuthEndpoint).toBe('https://anchor.example.com/auth')
    expect(info.accounts).toEqual([VALID_ISSUER_1])
    expect(info.currencies.length).toBe(2)

    const token1 = info.currencies.find((c) => c.code === 'TOKEN1')
    expect(token1).toBeDefined()
    expect(token1?.isIssuerVerified).toBe(true)
    expect(token1?.isVerifiedRegistry).toBe(false)

    const xlm = info.currencies.find((c) => c.code === 'XLM')
    expect(xlm).toBeDefined()
    expect(xlm?.isIssuerVerified).toBe(true)
  })

  it('detects and flags hostile impersonation of pinned verified assets', async () => {
    const hostileToml = `
[[CURRENCIES]]
code = "USDY"
issuer = "${VALID_ISSUER_1}" # Fake issuer trying to pass off as USDY
`
    const info = await parseAnchorToml(hostileToml, 'evil.com')
    expect(info.currencies.length).toBe(1)
    const fakeUsdy = info.currencies[0]

    expect(fakeUsdy.code).toBe('USDY')
    expect(fakeUsdy.issuer).toBe(VALID_ISSUER_1)
    expect(fakeUsdy.isImpersonating).toBe(true)
    expect(fakeUsdy.isVerifiedRegistry).toBe(false)
    expect(fakeUsdy.verifiedIssuer).toBe(ONDO_USDY_ISSUER)
  })

  it('recognizes genuine verified registry asset matching pinned issuer', async () => {
    const genuineToml = `
[[CURRENCIES]]
code = "USDY"
issuer = "${ONDO_USDY_ISSUER}"
`
    const info = await parseAnchorToml(genuineToml, 'ondo.finance')
    expect(info.currencies.length).toBe(1)
    const genuineUsdy = info.currencies[0]

    expect(genuineUsdy.isVerifiedRegistry).toBe(true)
    expect(genuineUsdy.isImpersonating).toBe(false)
  })

  it('handles malformed or invalid TOML input safely without throwing', async () => {
    const malformed = `[CURRENCIES\ncode = invalid syntax {{{}}}`
    const info = await parseAnchorToml(malformed, 'bad.com')
    expect(info.currencies).toEqual([])
    expect(info.accounts).toEqual([])
  })

  it('drops currencies with invalid issuers when ACCOUNTS list is provided', async () => {
    const tomlWithAccounts = `
ACCOUNTS = ["${VALID_ISSUER_1}"]

[[CURRENCIES]]
code = "VALID"
issuer = "${VALID_ISSUER_1}"

[[CURRENCIES]]
code = "UNAUTHORIZED"
issuer = "${VALID_ISSUER_2}"
`
    const info = await parseAnchorToml(tomlWithAccounts, 'example.com')
    const unauth = info.currencies.find((c) => c.code === 'UNAUTHORIZED')
    expect(unauth?.isIssuerVerified).toBe(false)
  })
})

describe('registerDiscoveredAsset (Hostile TOML Defense)', () => {
  it('allows registering verified assets', () => {
    const validAsset: DiscoveredCurrency = {
      code: 'NEWCOIN',
      issuer: VALID_ISSUER_1,
      isIssuerVerified: true,
      isVerifiedRegistry: false,
      isImpersonating: false,
    }
    expect(registerDiscoveredAsset(validAsset)).toBe(true)
  })

  it('blocks registration if issuer is unverified', () => {
    const unverifiedAsset: DiscoveredCurrency = {
      code: 'BADCOIN',
      issuer: VALID_ISSUER_2,
      isIssuerVerified: false,
      isVerifiedRegistry: false,
    }
    expect(() => registerDiscoveredAsset(unverifiedAsset)).toThrow(HostileTomlInjectionError)
  })

  it('blocks registration if asset is impersonating a verified registry asset', () => {
    const fakeUsdy: DiscoveredCurrency = {
      code: 'USDY',
      issuer: VALID_ISSUER_1,
      isIssuerVerified: true,
      isVerifiedRegistry: false,
      isImpersonating: true,
      verifiedIssuer: ONDO_USDY_ISSUER,
    }
    expect(() => registerDiscoveredAsset(fakeUsdy)).toThrow(HostileTomlInjectionError)
  })
})

describe('authenticateSep10', () => {
  const userKp = Keypair.random()
  const anchorKp = Keypair.random()
  const webAuthEndpoint = 'https://testanchor.stellar.org/auth'

  it('authenticates against testnet anchor using user key and receives JWT', async () => {
    // Build mock challenge tx
    const account = new Account(userKp.publicKey(), '0')
    const challengeTx = new TransactionBuilder(account, {
      fee: '100',
      networkPassphrase: Networks.TESTNET,
    })
      .addOperation(
        Operation.manageData({
          name: 'testanchor.stellar.org auth',
          value: 'randomnonce',
        }),
      )
      .setTimeout(300)
      .build()
    challengeTx.sign(anchorKp)
    const challengeXdr = challengeTx.toXDR()

    const mockFetch = jest.fn().mockImplementation(async (url: string, init?: RequestInit) => {
      if (url.includes('?account=')) {
        return {
          ok: true,
          json: async () => ({
            transaction: challengeXdr,
            network_passphrase: Networks.TESTNET,
          }),
        }
      }
      if (init?.method === 'POST') {
        const body = JSON.parse(init.body as string)
        expect(body.transaction).toBeDefined()
        // Ensure privacy: no user PII in request payload
        expect(Object.keys(body)).toEqual(['transaction'])
        return {
          ok: true,
          json: async () => ({ token: 'mock-jwt-token-xyz' }),
        }
      }
      return { ok: false, status: 404 }
    })

    const token = await authenticateSep10({
      webAuthEndpoint,
      account: userKp.publicKey(),
      networkPassphrase: Networks.TESTNET,
      signerKeypair: userKp,
      fetchFn: mockFetch as unknown as typeof fetch,
    })

    expect(token).toBe('mock-jwt-token-xyz')
    expect(mockFetch).toHaveBeenCalledTimes(2)
  })

  it('throws error if anchor challenge fails or is missing token', async () => {
    const mockFetch = jest.fn().mockResolvedValue({
      ok: false,
      status: 400,
      text: async () => 'Account not found',
    })

    await expect(
      authenticateSep10({
        webAuthEndpoint,
        account: userKp.publicKey(),
        signerKeypair: userKp,
        fetchFn: mockFetch as unknown as typeof fetch,
      }),
    ).rejects.toThrow('SEP-10 challenge fetch failed')
  })
})
