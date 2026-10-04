/**
 * scripts/test-usdy-explainer.mjs
 *
 * Verifies USDY asset metadata, disclosures, risk statements, and ensures
 * strict absence of advice-like / promotional vocabulary across all copy.
 */

import assert from 'assert'
import fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)

const usdyFilePath = path.resolve(__dirname, '../frontend/wallet/lib/usdy.ts')
const usdyPagePath = path.resolve(__dirname, '../frontend/wallet/app/assets/usdy/page.tsx')
const usdyMobilePath = path.resolve(__dirname, '../frontend/mobile/app/token/usdy.tsx')
const walletAssetsPath = path.resolve(__dirname, '../frontend/wallet/lib/assets.ts')
const mobileAssetsPath = path.resolve(__dirname, '../frontend/mobile/lib/assets.ts')

console.log('Testing USDY Asset Explainer & Advice-Word Linter...')

assert(fs.existsSync(usdyFilePath), `Missing ${usdyFilePath}`)
assert(fs.existsSync(usdyPagePath), `Missing ${usdyPagePath}`)
assert(fs.existsSync(usdyMobilePath), `Missing ${usdyMobilePath}`)

const usdyContent = fs.readFileSync(usdyFilePath, 'utf-8')
const usdyPageContent = fs.readFileSync(usdyPagePath, 'utf-8')
const usdyMobileContent = fs.readFileSync(usdyMobilePath, 'utf-8')
const walletAssetsContent = fs.readFileSync(walletAssetsPath, 'utf-8')
const mobileAssetsContent = fs.readFileSync(mobileAssetsPath, 'utf-8')

// 1. Check Issuer and Disclosures
// The issuer is defined once per app, in lib/assets.ts, and referenced by name
// everywhere else. Asserting the literal here would have made this script the
// fourth copy of it — which is the thing the rule exists to prevent.
const USDY_ISSUER = 'GAJMPX5NBOG6TQFPQGRABJEEB2YE7RFRLUKJDZAZGAD5GFX4J7TADAZ6'
assert(walletAssetsContent.includes(`export const USDY_MAINNET_ISSUER = '${USDY_ISSUER}'`), 'wallet lib/assets.ts must define USDY_MAINNET_ISSUER as the registered issuer')
assert(mobileAssetsContent.includes(`export const USDY_MAINNET_ISSUER = '${USDY_ISSUER}'`), 'mobile lib/assets.ts must define USDY_MAINNET_ISSUER as the registered issuer')
assert(usdyContent.includes('USDY_MAINNET_ISSUER'), 'wallet explainer must reference the shared issuer constant, not a literal')
assert(usdyMobileContent.includes('USDY_MAINNET_ISSUER'), 'mobile explainer must reference the shared issuer constant, not a literal')
assert(!usdyContent.includes(USDY_ISSUER), 'wallet explainer must not hardcode the issuer address')
assert(!usdyMobileContent.includes(USDY_ISSUER), 'mobile explainer must not hardcode the issuer address')
assert(usdyContent.includes('ondo.finance'), 'Must contain homeDomain ondo.finance')
assert(usdyContent.includes('https://ondo.finance/usdy'), 'Must link to official disclosures')
// Ondo publishes no prospectus; their stellar.toml declares a redemption route.
assert(usdyContent.includes('https://app.ondo.finance/assets/usdy'), 'Must link to the issuer-declared redemption route')

// 2. Check Explanations
assert(usdyContent.includes('US Treasury bills and bank demand deposits'), 'Must state asset backing')
assert(usdyContent.includes('does not pay out separate periodic cash distributions'), 'Must clarify no separate payout distributions')
assert(usdyContent.includes('price per token adjusts upward over time as interest'), 'Must explain price-based value accrual')

// 3. Check Risk Categories
const requiredRisks = [
  'Issuer & Custodian Risk',
  'Secondary Market Liquidity',
  'Price Fluctuations & Loss',
  'Not Insured / Not a Bank Account',
]
for (const risk of requiredRisks) {
  assert(usdyContent.includes(risk), `Must contain risk category: "${risk}"`)
}

// 4. Check Prohibited Advice Words in User-Facing Text
const PROHIBITED_WORDS = [
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

// Extract user-facing string literals from USDY_EXPLAINER content
const userFacingTexts = [
  usdyContent.match(/whatItIs:\s*[\s\S]*?howValueAccrues/)?.[0] || '',
  usdyContent.match(/howValueAccrues:\s*[\s\S]*?backedBy/)?.[0] || '',
  usdyContent.match(/backedBy:\s*[\s\S]*?risks/)?.[0] || '',
  usdyContent.match(/risks:\s*\[[\s\S]*?\]/)?.[0] || '',
  usdyContent.match(/importantNotices:\s*\[[\s\S]*?\]/)?.[0] || '',
  usdyPageContent.match(/<main[\s\S]*?<\/main>/)?.[0] || '',
  usdyMobileContent.match(/<ScrollView[\s\S]*?<\/ScrollView>/)?.[0] || '',
]

for (const section of userFacingTexts) {
  for (const word of PROHIBITED_WORDS) {
    const regex = new RegExp(`\\b${word}\\b`, 'i')
    const lines = section.split('\n')
    for (const line of lines) {
      if (line.includes('router.back()') || line.includes('Return to')) continue
      if (regex.test(line)) {
        throw new Error(`Prohibited advice-like word "${word}" found in user-facing copy: ${line.trim()}`)
      }
    }
  }
}

console.log('✓ All USDY explainer assertions and advice-word linter checks passed!')
