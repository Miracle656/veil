// @stellar/stellar-sdk needs TextEncoder at module load; jsdom omits it.
import { TextEncoder, TextDecoder } from 'util'
Object.assign(globalThis, { TextEncoder, TextDecoder })

import { Asset, Networks } from '@stellar/stellar-sdk'
import {
  ASSET_REGISTRY,
  USDT0_MAINNET_ISSUER,
  USDT0_MAINNET_SAC,
  formatAssetLabel,
  getAssetIssuer,
  getRegisteredAsset,
  isRegisteredIssuer,
  getAssetControlDisclosure,
  fetchAssetDisclosure,
  fetchIssuerFlags,
  DISCLOSURE_UNAVAILABLE,
} from '../assets'

describe('Verified Asset Registry', () => {
  const LOOKALIKE_ISSUER = 'GFAKE123456789012345678901234567890123456789012345678901'

  it('includes exact registry entries for USDC, XLM, EURC, AQUA, USDY, and USDT0', () => {
    expect(ASSET_REGISTRY.USDC).toBeDefined()
    expect(ASSET_REGISTRY.XLM).toBeDefined()
    expect(ASSET_REGISTRY.EURC).toBeDefined()
    expect(ASSET_REGISTRY.AQUA).toBeDefined()
    expect(ASSET_REGISTRY.USDY).toBeDefined()
    expect(ASSET_REGISTRY.USDT0).toBeDefined()
  })

  it('resolves XLM correctly without an issuer field', () => {
    const xlmAsset = getRegisteredAsset('XLM')
    expect(xlmAsset).not.toBeNull()
    expect(xlmAsset?.code).toBe('XLM')
    expect(xlmAsset?.issuer).toBe('')

    expect(getRegisteredAsset('XLM', '')).toEqual(xlmAsset)
    expect(getRegisteredAsset('XLM', null)).toEqual(xlmAsset)
    expect(formatAssetLabel('XLM')).toBe('XLM')
    expect(formatAssetLabel('XLM', '')).toBe('XLM')
  })

  it('labels lookalike issuers (different G... address, same code) as unverified', () => {
    const usdyLookalike = getRegisteredAsset('USDY', LOOKALIKE_ISSUER)
    expect(usdyLookalike).toBeNull()

    const formattedLabel = formatAssetLabel('USDY', LOOKALIKE_ISSUER)
    expect(formattedLabel).toBe('Unverified: USDY (issuer GFAK…)')

    const isRegistered = isRegisteredIssuer('USDY', LOOKALIKE_ISSUER)
    expect(isRegistered).toBe(false)
  })

  it('labels lookalike EURC issuers as unverified', () => {
    const eurcLookalike = getRegisteredAsset('EURC', LOOKALIKE_ISSUER)
    expect(eurcLookalike).toBeNull()
    expect(formatAssetLabel('EURC', LOOKALIKE_ISSUER)).toBe('Unverified: EURC (issuer GFAK…)')
  })

  it('resolves legitimate assets when exact code and issuer match', () => {
    const usdyIssuer = ASSET_REGISTRY.USDY.issuer
    expect(getRegisteredAsset('USDY', usdyIssuer)).not.toBeNull()
    expect(formatAssetLabel('USDY', usdyIssuer)).toBe('USDY')
    expect(isRegisteredIssuer('USDY', usdyIssuer)).toBe(true)
  })

  it('returns appropriate issuer per network', () => {
    expect(getAssetIssuer('USDC', 'mainnet')).toBe(ASSET_REGISTRY.USDC.issuer)
    expect(getAssetIssuer('USDC', 'testnet')).toBe('GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5')
  })
})

