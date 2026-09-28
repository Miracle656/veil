// frontend/wallet/lib/privacy/client.ts

let sppClientInstance: any = null;

/**
 * Lazily loads and initializes the SPP privacy client.
 * Ensures the ~42 MB SDK is only loaded into memory when privacy features are triggered.
 */
export async function getPrivacyClient(config?: {
  rpcUrl?: string;
  storage?: any;
  proverWorkerUrl?: string;
  bootnodeUrl?: string;
}) {
  if (sppClientInstance) {
    return sppClientInstance;
  }

  try {
    const { Client } = await import('@stellar/spp-browser-sdk' /* webpackChunkName: "spp-sdk" */);

    sppClientInstance = await Client.new({
      rpcUrl: config?.rpcUrl || process.env.NEXT_PUBLIC_SOROBAN_RPC_URL || 'https://soroban-testnet.stellar.org',
      storage: config?.storage || 'opfs-sqlite',
      proverWorkerUrl: config?.proverWorkerUrl || '/workers/prover.worker.js',
      bootnodeUrl: config?.bootnodeUrl || process.env.NEXT_PUBLIC_BOOTNODE_URL,
    });

    return sppClientInstance;
  } catch (error: any) {
    console.error('Failed to initialize privacy client:', error);
    throw new Error('Unable to start privacy mode. Please ensure your browser supports OPFS and try again.');
  }
}

/**
 * Wrapper methods exposing clean APIs for the frontend components
 */
export const privacyService = {
  async getPrivateBalance() {
    try {
      const client = await getPrivacyClient();
      const account = await client.account();
      const pool = await client.pool();
      return await pool.privateBalance(account);
    } catch (error: any) {
      throw new Error(error?.message || 'Failed to fetch private balance.');
    }
  },

  async shield(amount: string, asset: string) {
    try {
      const client = await getPrivacyClient();
      return await client.shield({ amount, asset });
    } catch (error: any) {
      throw new Error('Shielding transaction failed. Please check your wallet balance.');
    }
  },

  async privateSend(recipient: string, amount: string, asset: string) {
    try {
      const client = await getPrivacyClient();
      return await client.privateSend({ recipient, amount, asset });
    } catch (error: any) {
      throw new Error('Private transfer could not be completed at this time.');
    }
  },

  async unshield(amount: string, asset: string) {
    try {
      const client = await getPrivacyClient();
      return await client.unshield({ amount, asset });
    } catch (error: any) {
      throw new Error('Unshielding process failed.');
    }
  }
};
