/**
 * @jest-environment node
 */

import {
  HOME_DOMAIN,
  getNamesContractId,
  lookupFederationName,
  parseFederationName,
} from '../federationServer'

describe('parseFederationName', () => {
  it('splits a name on our own domain', () => {
    expect(parseFederationName('adebayo*useveilapp.xyz')).toEqual({
      name: 'adebayo',
      domain: 'useveilapp.xyz',
    })
  })

  it('lowercases both halves, because a name is case-insensitive to a sender', () => {
    expect(parseFederationName('Adebayo*UseVeilApp.XYZ')).toEqual({
      name: 'adebayo',
      domain: 'useveilapp.xyz',
    })
  })

  it('refuses another domain rather than answering for it', () => {
    // Being asked about someone else's domain is normal, not an error — the
    // caller found us through *their* stellar.toml, or is probing.
    expect(parseFederationName('adebayo*lobstr.co')).toBeNull()
    expect(parseFederationName(`adebayo*evil-${HOME_DOMAIN}`)).toBeNull()
    expect(parseFederationName(`adebayo*${HOME_DOMAIN}.attacker.com`)).toBeNull()
  })

  it('refuses anything that is not exactly one asterisk', () => {
    expect(parseFederationName('adebayo')).toBeNull()
    expect(parseFederationName('adebayo*useveilapp.xyz*extra')).toBeNull()
    expect(parseFederationName('*useveilapp.xyz')).toBeNull()
    expect(parseFederationName('adebayo*')).toBeNull()
  })

  it('refuses a raw Stellar address', () => {
    expect(
      parseFederationName('GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF'),
    ).toBeNull()
    expect(parseFederationName('CCZ3JLRESNLDADGXWNEH4YQ4NXUUAHRJNCWZHYG6QB4KTDYHOH6OQ7BK')).toBeNull()
  })

  it('refuses empty and whitespace queries', () => {
    expect(parseFederationName('')).toBeNull()
    expect(parseFederationName('   ')).toBeNull()
  })

  it('trims surrounding whitespace', () => {
    expect(parseFederationName('  adebayo*useveilapp.xyz  ')?.name).toBe('adebayo')
  })

  // The shape rules mirror `validate_shape` in contracts/veil-names/src/lib.rs.
  // They are a short-circuit, not the authority — the contract re-checks,
  // because anyone can invoke it directly.
  describe('name shape, mirroring the contract', () => {
    it('refuses names outside 3 to 20 characters', () => {
      expect(parseFederationName('ab*useveilapp.xyz')).toBeNull()
      expect(parseFederationName(`${'a'.repeat(21)}*useveilapp.xyz`)).toBeNull()
      expect(parseFederationName('abc*useveilapp.xyz')?.name).toBe('abc')
      expect(parseFederationName(`${'a'.repeat(20)}*useveilapp.xyz`)?.name).toBe('a'.repeat(20))
    })

    it('allows an interior underscore and digits', () => {
      expect(parseFederationName('ade_bayo9*useveilapp.xyz')?.name).toBe('ade_bayo9')
    })

    it('refuses a leading, trailing or doubled underscore', () => {
      expect(parseFederationName('_adebayo*useveilapp.xyz')).toBeNull()
      expect(parseFederationName('adebayo_*useveilapp.xyz')).toBeNull()
      expect(parseFederationName('ade__bayo*useveilapp.xyz')).toBeNull()
    })

    it('refuses characters outside lowercase, digits and underscore', () => {
      for (const bad of ['ade-bayo', 'ade.bayo', 'ade bayo', 'adeb@yo', 'adebayó']) {
        expect(parseFederationName(`${bad}*useveilapp.xyz`)).toBeNull()
      }
    })

    it('refuses a Cyrillic homoglyph rather than folding it to ASCII', () => {
      // jаck — the second character is Cyrillic "а". Folding it would let
      // one name resolve to another holder's payment destination.
      expect(parseFederationName('jаck*useveilapp.xyz')).toBeNull()
    })
  })
})

