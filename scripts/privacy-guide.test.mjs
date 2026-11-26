import { readFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'

let failed = false

function assert(condition, message) {
  if (!condition) {
    console.error(`  FAIL: ${message}`)
    failed = true
  } else {
    console.log(`  PASS: ${message}`)
  }
}

console.log('======================================================================')
console.log('  Testing User Guide: What "Private" Means in Veil (#728 / V149)')
console.log('======================================================================\n')

const root = process.cwd()

// 1. Check frontend/docs/pages/privacy.mdx
const docsPath = join(root, 'frontend', 'docs', 'pages', 'privacy.mdx')
assert(existsSync(docsPath), 'frontend/docs/pages/privacy.mdx exists')

if (existsSync(docsPath)) {
  const content = readFileSync(docsPath, 'utf8')
  
  assert(content.includes('What "Private" Means in Veil'), 'Title explains privacy in plain language')
  assert(content.includes('Stellar Private Payments') || content.includes('SPP'), 'Mentions Stellar Private Payments (SPP)')
  assert(content.toLowerCase().includes('hidden'), 'Explains what is hidden inside the pool')
  assert(content.toLowerCase().includes('public'), 'Explains what is public on-chain')
  assert(content.toLowerCase().includes('shield') && content.toLowerCase().includes('unshield'), 'Explains shield (deposit) and unshield (withdrawal)')
  assert(content.toLowerCase().includes('selective disclosure'), 'Explains selective disclosure proof mechanism')
  assert(content.toLowerCase().includes('freeze') || content.toLowerCase().includes('frozen'), 'Explains pool operator ability to freeze listed keys')
  assert(content.toLowerCase().includes('block-list') || content.toLowerCase().includes('allow-list'), 'Explains compliance allow-lists and block-lists')
  assert(content.toLowerCase().includes('testnet'), 'Explicitly notes testnet developer preview / no overclaiming')
}

// 2. Check frontend/docs/pages/_meta.ts
const metaPath = join(root, 'frontend', 'docs', 'pages', '_meta.ts')
assert(existsSync(metaPath), 'frontend/docs/pages/_meta.ts exists')
if (existsSync(metaPath)) {
  const metaContent = readFileSync(metaPath, 'utf8')
  assert(metaContent.includes('privacy:'), 'Navigation entry for privacy exists in _meta.ts')
}

// 3. Check sitemap.xml
const sitemapPath = join(root, 'frontend', 'docs', 'public', 'sitemap.xml')
assert(existsSync(sitemapPath), 'public/sitemap.xml exists')
if (existsSync(sitemapPath)) {
  const sitemapContent = readFileSync(sitemapPath, 'utf8')
  assert(sitemapContent.includes('https://docs.useveilapp.xyz/privacy'), 'Sitemap includes /privacy URL')
}

// 4. Check in-app components & links in Web Wallet
const webModalPath = join(root, 'frontend', 'wallet', 'components', 'PrivacyExplainerModal.tsx')
const webCardPath = join(root, 'frontend', 'wallet', 'components', 'PrivateBalanceCard.tsx')
assert(existsSync(webModalPath), 'PrivacyExplainerModal.tsx exists in web wallet')
assert(existsSync(webCardPath), 'PrivateBalanceCard.tsx exists in web wallet')

if (existsSync(webModalPath)) {
  const modalContent = readFileSync(webModalPath, 'utf8')
  assert(modalContent.includes('https://docs.useveilapp.xyz/privacy'), 'PrivacyExplainerModal links to full docs guide')
}

if (existsSync(webCardPath)) {
  const cardContent = readFileSync(webCardPath, 'utf8')
  assert(cardContent.includes('PrivacyExplainerModal'), 'PrivateBalanceCard triggers privacy explainer')
}

// 5. Check Mobile Wallet links & components
const mobileAboutPath = join(root, 'frontend', 'mobile', 'lib', 'about.ts')
const mobileCardPath = join(root, 'frontend', 'mobile', 'components', 'PrivateBalanceCard.tsx')
assert(existsSync(mobileAboutPath), 'about.ts exists in mobile wallet')
assert(existsSync(mobileCardPath), 'PrivateBalanceCard.tsx exists in mobile wallet')

if (existsSync(mobileAboutPath)) {
  const aboutContent = readFileSync(mobileAboutPath, 'utf8')
  assert(aboutContent.includes('https://docs.useveilapp.xyz/privacy'), 'Mobile about.ts EXTERNAL_LINKS includes privacy guide')
}

if (existsSync(mobileCardPath)) {
  const mCardContent = readFileSync(mobileCardPath, 'utf8')
  assert(mCardContent.includes('https://docs.useveilapp.xyz/privacy'), 'Mobile PrivateBalanceCard links to privacy guide')
}

console.log('\n======================================================================')
if (failed) {
  console.error('  [FAIL] One or more privacy guide verification tests failed!')
  process.exit(1)
} else {
  console.log('  [PASS] All privacy guide verification tests passed successfully!')
  process.exit(0)
}
