import { ASSET_REGISTRY } from '../assets'
import {
  PROHIBITED_ADVICE_WORDS,
  buildBondExplainer,
  explainerText,
  isSovereignDebt,
} from '../bondExplainer'

const ETHERFUSE = 'GCRYUGD5NVARGXT56XEZI5CIFCQETYHAPQQTHO2O3IQZTHDH4LATMYWC'

const SOVEREIGNS: Array<[string, string]> = [
  ['CETES', 'Government of Mexico'],
  ['USTRY', 'United States Government'],
  ['TESOURO', 'Government of Brazil'],
]

/** What etherfuse.com's stellar.toml publishes for one of these codes. */
function tomlMeta(code: string, anchorAsset: string) {
  return {
    description: `${code} issuer-written description.`,
    imageUrl: 'data:image/png;base64,AAAA',
    anchorAsset,
    anchorAssetType: 'bond',
  }
}

describe('bond explainer is built from the registry and the issuer TOML (#1060)', () => {
  it('pins all six bonds to the one Etherfuse issuer, with the government as obligor', () => {
    for (const code of ['CETES', 'USTRY', 'TESOURO', 'KTB', 'EUROB', 'GILTS']) {
      const asset = ASSET_REGISTRY[code]
      expect(asset).toBeDefined()
      expect(asset.issuer).toBe(ETHERFUSE)
      expect(asset.issuerName).toBe('Etherfuse')
      expect(asset.homeDomain).toBe('etherfuse.com')
      expect(asset.obligor).toBeTruthy()
      expect(isSovereignDebt(asset)).toBe(true)
    }
  })

  it.each(SOVEREIGNS)('names the issuing government and the token issuer for %s', (code, government) => {
    const asset = ASSET_REGISTRY[code]
    const explainer = buildBondExplainer(asset, tomlMeta(code, 'Sovereign Bonds'))

    expect(explainer.obligor).toBe(government)
    expect(explainer.issuerName).toBe('Etherfuse')
    expect(explainer.issuerAddress).toBe(ETHERFUSE)
    expect(explainer.whatItIs).toContain(government)
    expect(explainer.whoIssuesIt).toContain('Etherfuse')
    expect(explainer.whoIssuesIt).toContain(government)
    // The token issuer and the debtor are presented as two different parties.
    expect(explainer.whoIssuesIt).toContain('two different parties')
  })

  it('states the price moves rather than paying out, without a yield figure', () => {
    const explainer = buildBondExplainer(ASSET_REGISTRY.CETES, tomlMeta('CETES', 'Mexican CETES Bonds'))
    expect(explainer.howThePriceWorks.toLowerCase()).toContain('price moves')
    expect(explainer.howThePriceWorks.toLowerCase()).toContain('does not pay out')
    expect(explainer.howThePriceWorks.toLowerCase()).not.toMatch(/\d+(\.\d+)?\s*%/)
  })

  it('says Veil is not the counterparty', () => {
    const explainer = buildBondExplainer(ASSET_REGISTRY.USTRY, tomlMeta('USTRY', 'US Treasury Notes'))
    expect(explainer.veilsRole.toLowerCase()).toContain('not the counterparty')
    expect(explainer.veilsRole.toLowerCase()).toContain('does not issue this token')
  })

  it('contains no promise, projection or advice language', () => {
    for (const [code, government] of SOVEREIGNS) {
      const text = explainerText(
        buildBondExplainer(ASSET_REGISTRY[code], tomlMeta(code, `${government} bonds`)),
      ).toLowerCase()
      for (const word of PROHIBITED_ADVICE_WORDS) {
        expect(new RegExp(`\\b${word}\\b`).test(text)).toBe(false)
      }
      // Guard the yield/projection wording the issue names explicitly. "not a
      // forecast" is allowed; a bare projection claim is not.
      for (const banned of ['yield', 'will rise', 'advise you', 'recommend', 'guaranteed']) {
        expect(text).not.toContain(banned)
      }
    }
  })

  it('renders a complete screen when the TOML is missing or unreachable', () => {
    const explainer = buildBondExplainer(ASSET_REGISTRY.TESOURO, null)
    expect(explainer.obligor).toBe('Government of Brazil')
    expect(explainer.issuerName).toBe('Etherfuse')
    expect(explainer.issuerAddress).toBe(ETHERFUSE)
    expect(explainer.backingAsset).toBeNull()
    expect(explainer.issuerMetadataAvailable).toBe(false)
    expect(explainer.whatItIs).toContain('Government of Brazil')
    expect(explainer.whatItIs.toLowerCase()).toContain('could not be read')
    // Still no advice in the offline fallback.
    const text = explainerText(explainer).toLowerCase()
    for (const word of PROHIBITED_ADVICE_WORDS) {
      expect(new RegExp(`\\b${word}\\b`).test(text)).toBe(false)
    }
  })

  it('uses the issuer TOML for backing text rather than any per-asset prose', () => {
    const asset = ASSET_REGISTRY.CETES
    const withToml = buildBondExplainer(asset, tomlMeta('CETES', 'Mexican CETES Bonds'))
    const withOther = buildBondExplainer(asset, tomlMeta('CETES', 'Something Else Entirely'))

    expect(withToml.backingAsset).toBe('Mexican CETES Bonds')
    expect(withToml.whatItIs).toContain('Mexican CETES Bonds')
    expect(withOther.whatItIs).toContain('Something Else Entirely')
    // The only thing that changed was the TOML value, not the template.
    expect(withToml.whatItIs.replace('Mexican CETES Bonds', 'Something Else Entirely')).toBe(
      withOther.whatItIs,
    )
  })
})
