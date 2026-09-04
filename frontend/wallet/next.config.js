const path = require('path')

/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  outputFileTracingRoot: path.join(__dirname, '../../'),
  experimental: {
    // Allow imports from outside the Next.js project root (e.g. ../../sdk/src)
    externalDir: true,
  },
  async headers() {
    // Baseline security headers on every route. The wallet origin holds signing
    // material, so it must not be framable (clickjacking → transaction-approval
    // theft) and must not sniff content types. `frame-ancestors 'none'` and
    // `object-src 'none'` are the load-bearing directives; script/style/connect
    // stay permissive so Next's inline hydration, stellar-sdk wasm, and the
    // RPC/Horizon/WebSocket/Supabase calls keep working. `publickey-credentials`
    // is explicitly allowed so WebAuthn (the whole point of the wallet) works.
    const csp = [
      "default-src 'self'",
      "script-src 'self' 'unsafe-inline' 'unsafe-eval' 'wasm-unsafe-eval'",
      // globals.css @imports the four brand faces (Lora, Inter, Anton,
      // Inconsolata) from Google Fonts. Without these two hosts the CSP blocks
      // the stylesheet outright and every screen silently falls back to system
      // fonts — the headings stop being Lora italic and the wordmark stops
      // being Anton, which reads as "the design did not ship".
      "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
      "img-src 'self' data: blob: https:",
      "font-src 'self' data: https://fonts.gstatic.com",
      "connect-src 'self' https: wss:",
      "worker-src 'self' blob:",
      "frame-ancestors 'none'",
      "object-src 'none'",
      "base-uri 'self'",
      "form-action 'self'",
    ].join('; ')

    const securityHeaders = [
      { key: 'Content-Security-Policy', value: csp },
      { key: 'X-Frame-Options', value: 'DENY' },
      { key: 'X-Content-Type-Options', value: 'nosniff' },
      { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
      {
        key: 'Permissions-Policy',
        value:
          'camera=(), microphone=(), geolocation=(), payment=(), ' +
          'publickey-credentials-get=(self), publickey-credentials-create=(self)',
      },
    ]

    // iOS refuses an apple-app-site-association file that is not served as
    // JSON, and the file has no extension so Next cannot infer the type.
    // Android is stricter still: assetlinks.json must be reachable over HTTPS
    // with no redirect. Both files live in public/.well-known/.
    return [
      {
        source: '/:path*',
        headers: securityHeaders,
      },
      {
        source: '/.well-known/apple-app-site-association',
        headers: [{ key: 'Content-Type', value: 'application/json' }],
      },
      {
        source: '/.well-known/assetlinks.json',
        headers: [{ key: 'Content-Type', value: 'application/json' }],
      },
    ]
  },
  webpack: (config) => {
    // When webpack compiles SDK source files from ../../sdk/src/, it resolves
    // node_modules going up from that directory and misses the wallet's
    // node_modules. Prepend wallet's node_modules so imports like
    // @stellar/stellar-sdk resolve correctly regardless of the importer's path.
    config.resolve.modules = [
      path.resolve(__dirname, 'node_modules'),
      ...config.resolve.modules,
    ]
    return config
  },
}

const withPWA = require('next-pwa')({
  dest: 'public',
  disable: process.env.NODE_ENV === 'development',
  register: true,
  skipWaiting: true,
  fallbacks: {
    document: '/offline',
  },
})

module.exports = withPWA(nextConfig)
