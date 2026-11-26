import { createWalletStore } from 'invisible-wallet-sdk/svelte';
import { walletConfig } from './network';

/** One wallet store shared across the app — mirrors the SDK's Svelte adapter shape. */
export const wallet = createWalletStore(walletConfig);
