import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
try {
  const webpackPkg = require('next/dist/compiled/webpack/webpack.js')
  if (webpackPkg && !webpackPkg.init) {
    webpackPkg.init = () => {}
  }
} catch {}

const { default: nextra } = await import('nextra')

const withNextra = nextra({
  theme: 'nextra-theme-docs',
  themeConfig: './theme.config.tsx',
})

export default withNextra({
  reactStrictMode: true,
})
