import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const repoRoot = join(root, '../..');

function assert(condition, message) {
  if (!condition) {
    console.error(`❌ Assertion failed: ${message}`);
    process.exit(1);
  }
}

console.log('Verifying invest rail documentation and disclosures...');

// 1. Check pages/invest.mdx existence and content
const investPagePath = join(root, 'pages/invest.mdx');
assert(existsSync(investPagePath), 'pages/invest.mdx must exist');

const investContent = readFileSync(investPagePath, 'utf8');

// Acceptance Criteria 1: The page states plainly that Veil does not take custody, does not perform KYC and does not advise
assert(
  /does not take custody/i.test(investContent),
  'invest.mdx must plainly state that Veil does not take custody'
);
assert(
  /does not perform kyc/i.test(investContent),
  'invest.mdx must plainly state that Veil does not perform KYC'
);
assert(
  /does not advise/i.test(investContent),
  'invest.mdx must plainly state that Veil does not advise'
);

// Acceptance Criteria 2: Issuer risk and liquidity risk described in plain language
assert(
  /issuer risk/i.test(investContent) || /what happens if the issuer fails/i.test(investContent),
  'invest.mdx must describe issuer risk'
);
assert(
  /liquidity/i.test(investContent) && (/spread/i.test(investContent) || /slippage/i.test(investContent)),
  'invest.mdx must describe liquidity risk in plain language'
);
assert(
  /FDIC/i.test(investContent) && /SIPC/i.test(investContent),
  'invest.mdx must mention lack of FDIC and SIPC insurance'
);

// Acceptance Criteria 3: Where assets are not offered
assert(
  /where assets are not offered/i.test(investContent) || /restricted/i.test(investContent),
  'invest.mdx must specify where assets are not offered'
);
assert(
  /Regulation S/i.test(investContent) || /US person/i.test(investContent),
  'invest.mdx must address US Person restrictions (Reg S)'
);

// 2. Check navigation in _meta.ts
const metaPath = join(root, 'pages/_meta.ts');
const metaContent = readFileSync(metaPath, 'utf8');
assert(metaContent.includes('invest:'), '_meta.ts must include the invest page');

// 3. Check sitemap contains /invest
const sitemapPath = join(root, 'public/sitemap.xml');
assert(existsSync(sitemapPath), 'public/sitemap.xml must exist');
const sitemapContent = readFileSync(sitemapPath, 'utf8');
assert(
  sitemapContent.includes('https://docs.useveilapp.xyz/invest'),
  'sitemap.xml must contain https://docs.useveilapp.xyz/invest'
);

// 4. Check links from the apps
const walletEarnPath = join(repoRoot, 'frontend/wallet/app/earn/page.tsx');
assert(existsSync(walletEarnPath), 'frontend/wallet/app/earn/page.tsx must exist');
const walletEarnContent = readFileSync(walletEarnPath, 'utf8');
assert(
  walletEarnContent.includes('https://docs.useveilapp.xyz/invest'),
  'Wallet earn page must link to https://docs.useveilapp.xyz/invest'
);

const mobileEarnPath = join(repoRoot, 'frontend/mobile/app/(tabs)/earn.tsx');
assert(existsSync(mobileEarnPath), 'frontend/mobile/app/(tabs)/earn.tsx must exist');
const mobileEarnContent = readFileSync(mobileEarnPath, 'utf8');
assert(
  mobileEarnContent.includes('https://docs.useveilapp.xyz/invest'),
  'Mobile earn page must link to https://docs.useveilapp.xyz/invest'
);

const mobileAboutPath = join(repoRoot, 'frontend/mobile/lib/about.ts');
assert(existsSync(mobileAboutPath), 'frontend/mobile/lib/about.ts must exist');
const mobileAboutContent = readFileSync(mobileAboutPath, 'utf8');
assert(
  mobileAboutContent.includes('https://docs.useveilapp.xyz/invest'),
  'Mobile about.ts must link to https://docs.useveilapp.xyz/invest'
);

console.log('✅ All invest rail documentation and disclosure assertions passed!');
