/** @type {import('next').NextConfig} */
const nextConfig = {
    transpilePackages: ['invisible-wallet-sdk'],
    experimental: {
        externalDir: true,
    }
};

export default nextConfig;
