/**
 * USDY (Ondo US Dollar Yield) asset metadata and plain-language educational definitions.
 *
 * Ground rules (from issue #733 and V180):
 * - Names the issuer (Ondo Finance / Ondo USDY LLC) and links to their own disclosures.
 * - Explains what it is (short-term US Treasuries and bank deposits).
 * - Explains how value accrues (price per token increases as interest accrues; no separate payouts).
 * - Clearly lists risks (issuer risk, thin secondary liquidity, price can fall, not insured / not a bank deposit).
 * - Risks must be reviewed before any buy/swap action.
 * - STRICTLY avoids advice-like language ("returns", "profit", "guaranteed", "earnings", "risk-free", "promised", etc.).
 */

export interface UsdyRiskItem {
  id: string
  title: string
  description: string
}

export interface UsdyExplainerContent {
  code: string
  name: string
  issuerName: string
  issuerAddress: string
  homeDomain: string
  disclosuresUrl: string
  prospectusUrl: string
  whatItIs: string
  howValueAccrues: string
  backedBy: string
  risks: UsdyRiskItem[]
  importantNotices: string[]
}

export const USDY_EXPLAINER: UsdyExplainerContent = {
  code: 'USDY',
  name: 'Ondo US Dollar Yield',
  issuerName: 'Ondo Finance (Ondo USDY LLC)',
  issuerAddress: 'GAJMPX5NBOG6TQFPQGRABJEEB2YE7RFRLUKJDZAZGAD5GFX4J7TADAZ6',
  homeDomain: 'ondo.finance',
  disclosuresUrl: 'https://ondo.finance/usdy',
  prospectusUrl: 'https://ondo.finance/documents/usdy-prospectus',
  whatItIs:
    'USDY is a tokenized note backed by short-term US Treasury bills and bank demand deposits. It is issued on Stellar as an asset with open transferability (auth_required is false).',
  howValueAccrues:
    'The value per token adjusts upward over time as interest on the underlying US Treasury bills accrues. It does not pay out separate periodic cash distributions or balance increments; each token simply reflects a higher unit value over time.',
  backedBy:
    'Bankruptcy-remote SPV holding short-term US Treasuries and bank deposits, with third-party daily attestations.',
  risks: [
    {
      id: 'issuer-risk',
      title: 'Issuer & Custodian Risk',
      description:
        'USDY is an obligation of Ondo USDY LLC and relies on their custody arrangements. If the issuer or its banking partners experience insolvency or operational failure, token value may be impaired. It is not an obligation of the US Government.',
    },
    {
      id: 'liquidity-risk',
      title: 'Secondary Market Liquidity',
      description:
        'Liquidity on the Stellar decentralized exchange (DEX) may be thin. Converting USDY back to USDC or XLM may involve a wide bid-ask spread or slippage for larger transaction sizes.',
    },
    {
      id: 'price-fluctuation',
      title: 'Price Fluctuations & Loss',
      description:
        'The market price of USDY can fluctuate based on interest rate shifts, macroeconomic changes, or DEX order book depth. The price can fall, and buyers may experience losses upon sale.',
    },
    {
      id: 'not-insured',
      title: 'Not Insured / Not a Bank Account',
      description:
        'USDY is not a bank deposit, not a savings account, and is not insured by the FDIC, SIPC, or any governmental agency. It carries risk of principal loss.',
    },
  ],
  importantNotices: [
    'Veil does not take custody of your assets, does not provide investment advice, and is not a broker or dealer.',
    'You are interacting directly with the Stellar decentralized network and third-party issuer tokens.',
  ],
}

/** List of advice-like / prohibited promotional terms checked in tests */
export const PROHIBITED_ADVICE_WORDS = [
  'returns',
  'profit',
  'guaranteed',
  'earnings',
  'passive income',
  'risk-free',
  'promised',
  'safe investment',
  'annual return',
]
