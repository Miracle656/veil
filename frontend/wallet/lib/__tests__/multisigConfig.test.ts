/**
 * @jest-environment jsdom
 *
 * Per-network multisig deployment config (lib/multisigConfig.ts) — issue #672.
 *
 * The invariant under test: a multisig WASM hash is only meaningful on the
 * network the bytecode was installed on. Verified on-chain 2026-09-02 with
 * `getLedgerEntries` on the CONTRACT_CODE key for 7eb63568…:
 *
 *   testnet  INSTALLED      (lastModifiedLedgerSeq 2843166)
 *   mainnet  NOT INSTALLED  (two independent RPCs agree)
 *
 * So testnet must resolve a hash and mainnet must not, and `/multisig` must be
 * offered and reachable exactly where a hash resolves. Everything here takes
 * the network as an explicit argument — the same trick `walletStorage.test.ts`
 * uses with `namespaceKey` — so both networks are asserted in one process
 * without the page reload `setActiveNetwork` would otherwise require.
 */

import { webcrypto } from 'crypto'
import { TextEncoder, TextDecoder } from 'util'

// jsdom provides neither WebCrypto nor these encoders; @stellar/stellar-sdk —
// pulled in transitively by lib/network.ts — needs them at import time.
Object.defineProperty(globalThis, 'crypto', {
  value: webcrypto,
  configurable: true,
  writable: true,
})
Object.assign(globalThis, { TextEncoder, TextDecoder })

import { getNetworkName } from '../network'
import {
  MULTISIG_WASM_HASH_ENV_VAR,
  getMultisigDeployment,
  getMultisigWasmHash,
  isMultisigAvailable,
} from '../multisigConfig'

/** The hash the route shipped hardcoded, and the one actually on testnet. */
const INSTALLED_ON_TESTNET = '7eb63568a7a41c19f5d85c55b5ec88c6f95ef840bcf98d1797850ace2dd3cf24'
const OTHER_VALID_HASH = 'b485f817469402ba4ccc24ea30077308f69589cbe0897db49087b15f58659ea5'

const TESTNET_VAR = MULTISIG_WASM_HASH_ENV_VAR.testnet
const MAINNET_VAR = MULTISIG_WASM_HASH_ENV_VAR.mainnet

beforeEach(() => {
  delete process.env[TESTNET_VAR]
  delete process.env[MAINNET_VAR]
})

afterAll(() => {
  delete process.env[TESTNET_VAR]
  delete process.env[MAINNET_VAR]
})

describe('the hash is network-aware, not one constant for both chains', () => {
  it('resolves the verified hash on testnet with no configuration at all', () => {
    const deployment = getMultisigDeployment('testnet')
    expect(deployment.status).toBe('available')
    expect(deployment).toMatchObject({
      status: 'available',
      network: 'testnet',
      wasmHash: INSTALLED_ON_TESTNET,
      source: 'built-in',
    })
  })

  // The bug in #672: the same constant was applied to mainnet, where the
  // bytecode does not exist. There must be no built-in mainnet fallback.
  it('resolves nothing on mainnet, where the contract is not installed', () => {
    const deployment = getMultisigDeployment('mainnet')
    expect(deployment.status).toBe('unconfigured')
    expect(deployment.network).toBe('mainnet')
  })

  it('never reuses the testnet hash for mainnet', () => {
    process.env[TESTNET_VAR] = OTHER_VALID_HASH
    expect(getMultisigWasmHash('testnet')).toBe(OTHER_VALID_HASH)
    expect(getMultisigDeployment('mainnet').status).toBe('unconfigured')
  })

  it('lets each network be configured independently', () => {
    process.env[TESTNET_VAR] = INSTALLED_ON_TESTNET
    process.env[MAINNET_VAR] = OTHER_VALID_HASH
    expect(getMultisigWasmHash('testnet')).toBe(INSTALLED_ON_TESTNET)
    expect(getMultisigWasmHash('mainnet')).toBe(OTHER_VALID_HASH)
  })

  it('prefers an explicit env hash over the built-in testnet default', () => {
    process.env[TESTNET_VAR] = OTHER_VALID_HASH
    expect(getMultisigDeployment('testnet')).toMatchObject({
      status: 'available',
      wasmHash: OTHER_VALID_HASH,
      source: 'env',
    })
  })

  it('normalises an uppercase hash, since hex case is not part of the digest', () => {
    process.env[MAINNET_VAR] = OTHER_VALID_HASH.toUpperCase()
    expect(getMultisigWasmHash('mainnet')).toBe(OTHER_VALID_HASH)
  })

  it('ignores surrounding whitespace, which .env files pick up easily', () => {
    process.env[MAINNET_VAR] = `  ${OTHER_VALID_HASH}\t`
    expect(getMultisigWasmHash('mainnet')).toBe(OTHER_VALID_HASH)
  })
})

