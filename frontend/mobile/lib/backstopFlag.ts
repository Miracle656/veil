/**
 * The backstop is first-loss capital, so its entry point stays hidden on mainnet
 * until it is explicitly switched on. It is always available on testnet.
 * Set EXPO_PUBLIC_BACKSTOP_ENABLED=true to show it elsewhere.
 */
export function isBackstopEnabled(networkName: string): boolean {
  return networkName === 'testnet' || process.env.EXPO_PUBLIC_BACKSTOP_ENABLED === 'true';
}
