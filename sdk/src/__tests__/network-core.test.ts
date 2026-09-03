import {
  namespaceKey,
  getNetworkConfig,
  getNativeAssetContractId,
  getUsdcIssuer,
  buildFriendbotUrl,
  WALLET_KEYS,
  NETWORKS,
} from '../network';
import { inclusionFee } from '../fees';
import { spendableNativeXlm } from '../reserves';
import { createNamespacedStorage, clearNetworkWalletKeys } from '../walletStorage';
import type { StorageAdapter } from '../core';

describe('SDK Core Modules', () => {
  describe('network', () => {
    it('returns testnet config by default', () => {
      const net = getNetworkConfig();
      expect(net.name).toBe('testnet');
      expect(net.horizonUrl).toBe('https://horizon-testnet.stellar.org');
    });

    it('returns mainnet config when requested', () => {
      const net = getNetworkConfig('mainnet');
      expect(net.name).toBe('mainnet');
      expect(net.horizonUrl).toBe('https://horizon.stellar.org');
    });

    it('namespaces wallet keys on mainnet and keeps testnet keys bare', () => {
      for (const key of WALLET_KEYS) {
        expect(namespaceKey(key, 'testnet')).toBe(key);
        expect(namespaceKey(key, 'mainnet')).toBe(`${key}_mainnet`);
      }
    });

    it('does not namespace non-wallet keys', () => {
      expect(namespaceKey('veil_theme', 'mainnet')).toBe('veil_theme');
      expect(namespaceKey('custom_key', 'testnet')).toBe('custom_key');
    });

    it('derives native asset contract id for network passphrase', () => {
      const testnetId = getNativeAssetContractId(NETWORKS.testnet.networkPassphrase);
      const mainnetId = getNativeAssetContractId(NETWORKS.mainnet.networkPassphrase);
      expect(typeof testnetId).toBe('string');
      expect(typeof mainnetId).toBe('string');
      expect(testnetId).not.toBe(mainnetId);
    });

    it('builds friendbot url for testnet and returns null for mainnet', () => {
      expect(buildFriendbotUrl('GB...', NETWORKS.testnet.friendbotUrl)).toBe(
        'https://friendbot.stellar.org/?addr=GB...',
      );
      expect(buildFriendbotUrl('GB...', NETWORKS.mainnet.friendbotUrl)).toBeNull();
    });

    it('resolves correct USDC issuer per network', () => {
      expect(getUsdcIssuer('mainnet')).toBe(
        'GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN',
      );
      expect(getUsdcIssuer('testnet')).toBe(
        'GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5',
      );
    });
  });

  describe('fees', () => {
    it('returns standard BASE_FEE for testnet and 1000000 stroops for mainnet', () => {
      expect(inclusionFee('testnet')).toBe('100');
      expect(inclusionFee('mainnet')).toBe('1000000');
      expect(inclusionFee(NETWORKS.mainnet)).toBe('1000000');
      expect(inclusionFee()).toBe('100');
    });
  });

  describe('reserves', () => {
    it('calculates spendable XLM correctly with reserves and liabilities', () => {
      const account = {
        subentry_count: 2, // reserve = (2 + 2) * 0.5 = 2.0 XLM
        balances: [
          {
            asset_type: 'native',
            balance: '10.5000000',
            selling_liabilities: '1.0000000',
          },
        ],
      };
      // 10.5 - 2.0 - 1.0 = 7.5
      expect(spendableNativeXlm(account)).toBe('7.5000000');
    });

    it('returns 0 when balance is below reserve', () => {
      const account = {
        subentry_count: 2,
        balances: [
          {
            asset_type: 'native',
            balance: '1.5000000',
          },
        ],
      };
      expect(spendableNativeXlm(account)).toBe('0');
    });
  });

  describe('walletStorage', () => {
    it('namespaces keys through createNamespacedStorage wrapper', () => {
      const memory = new Map<string, string>();
      const store: StorageAdapter = {
        getItem: (k) => memory.get(k) ?? null,
        setItem: (k, v) => memory.set(k, v),
        removeItem: (k) => memory.delete(k),
      };

      let activeNetwork: 'testnet' | 'mainnet' = 'testnet';
      const namespaced = createNamespacedStorage(store, () => activeNetwork);

      namespaced.setItem('invisible_wallet_address', 'C_TESTNET');
      expect(memory.get('invisible_wallet_address')).toBe('C_TESTNET');

      activeNetwork = 'mainnet';
      namespaced.setItem('invisible_wallet_address', 'C_MAINNET');
      expect(memory.get('invisible_wallet_address_mainnet')).toBe('C_MAINNET');

      expect(namespaced.getItem('invisible_wallet_address')).toBe('C_MAINNET');

      clearNetworkWalletKeys(store, 'mainnet');
      expect(memory.get('invisible_wallet_address_mainnet')).toBeUndefined();
      expect(memory.get('invisible_wallet_address')).toBe('C_TESTNET');
    });
  });
});
