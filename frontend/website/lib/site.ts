/**
 * The site's public address, and the one place it is decided.
 *
 * This used to fall back to `VERCEL_URL`, which is the hostname of the one
 * deployment that happened to build the page — `veil-<hash>-<team>.vercel.app`,
 * behind Vercel's login and served with `X-Robots-Tag: noindex`. Every canonical
 * and hreflang tag on the live site pointed there, so the homepage told search
 * engines its real version was a private page they may not index. The site did
 * not rank even for its own domain name.
 *
 * A canonical URL is a statement about where the page permanently lives, so it
 * is never derived from the deployment. Override with NEXT_PUBLIC_SITE_URL only
 * if the site genuinely moves. `www` because the apex 308-redirects to it, and a
 * canonical that redirects is a weaker signal than one that answers.
 */
export const SITE_URL = (process.env.NEXT_PUBLIC_SITE_URL ?? 'https://www.useveilapp.xyz').replace(
  /\/+$/,
  '',
)

export const SITE_NAME = 'Veil'

/** The company behind Veil, as it appears on its CAC certificate. */
export const LEGAL_ENTITY_NAME = 'Divinity Labs Limited'
export const LEGAL_RC = '10031131'
export const LEGAL_ENTITY = `Veil is a product of ${LEGAL_ENTITY_NAME}, a company registered in Nigeria (RC ${LEGAL_RC}).`
/**
 * Where people write to us, including requests about their personal data.
 * The Terms and the Privacy Policy both print this, so it must be a mailbox
 * somebody reads.
 */
export const SUPPORT_EMAIL = 'support@useveilapp.xyz'
export const WALLET_URL = 'https://app.useveilapp.xyz'
export const DOCS_URL = 'https://docs.useveilapp.xyz'
export const REPO_URL = 'https://github.com/Miracle656/veil'
/** Public and permanent; `latest` follows the newest community build. */
export const ANDROID_DOWNLOAD_URL = 'https://github.com/Miracle656/veil/releases/latest'

/** Official profiles, for the Organization's `sameAs`. Only accounts Veil controls. */
export const SAME_AS = [REPO_URL, 'https://x.com/veilonstellar']
