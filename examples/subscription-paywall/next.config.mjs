/** @type {import('next').NextConfig} */
const nextConfig = {
  // Suppress the "Critical dependency: the request of a dependency is an
  // expression" warning from stellar-sdk's optional wasm loader.
  webpack(config) {
    config.ignoreWarnings = [{ module: /stellar-sdk/ }]
    return config
  },
}

export default nextConfig
