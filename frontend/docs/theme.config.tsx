import { useRouter } from 'next/router'
import { DocsThemeConfig, useConfig } from 'nextra-theme-docs'
import React from 'react'
import { DocSearch } from './components/DocSearch'

const Logo = () => (
  <span
    style={{
      fontFamily: "'Lora', Georgia, serif",
      fontWeight: 600,
      fontStyle: 'italic',
      fontSize: '1.15rem',
      color: '#FDDA24',
      letterSpacing: '-0.01em',
    }}
  >
    Veil
  </span>
)

const DOCS_URL = 'https://docs.useveilapp.xyz'
const DEFAULT_DESCRIPTION =
  'Veil — Passkey-powered Stellar smart wallet. SDK reference, contract API, and architecture docs.'

/**
 * Per-page <head>.
 *
 * This used to be a static fragment, and a static `head` replaces Nextra's
 * default one — which is what emits <title> and the page description. So no
 * docs page had a title at all (search results showed "GitHub", the name of the
 * GitHub icon in the header), and all 23 pages shared one description even
 * though every .mdx file already declares its own in frontmatter.
 */
function Head() {
  const { asPath } = useRouter()
  const { title, frontMatter } = useConfig()

  const path = asPath.split(/[?#]/)[0]
  const isHome = path === '/'
  const pageTitle = isHome
    ? 'Veil Docs — Passkey Smart Wallet SDK for Stellar'
    : `${title} — Veil Docs`
  const description = (frontMatter.description as string | undefined) ?? DEFAULT_DESCRIPTION
  const url = `${DOCS_URL}${isHome ? '' : path}`

  return (
    <>
      <title>{pageTitle}</title>
      <meta name="viewport" content="width=device-width, initial-scale=1.0" />
      <meta name="description" content={description} />
      <link rel="canonical" href={url} />
      <link rel="icon" type="image/svg+xml" href="/icon.svg" />

      <meta property="og:type" content="article" />
      <meta property="og:site_name" content="Veil Docs" />
      <meta property="og:title" content={pageTitle} />
      <meta property="og:description" content={description} />
      <meta property="og:url" content={url} />
      <meta property="og:image" content={`${DOCS_URL}/og.png`} />
      <meta name="twitter:card" content="summary_large_image" />
      <meta name="twitter:title" content={pageTitle} />
      <meta name="twitter:description" content={description} />
      <meta name="twitter:image" content={`${DOCS_URL}/og.png`} />

      <link
        href="https://fonts.googleapis.com/css2?family=Lora:ital,wght@0,400;0,600;1,400;1,600&family=Inter:wght@400;500&family=Anton&display=swap"
        rel="stylesheet"
      />
    </>
  )
}

const config: DocsThemeConfig = {
  logo: <Logo />,

  project: {
    link: 'https://github.com/Miracle656/veil',
  },

  docsRepositoryBase:
    'https://github.com/Miracle656/veil/tree/main/frontend/docs',

  footer: {
    content: (
      <span style={{ fontFamily: 'Inter, sans-serif', fontSize: '0.75rem', color: '#D6D2C4' }}>
        © {new Date().getFullYear()} Veil — Powered by Stellar Soroban · WebAuthn / FIDO2 · MIT
      </span>
    ),
  },

  navbar: {
    extraContent: <DocSearch />,
  },

  head: Head,

  sidebar: {
    defaultMenuCollapseLevel: 1,
  },

  toc: {
    backToTop: true,
  },

  editLink: {
    content: 'Edit this page on GitHub',
  },

  feedback: {
    content: 'Question? Give us feedback',
    labels: 'feedback',
  },

  banner: {
    key: 'agent-sdk-v1',
    content: (
      <span style={{ fontFamily: 'Inter, sans-serif', fontSize: '0.82rem' }}>
        New: AI Agent SDK is live — integrate Claude-powered wallet actions into your app.{' '}
        <a
          href="/agent-integration"
          style={{ textDecoration: 'underline', color: '#FDDA24' }}
        >
          Read the docs
        </a>
      </span>
    ),
  },
}

export default config
