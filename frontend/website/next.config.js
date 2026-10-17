/** @type {import('next').NextConfig} */
const nextConfig = {
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
      {
        // SEP-1 metadata is fetched cross-origin by Stellar wallets. Keep the
        // response public and explicitly use the media type SEP-1 expects.
        source: "/.well-known/stellar.toml",
        headers: [
          { key: "Content-Type", value: "text/plain; charset=utf-8" },
          { key: "Access-Control-Allow-Origin", value: "*" },
        ],
      },
    ];
  },
  // NOTE: locale routing lives in the App Router (`app/page.tsx` = en,
  // `app/es/page.tsx` = es). The `i18n` config key here is Pages-Router-only
  // and is silently ignored by the App Router — do not re-add it.
};

module.exports = nextConfig;
