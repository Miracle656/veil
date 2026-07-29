import { createWalletStore } from '@veil/invisible-wallet-svelte';
import { walletConfig } from './network';

/** One wallet store shared across the app — mirrors the SDK's Svelte adapter shape. */
export const wallet = createWalletStore(walletConfig);
