import { USDY_EXPLAINER, PROHIBITED_ADVICE_WORDS } from '../usdy'

describe('USDY Explainer Content and Disclosures', () => {
  test('has accurate issuer and asset identification', () => {
    expect(USDY_EXPLAINER.code).toBe('USDY')
    expect(USDY_EXPLAINER.name).toBe('Ondo US Dollar Yield')
    expect(USDY_EXPLAINER.issuerName).toContain('Ondo')
    expect(USDY_EXPLAINER.issuerAddress).toBe(
      'GAJMPX5NBOG6TQFPQGRABJEEB2YE7RFRLUKJDZAZGAD5GFX4J7TADAZ6'
    )
    expect(USDY_EXPLAINER.homeDomain).toBe('ondo.finance')
  })

  test('includes valid https disclosure and prospectus links', () => {
    expect(USDY_EXPLAINER.disclosuresUrl).toMatch(/^https:\/\/ondo\.finance/)
    expect(USDY_EXPLAINER.prospectusUrl).toMatch(/^https:\/\/ondo\.finance/)
  })

  test('explains value accrual via price rather than separate payouts', () => {
    expect(USDY_EXPLAINER.howValueAccrues.toLowerCase()).toContain('price')
    expect(USDY_EXPLAINER.howValueAccrues.toLowerCase()).toContain('accrues')
    // Must explicitly note it does not pay separate distributions
    expect(USDY_EXPLAINER.howValueAccrues.toLowerCase()).toContain('does not pay')
  })

  test('lists all required risk categories', () => {
    const riskIds = USDY_EXPLAINER.risks.map((r) => r.id)
    expect(riskIds).toContain('issuer-risk')
    expect(riskIds).toContain('liquidity-risk')
    expect(riskIds).toContain('price-fluctuation')
    expect(riskIds).toContain('not-insured')

    const combinedRiskText = USDY_EXPLAINER.risks
      .map((r) => `${r.title} ${r.description}`)
      .join(' ')
      .toLowerCase()

    expect(combinedRiskText).toContain('not a bank deposit')
    expect(combinedRiskText).toContain('liquidity')
    expect(combinedRiskText).toContain('price can fall')
    expect(combinedRiskText).toContain('insolvency')
  })

  test('strictly avoids advice-like and promotional terminology', () => {
    const allText = [
      USDY_EXPLAINER.whatItIs,
      USDY_EXPLAINER.howValueAccrues,
      USDY_EXPLAINER.backedBy,
      ...USDY_EXPLAINER.risks.map((r) => `${r.title} ${r.description}`),
      ...USDY_EXPLAINER.importantNotices,
    ]
      .join(' ')
      .toLowerCase()

    for (const word of PROHIBITED_ADVICE_WORDS) {
      // Allow 'returns' only if part of 'does not guarantee returns' or similar negative context, but here we enforce complete absence
      const regex = new RegExp(`\\b${word}\\b`, 'i')
      expect(regex.test(allText)).toBe(false)
    }
  })
})
