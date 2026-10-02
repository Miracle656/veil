import {
  ANDROID_DOWNLOAD_URL,
  DOCS_URL,
  SAME_AS,
  SITE_NAME,
  SITE_URL,
  WALLET_URL,
} from '@/lib/site'

/**
 * Structured data: the machine-readable description search engines and AI
 * answer engines use to know what Veil *is*, rather than inferring it from
 * prose.
 *
 * Deliberately limited to types Google still uses. HowTo rich results were
 * retired in 2023, and FAQ rich results are now shown mostly for government and
 * health sites, so neither is emitted here even though older SEO checklists
 * still recommend them.
 */
function Script({ data }: { data: object }) {
  return (
    <script
      type="application/ld+json"
      // Static, build-time data defined in this file — never user input.
      dangerouslySetInnerHTML={{ __html: JSON.stringify(data) }}
    />
  )
}

const organization = {
  '@type': 'Organization',
  '@id': `${SITE_URL}/#organization`,
  name: SITE_NAME,
  url: SITE_URL,
  logo: `${SITE_URL}/icon.svg`,
  sameAs: SAME_AS,
}

/** Homepage: who Veil is, and the site itself. */
export function SiteJsonLd() {
  return (
    <Script
      data={{
        '@context': 'https://schema.org',
        '@graph': [
          organization,
          {
            '@type': 'WebSite',
            '@id': `${SITE_URL}/#website`,
            url: SITE_URL,
            name: SITE_NAME,
            description:
              'A passkey-powered smart wallet on Stellar. No seed phrases, no private keys — your fingerprint or face signs every transaction.',
            publisher: { '@id': `${SITE_URL}/#organization` },
            inLanguage: ['en', 'es'],
          },
        ],
      }}
    />
  )
}

/** The wallet product page: the app itself, where to get it, and that it is free. */
export function WalletAppJsonLd() {
  return (
    <Script
      data={{
        '@context': 'https://schema.org',
        '@type': 'SoftwareApplication',
        name: 'Veil Wallet',
        applicationCategory: 'FinanceApplication',
        operatingSystem: 'Web, Android',
        url: `${SITE_URL}/products/wallet`,
        installUrl: WALLET_URL,
        downloadUrl: ANDROID_DOWNLOAD_URL,
        description:
          'A seedless, biometric-native smart wallet on Stellar Soroban. Passkeys (WebAuthn/FIDO2) sign transactions, verified on-chain; no seed phrase or private key to lose.',
        offers: { '@type': 'Offer', price: '0', priceCurrency: 'USD' },
        softwareHelp: { '@type': 'CreativeWork', url: DOCS_URL },
        // Inline rather than an @id reference: that Organization node lives on
        // the homepage, and a reference across pages may not be resolved.
        publisher: { '@type': 'Organization', name: SITE_NAME, url: SITE_URL },
      }}
    />
  )
}
