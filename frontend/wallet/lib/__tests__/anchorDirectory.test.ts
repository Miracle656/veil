import { TextEncoder, TextDecoder } from 'util'
Object.assign(globalThis, { TextEncoder, TextDecoder })

import { Asset, Keypair, Networks, TransactionBuilder, Account, Operation, Transaction, WebAuth } from '@stellar/stellar-sdk'
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
  const otherKp = Keypair.random()
  const HOME_DOMAIN = 'testanchor.stellar.org'
  const webAuthEndpoint = 'https://testanchor.stellar.org/auth'
  const WEB_AUTH_DOMAIN = 'testanchor.stellar.org'

  /** A challenge exactly as SEP-10 specifies one, signed by the anchor. */
  function validChallenge(signer: Keypair = anchorKp, client: string = userKp.publicKey()): string {
    return WebAuth.buildChallengeTx(
      signer,
      client,
      HOME_DOMAIN,
      300,
      Networks.TESTNET,
      WEB_AUTH_DOMAIN,
    )
  }

  /**
   * The attack this function exists to refuse.
   *
   * Built from a spec-correct challenge so that the ONLY thing wrong with it is
   * the extra operation — otherwise a rejection proves nothing about the
   * every-operation check, only that something else was malformed. The old
   * implementation checked that SOME operation was a manage_data, so this
   * passed every gate and was signed in full.
   */
  function challengeWithExtraPayment(): string {
    // Hand-built rather than rebuilt from a parsed challenge: operations decoded
    // off a Transaction cannot be re-added to a TransactionBuilder. Both
    // manage_data operations are exactly what SEP-10 requires, so the only thing
    // wrong with this challenge is the third operation.
    const server = new Account(anchorKp.publicKey(), '-1')
    const tx = new TransactionBuilder(server, {
      fee: '100',
      networkPassphrase: Networks.TESTNET,
    })
      .addOperation(
        Operation.manageData({
          name: `${HOME_DOMAIN} auth`,
          // 48 random bytes, base64 — the nonce shape SEP-10 specifies.
          value: Buffer.from(Keypair.random().rawSecretKey().subarray(0, 32)).toString('base64'),
          source: userKp.publicKey(),
        }),
      )
      .addOperation(
        Operation.manageData({
          name: 'web_auth_domain',
          value: WEB_AUTH_DOMAIN,
          source: anchorKp.publicKey(),
        }),
      )
      .addOperation(
        Operation.payment({
          destination: otherKp.publicKey(),
          asset: Asset.native(),
          amount: '9999',
          source: userKp.publicKey(),
        }),
      )
      .setTimeout(300)
      .build()
    tx.sign(anchorKp)
    return tx.toXDR()
  }

  /** A fetch that serves `challengeXdr`, then accepts the countersigned post. */
  function mockAnchor(challengeXdr: string, networkPassphrase: string | undefined = Networks.TESTNET) {
    return jest.fn(async (url: string, init?: RequestInit) => {
      if (url.includes('?account=')) {
        return {
          ok: true,
          json: async () => ({
            transaction: challengeXdr,
            ...(networkPassphrase ? { network_passphrase: networkPassphrase } : {}),
          }),
        }
      }
      if (init?.method === 'POST') {
        const body = JSON.parse(init.body as string)
        // Privacy: the countersigned challenge and nothing else.
        expect(Object.keys(body)).toEqual(['transaction'])
        return { ok: true, json: async () => ({ token: 'mock-jwt-token-xyz' }) }
      }
      return { ok: false, status: 404 }
    })
  }

  const baseOptions = () => ({
    webAuthEndpoint,
    account: userKp.publicKey(),
    networkPassphrase: Networks.TESTNET,
    signingKey: anchorKp.publicKey(),
    homeDomain: HOME_DOMAIN,
    signerKeypair: userKp,
  })

  it('authenticates against a testnet anchor and receives a JWT', async () => {
    const mockFetch = mockAnchor(validChallenge())

    const token = await authenticateSep10({
      ...baseOptions(),
      fetchFn: mockFetch as unknown as typeof fetch,
    })

    expect(token).toBe('mock-jwt-token-xyz')
    expect(mockFetch).toHaveBeenCalledTimes(2)
  })

  it("posts back a challenge that still carries the anchor's signature", async () => {
    // Rebuilding the transaction before signing drops the server signature, and
    // a challenge returned with only the client's is rejected by a real anchor.
    const mockFetch = mockAnchor(validChallenge())
    await authenticateSep10({ ...baseOptions(), fetchFn: mockFetch as unknown as typeof fetch })

    const post = mockFetch.mock.calls.find(([, init]) => (init as RequestInit)?.method === 'POST')!
    const posted = new Transaction(
      JSON.parse((post[1] as RequestInit).body as string).transaction,
      Networks.TESTNET,
    )
    expect(posted.signatures).toHaveLength(2)
  })

  it('refuses a challenge that also moves money', async () => {
    const mockFetch = mockAnchor(challengeWithExtraPayment())

    await expect(
      authenticateSep10({ ...baseOptions(), fetchFn: mockFetch as unknown as typeof fetch }),
    ).rejects.toThrow(/Rejected the SEP-10 challenge/)

    // And nothing was ever posted back, so nothing was signed and sent.
    expect(mockFetch).toHaveBeenCalledTimes(1)
  })

  it('refuses a challenge signed by anyone but the published SIGNING_KEY', async () => {
    const mockFetch = mockAnchor(validChallenge(otherKp))

    await expect(
      authenticateSep10({ ...baseOptions(), fetchFn: mockFetch as unknown as typeof fetch }),
    ).rejects.toThrow(/Rejected the SEP-10 challenge/)
  })

  it('refuses a challenge issued for a different account', async () => {
    const mockFetch = mockAnchor(validChallenge(anchorKp, otherKp.publicKey()))

    await expect(
      authenticateSep10({ ...baseOptions(), fetchFn: mockFetch as unknown as typeof fetch }),
    ).rejects.toThrow(/different account|Rejected the SEP-10 challenge/)
  })

  it('refuses to let the response choose the network', async () => {
    // A testnet flow that signs a mainnet-valid signature is the whole reason
    // the caller's passphrase is the only one used.
    const mockFetch = mockAnchor(validChallenge(), Networks.PUBLIC)

    await expect(
      authenticateSep10({ ...baseOptions(), fetchFn: mockFetch as unknown as typeof fetch }),
    ).rejects.toThrow(/different Stellar network/)

    expect(mockFetch).toHaveBeenCalledTimes(1)
  })

  it('refuses an anchor with no SIGNING_KEY rather than skipping verification', async () => {
    const mockFetch = mockAnchor(validChallenge())

    await expect(
      authenticateSep10({
        ...baseOptions(),
        signingKey: '',
        fetchFn: mockFetch as unknown as typeof fetch,
      }),
    ).rejects.toThrow(/no SEP-10 SIGNING_KEY/)

    expect(mockFetch).not.toHaveBeenCalled()
  })

  it('throws when the anchor challenge request fails', async () => {
    const mockFetch = jest.fn().mockResolvedValue({
      ok: false,
      status: 400,
      text: async () => 'Account not found',
    })

    await expect(
      authenticateSep10({
        ...baseOptions(),
        fetchFn: mockFetch as unknown as typeof fetch,
      }),
    ).rejects.toThrow('SEP-10 challenge fetch failed')
  })
})
