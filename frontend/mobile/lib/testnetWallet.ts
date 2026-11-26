/**
 * @deprecated Renamed to `classicWallet.ts`. Re-exported for backwards compatibility.
 * Mainnet and production code paths should import from `classicWallet.ts` and use
 * `createClassicWallet` / `importClassicWallet`.
 */

export {
  createClassicWallet,
  importClassicWallet,
  createClassicWallet as createTestnetWallet,
  importClassicWallet as importTestnetWallet,
  fundWithFriendbot,
  hasWalletKey,
  type CreatedWallet,
} from './classicWallet';
