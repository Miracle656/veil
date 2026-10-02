const path = require('path')

/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  experimental: {
    // Allow imports from outside the Next.js project root (e.g. ../../sdk/src)
    externalDir: true,
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