describe('Verified Asset Registry - USDT0 (Issue #787)', () => {
  it('USDT0 resolves to exactly the pinned issuer on mainnet', () => {
    const asset = getRegisteredAsset('USDT0')
    expect(asset).not.toBeNull()
    expect(asset?.code).toBe('USDT0')
    expect(asset?.issuer).toBe(USDT0_MAINNET_ISSUER)
    expect(asset?.issuer).toBe('GATISXX6BZ6NC7IKQBY37CJD4SOZL3CYZJWXEDG6JVIY4WBS6KXJHN6Q')
    expect(asset?.network).toBe('mainnet')
    expect(asset?.kind).toBe('stablecoin')
    expect(asset?.homeDomain).toBeUndefined()
  })

  it('derives the SAC contract ID dynamically from issuer and asserts equality with stored value', () => {
    const derivedContractId = new Asset('USDT0', USDT0_MAINNET_ISSUER).contractId(Networks.PUBLIC)
    expect(derivedContractId).toBe(USDT0_MAINNET_SAC)
    expect(derivedContractId).toBe('CBSJZEIO5C7KC2SF3MKSNXXJSW5G3VTNBX4ATMKUI3B2MR4JKM4R26YF')
    expect(ASSET_REGISTRY.USDT0.sacContractId).toBe(derivedContractId)
  })

  it('does not offer USDT0 on testnet', () => {
    expect(getRegisteredAsset('USDT0', 'testnet')).toBeNull()
    expect(getAssetIssuer('USDT0', 'testnet')).toBeNull()
    expect(isRegisteredIssuer('USDT0', USDT0_MAINNET_ISSUER, 'testnet')).toBe(false)
  })

  it('offers USDT0 on mainnet', () => {
    expect(getRegisteredAsset('USDT0', 'mainnet')?.issuer).toBe(USDT0_MAINNET_ISSUER)
    expect(getAssetIssuer('USDT0', 'mainnet')).toBe(USDT0_MAINNET_ISSUER)
    expect(isRegisteredIssuer('USDT0', USDT0_MAINNET_ISSUER, 'mainnet')).toBe(true)
  })

  it('rejects trustlines with code USDT0 and any impostor issuer', () => {
    const IMPOSTOR_ISSUERS = [
      'GC35JBERU4SFTDVOF32A2SIJN5FHSLSZFZSGP6VVFWCZNDVGJFLQBANK',
      'GADUBOKGYG4E2BZUVXAZBBILGPIYIPOXAXWIIG6DJ4JDXWOQR67HUSDT',
      'GBL35PWBKAHURS7SMATHXTS5X57BHC23P2B6MOJTDXTDKD7K25QHUSDT',
      'GAKSY7RQI4YG3H5J5WRYHB4FDEJ2PAQJ6IN3P47HNG6KGUJJ2YOD7ZP3',
      'GA7GNGYVJHF7LTI6OO4FAD2JEQBIQWRBIZOLEZSJJHMNAY6UUZERU526',
      'GAVRQZHG726XIHZKP3MODI3DOUP7IIQ6CC6OJX4JJD7PXRV4FJ3WE77O',
      'GDBDGR2U3KVHUGJ5SVALIAPT7FBPSYWD25XTF4JPHTPBKFH2SHOOHZFF',
    ]

    for (const impostor of IMPOSTOR_ISSUERS) {
      expect(isRegisteredIssuer('USDT0', impostor, 'mainnet')).toBe(false)
    }
  })
})

describe('USDT0 Freeze and Clawback Disclosure (Issue #789)', () => {
  it('renders disclosure when both revocable and clawback are enabled', () => {
    const disclosure = getAssetControlDisclosure({
      auth_revocable: true,
      auth_clawback_enabled: true,
    })
    expect(disclosure).toBe(
      'The issuer can freeze this balance or take it back, and this is a property of the asset, not of Veil.',
    )
  })

  it('renders clawback-only disclosure', () => {
    const disclosure = getAssetControlDisclosure({
      auth_clawback_enabled: true,
      auth_revocable: false,
    })
    expect(disclosure).toBe(
      'The issuer can take this balance back, and this is a property of the asset, not of Veil.',
    )
  })

  it('renders revocable-only disclosure', () => {
    const disclosure = getAssetControlDisclosure({
      auth_revocable: true,
      auth_clawback_enabled: false,
    })
    expect(disclosure).toBe(
      'The issuer can freeze this balance, and this is a property of the asset, not of Veil.',
    )
  })

  it('returns null when neither flag is set', () => {
    expect(getAssetControlDisclosure({ auth_revocable: false, auth_clawback_enabled: false })).toBeNull()
    expect(getAssetControlDisclosure({})).toBeNull()
    expect(getAssetControlDisclosure(null)).toBeNull()
    expect(getAssetControlDisclosure(undefined)).toBeNull()
  })

  it('dynamically fetches flags from Horizon issuer account', async () => {
    const mockServer = {
      loadAccount: jest.fn(async (id: string) => {
        if (id === USDT0_MAINNET_ISSUER) {
          return {
            flags: {
              auth_required: false,
              auth_revocable: true,
              auth_clawback_enabled: true,
            },
          }
        }
        return {
          flags: {
            auth_required: false,
            auth_revocable: false,
            auth_clawback_enabled: false,
          },
        }
      }),
    }

    const usdt0Disc = await fetchAssetDisclosure(mockServer, USDT0_MAINNET_ISSUER)
    expect(usdt0Disc).toBe(
      'The issuer can freeze this balance or take it back, and this is a property of the asset, not of Veil.',
    )
    expect(mockServer.loadAccount).toHaveBeenCalledWith(USDT0_MAINNET_ISSUER)

    const realImpostor = 'GC35JBERU4SFTDVOF32A2SIJN5FHSLSZFZSGP6VVFWCZNDVGJFLQBANK'
    const impostorDisc = await fetchAssetDisclosure(mockServer, realImpostor)
    expect(impostorDisc).toBeNull()
  })

  it('does not fail open when the issuer account cannot be read', async () => {
    const deadServer = {
      loadAccount: jest.fn(async () => {
        throw new Error('Request failed with status code 429')
      }),
    }

    await expect(fetchAssetDisclosure(deadServer, USDT0_MAINNET_ISSUER)).resolves.toBe(
      DISCLOSURE_UNAVAILABLE,
    )
    await expect(fetchIssuerFlags(deadServer, USDT0_MAINNET_ISSUER)).resolves.toBeNull()
  })
})

