/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  // NOTE: locale routing lives in the App Router (`app/page.tsx` = en,
  // `app/es/page.tsx` = es). The `i18n` config key here is Pages-Router-only
  // and is silently ignored by the App Router — do not re-add it.
}

module.exports = nextConfig
