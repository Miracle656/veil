/**
 * Server-only configuration. Reads environment variables (see .env.example) and
 * exposes the public subset to the browser via the root loader (window.ENV).
 */

export interface PublicEnv {
  NETWORK: string
  SOROBAN_RPC_URL: string
  HORIZON_URL: string
  FACTORY_CONTRACT_ID: string
}

export function getPublicEnv(): PublicEnv {
  return {
    NETWORK: process.env.NETWORK || 'testnet',
    SOROBAN_RPC_URL: process.env.SOROBAN_RPC_URL || 'https://soroban-testnet.stellar.org',
    HORIZON_URL: process.env.HORIZON_URL || 'https://horizon-testnet.stellar.org',
    FACTORY_CONTRACT_ID: process.env.FACTORY_CONTRACT_ID || '',
  }
}
