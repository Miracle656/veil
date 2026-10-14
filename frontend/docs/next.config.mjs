import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
try {
  const webpackPkg = require('next/dist/compiled/webpack/webpack.js')
  if (webpackPkg && !webpackPkg.init) {
    webpackPkg.init = () => {}
  }
} catch {}

const { default: nextra } = await import('nextra')
import nextra from "nextra";

const withNextra = nextra({
  theme: "nextra-theme-docs",
  themeConfig: "./theme.config.tsx",
});

export default withNextra({
  reactStrictMode: true,
  async headers() {
    return [
      {
        source: "/:path*",
        headers: [
          { key: "X-Content-Type-Options", value: "nosniff" },
          { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
        ],
      },
    ];
  },
});