describe('getNamesContractId', () => {
  const saved = { ...process.env }

  afterEach(() => {
    process.env = { ...saved }
  })

  it('falls back to the deployed mainnet registry with nothing configured', () => {
    // Written when this returned null, because no registry existed. One does
    // now, its address is baked in like the factory's, and the server answers
    // for mainnet unless told otherwise — so a fresh deployment resolves names
    // with no configuration at all.
    delete process.env.NEXT_PUBLIC_NAMES_CONTRACT_ID
    delete process.env.NEXT_PUBLIC_NAMES_CONTRACT_ID_MAINNET
    delete process.env.NEXT_PUBLIC_NAMES_CONTRACT_ID_TESTNET
    expect(getNamesContractId()).toBe('CA7BWBV2L67YVIZWJKLYT3RRCTFCZPN6L5SXYQ4YELWP56E34JFNOEP4')
  })

  it('treats a blank value as unset rather than as a contract id', () => {
    // Blank must not be mistaken for an address; it falls through to the
    // default rather than being used as one.
    process.env.NEXT_PUBLIC_NAMES_CONTRACT_ID = '   '
    expect(getNamesContractId()).not.toBe('   ')
    expect(getNamesContractId()).toBe('CA7BWBV2L67YVIZWJKLYT3RRCTFCZPN6L5SXYQ4YELWP56E34JFNOEP4')
  })

  it('reads the shared variable when no per-network one is set', () => {
    delete process.env.NEXT_PUBLIC_NAMES_CONTRACT_ID_MAINNET
    delete process.env.NEXT_PUBLIC_NAMES_CONTRACT_ID_TESTNET
    process.env.NEXT_PUBLIC_NAMES_CONTRACT_ID = 'CSHARED'
    expect(getNamesContractId()).toBe('CSHARED')
  })
})

describe('lookupFederationName', () => {
  it('returns the record a wallet needs, with the canonical address echoed back', async () => {
    const record = await lookupFederationName('Adebayo*UseVeilApp.xyz', async () => 'CWALLET123')

    expect(record).toEqual({
      // Echoed normalized, so a caller that uppercased the query still gets
      // the form the registry holds.
      stellar_address: 'adebayo*useveilapp.xyz',
      account_id: 'CWALLET123',
    })
  })

  it('is null when the name is not registered', async () => {
    expect(await lookupFederationName('adebayo*useveilapp.xyz', async () => null)).toBeNull()
  })

  it('never calls the resolver for a query that is not ours', async () => {
    const resolver = jest.fn(async () => 'CWALLET123')

    expect(await lookupFederationName('adebayo*lobstr.co', resolver)).toBeNull()
    expect(await lookupFederationName('ab*useveilapp.xyz', resolver)).toBeNull()
    expect(await lookupFederationName('not-a-federated-address', resolver)).toBeNull()

    // An RPC round trip for something the registry could never hold is pure
    // latency, and on mainnet it is a metered QuickNode call.
    expect(resolver).not.toHaveBeenCalled()
  })

  it('passes the bare name to the resolver, not the full address', async () => {
    const resolver = jest.fn(async () => 'CWALLET123')
    await lookupFederationName('adebayo*useveilapp.xyz', resolver)

    expect(resolver).toHaveBeenCalledWith('adebayo')
  })

  it('treats an empty resolver answer as unregistered, not as an address', async () => {
    expect(await lookupFederationName('adebayo*useveilapp.xyz', async () => '')).toBeNull()
  })
})

describe('which network the federation server answers for', () => {
  // Read at runtime, never NEXT_PUBLIC_*: those are inlined at build time, so
  // a repository .env.local was baked into the server bundle and pinned this
  // route to testnet regardless of how the deployment was configured.
  const saved = { ...process.env }
  afterEach(() => {
    process.env = { ...saved }
    jest.resetModules()
  })

  async function contractIdWith(network: string | undefined) {
    jest.resetModules()
    if (network === undefined) delete process.env.VEIL_FEDERATION_NETWORK
    else process.env.VEIL_FEDERATION_NETWORK = network
    delete process.env.NEXT_PUBLIC_NAMES_CONTRACT_ID
    delete process.env.NEXT_PUBLIC_NAMES_CONTRACT_ID_MAINNET
    delete process.env.NEXT_PUBLIC_NAMES_CONTRACT_ID_TESTNET
    const mod = await import('../federationServer')
    return mod.getNamesContractId()
  }

  it('answers for mainnet when nothing says otherwise', async () => {
    // The browser defaults to testnet because a person may have switched
    // networks, and that choice lives in localStorage. A federation server has
    // neither. Defaulting to testnet made every lookup 404 against a registry
    // that does not exist there — including names just bought on mainnet.
    const { MAINNET_NAMES_CONTRACT_ID } = await import('../namesContractId')
    expect(await contractIdWith(undefined)).toBe(MAINNET_NAMES_CONTRACT_ID)
  })

  it('answers for mainnet when explicitly set to mainnet', async () => {
    const { MAINNET_NAMES_CONTRACT_ID } = await import('../namesContractId')
    expect(await contractIdWith('mainnet')).toBe(MAINNET_NAMES_CONTRACT_ID)
  })

  it('only drops to testnet when explicitly told to', async () => {
    expect(await contractIdWith('testnet')).toBeNull()
  })
})
