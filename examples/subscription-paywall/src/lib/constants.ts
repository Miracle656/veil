// Dependency-free constants safe to import from the Edge middleware (must not
// pull in @stellar/stellar-sdk).

/** Cookie that carries the connected wallet's contract address to the server. */
export const WALLET_COOKIE = 'veil_wallet'