describe('missing or invalid configuration fails clearly', () => {
  it('throws on the unsupported network, naming the network and the variable', () => {
    expect(() => getMultisigWasmHash('mainnet')).toThrow(/Stellar Mainnet/)
    expect(() => getMultisigWasmHash('mainnet')).toThrow(MAINNET_VAR)
  })

  // An empty string is what an unset line in .env.example produces. It must
  // read as "not configured", not as a hash of length zero.
  it('treats a blank value as unconfigured rather than invalid', () => {
    process.env[MAINNET_VAR] = '   '
    expect(getMultisigDeployment('mainnet').status).toBe('unconfigured')
  })

  // A typo must not look like the deliberate mainnet gate — otherwise a broken
  // deployment silently loses the route instead of complaining.
  it.each([
    ['too short', 'deadbeef'],
    ['too long', `${OTHER_VALID_HASH}00`],
    ['not hex', 'z'.repeat(64)],
    ['0x-prefixed', `0x${OTHER_VALID_HASH}`],
    ['a contract id pasted by mistake', 'CAUK4MWO3TTFM6PLURSH2GPK3AB747SZGABKTCVLKCU7W2MGKHKP35GA'],
  ])('reports %s as invalid, distinctly from unconfigured', (_label, value) => {
    process.env[MAINNET_VAR] = value
    const deployment = getMultisigDeployment('mainnet')
    expect(deployment.status).toBe('invalid')
    expect(deployment.status === 'invalid' && deployment.reason).toContain(MAINNET_VAR)
  })

  it('throws with the variable name when the configured hash is malformed', () => {
    process.env[TESTNET_VAR] = 'not-a-hash'
    expect(() => getMultisigWasmHash('testnet')).toThrow(TESTNET_VAR)
  })

  // An invalid override must not silently fall back to the built-in default;
  // that would deploy bytecode the operator did not ask for.
  it('does not fall back to the built-in default when the override is invalid', () => {
    process.env[TESTNET_VAR] = 'nope'
    expect(() => getMultisigWasmHash('testnet')).toThrow()
    expect(getMultisigDeployment('testnet').status).toBe('invalid')
  })
})

describe('route reachability follows the deployment, on both networks', () => {
  it('offers /multisig on testnet', () => {
    expect(isMultisigAvailable('testnet')).toBe(true)
  })

  it('withholds /multisig on mainnet as shipped', () => {
    expect(isMultisigAvailable('mainnet')).toBe(false)
  })

  it('opens /multisig on mainnet once a real hash is configured there', () => {
    process.env[MAINNET_VAR] = OTHER_VALID_HASH
    expect(isMultisigAvailable('mainnet')).toBe(true)
  })

  // The gate and the nav entry both call this, so a misconfiguration must
  // close the route rather than leave a link into a page that cannot deploy.
  it('withholds the route when the configured hash is invalid', () => {
    process.env[MAINNET_VAR] = 'nope'
    expect(isMultisigAvailable('mainnet')).toBe(false)
  })

  // The gate decides reachability and the wizard decides the deploy; if they
  // could ever disagree, a user would reach a page that throws at signing.
  it.each(['testnet', 'mainnet'] as const)(
    'never allows the %s route without a resolvable hash, and never blocks it with one',
    (network) => {
      expect(isMultisigAvailable(network)).toBe(
        getMultisigDeployment(network).status === 'available',
      )
      if (isMultisigAvailable(network)) {
        expect(() => getMultisigWasmHash(network)).not.toThrow()
      } else {
        expect(() => getMultisigWasmHash(network)).toThrow()
      }
    },
  )
})

describe('the active network is the default argument', () => {
  // Asserted against getNetworkName() rather than a literal: lib/network.ts
  // resolves the active network once at import, so a run with
  // NEXT_PUBLIC_NETWORK=mainnet would fail a hardcoded expectation for a
  // reason that has nothing to do with what this test is pinning.
  it('falls back to the active network when none is passed', () => {
    const active = getNetworkName()
    expect(getMultisigDeployment().network).toBe(active)
    expect(isMultisigAvailable()).toBe(isMultisigAvailable(active))
  })

  // jsdom starts with an empty localStorage, so the active network is the
  // build default — testnet in every configuration the wallet ships with.
  it('serves the verified testnet hash to an unconfigured install', () => {
    if (getNetworkName() !== 'testnet') return
    expect(getMultisigWasmHash()).toBe(INSTALLED_ON_TESTNET)
  })
})
