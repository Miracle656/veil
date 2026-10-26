import { Keypair } from '@stellar/stellar-sdk';

const mockGetNetwork = jest.fn();
jest.mock('../network', () => ({
  getNetwork: () => mockGetNetwork(),
}));

const mockStore = new Map<string, string>();
jest.mock('../walletStore', () => ({
  getWalletAddress: jest.fn(async () => mockStore.get('veil_wallet_address') ?? null),
  getSignerSecret: jest.fn(async () => mockStore.get('veil_signer_secret') ?? null),
  setWalletAddress: jest.fn(async (addr: string) => {
    mockStore.set('veil_wallet_address', addr);
  }),
  setSignerSecret: jest.fn(async (secret: string) => {
    mockStore.set('veil_signer_secret', secret);
  }),
}));

import {
  createClassicWallet,
  importClassicWallet,
  fundWithFriendbot,
  hasWalletKey,
} from '../classicWallet';
import {
  createTestnetWallet,
  importTestnetWallet,
} from '../testnetWallet';

const TESTNET_CONFIG = {
  name: 'testnet' as const,
  displayName: 'Stellar Testnet',
  networkPassphrase: 'Test SDF Network ; September 2015',
  horizonUrl: 'https://horizon-testnet.stellar.org',
  rpcUrl: 'https://soroban-testnet.stellar.org',
  factoryContractId: 'CAUK4MWO3TTFM6PLURSH2GPK3AB747SZGABKTCVLKCU7W2MGKHKP35GA',
  friendbotUrl: 'https://friendbot.stellar.org',
};

const MAINNET_CONFIG = {
  name: 'mainnet' as const,
  displayName: 'Stellar Mainnet',
  networkPassphrase: 'Public Global Stellar Network ; September 2015',
  horizonUrl: 'https://horizon.stellar.org',
  rpcUrl: 'https://app.useveilapp.xyz/api/rpc/mainnet',
  factoryContractId: 'CCZ3J7O7B7EQ2Z4464WAGSJJ7RHRYJ45Q7Y255W34A5Y5U27L4V34W3A',
  friendbotUrl: null,
};

describe('classicWallet lifecycle', () => {
  const originalFetch = globalThis.fetch;

  beforeEach(() => {
    mockStore.clear();
    mockGetNetwork.mockReturnValue(TESTNET_CONFIG);
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  describe('createClassicWallet', () => {
    it('creates a funded classic keypair wallet on testnet', async () => {
      globalThis.fetch = jest.fn(async () => ({
        ok: true,
        status: 200,
        text: async () => 'ok',
      })) as unknown as typeof fetch;

      const wallet = await createClassicWallet();

      expect(wallet.address).toMatch(/^G[A-Z0-9]{55}$/);
      expect(wallet.funded).toBe(true);
      expect(mockStore.get('veil_wallet_address')).toBe(wallet.address);
      expect(mockStore.get('veil_signer_secret')).toBeDefined();
      expect(Keypair.fromSecret(mockStore.get('veil_signer_secret')!).publicKey()).toBe(
        wallet.address
      );
      expect(globalThis.fetch).toHaveBeenCalledWith(
        `https://friendbot.stellar.org?addr=${encodeURIComponent(wallet.address)}`
      );
    });

    it('creates an unfunded classic keypair wallet on mainnet without hitting Friendbot', async () => {
      mockGetNetwork.mockReturnValue(MAINNET_CONFIG);
      const mockFetch = jest.fn();
      globalThis.fetch = mockFetch as unknown as typeof fetch;

      const wallet = await createClassicWallet();

      expect(wallet.address).toMatch(/^G[A-Z0-9]{55}$/);
      expect(wallet.funded).toBe(false);
      expect(mockStore.get('veil_wallet_address')).toBe(wallet.address);
      expect(mockFetch).not.toHaveBeenCalled();
    });
  });

  describe('importClassicWallet', () => {
    it('imports an existing keypair and tops up from Friendbot on testnet', async () => {
      const kp = Keypair.random();
      globalThis.fetch = jest.fn(async () => ({
        ok: true,
        status: 200,
        text: async () => 'ok',
      })) as unknown as typeof fetch;

      const wallet = await importClassicWallet(kp.secret());

      expect(wallet.address).toBe(kp.publicKey());
      expect(wallet.funded).toBe(true);
      expect(mockStore.get('veil_wallet_address')).toBe(kp.publicKey());
      expect(mockStore.get('veil_signer_secret')).toBe(kp.secret());
      expect(globalThis.fetch).toHaveBeenCalledWith(
        `https://friendbot.stellar.org?addr=${encodeURIComponent(kp.publicKey())}`
      );
    });

    it('imports a keypair on mainnet without hitting Friendbot', async () => {
      mockGetNetwork.mockReturnValue(MAINNET_CONFIG);
      const kp = Keypair.random();
      const mockFetch = jest.fn();
      globalThis.fetch = mockFetch as unknown as typeof fetch;

      const wallet = await importClassicWallet(kp.secret());

      expect(wallet.address).toBe(kp.publicKey());
      expect(wallet.funded).toBe(false);
      expect(mockStore.get('veil_wallet_address')).toBe(kp.publicKey());
      expect(mockFetch).not.toHaveBeenCalled();
    });

    it('rejects an invalid secret', async () => {
      await expect(importClassicWallet('invalid-secret')).rejects.toThrow();
    });
  });

  describe('fundWithFriendbot', () => {
    it('returns false immediately on mainnet without fetching', async () => {
      mockGetNetwork.mockReturnValue(MAINNET_CONFIG);
      const mockFetch = jest.fn();
      globalThis.fetch = mockFetch as unknown as typeof fetch;

      const ok = await fundWithFriendbot('GA2C5RFPE6GCKMY3US5PAB6UZLKIGAHWKXX2GIOVPWW27NOFLWESWDA5');
      expect(ok).toBe(false);
      expect(mockFetch).not.toHaveBeenCalled();
    });

    it('handles 400 when the account is already funded', async () => {
      globalThis.fetch = jest.fn(async () => ({
        ok: false,
        status: 400,
        text: async () => 'createAccountAlreadyExist',
      })) as unknown as typeof fetch;

      const ok = await fundWithFriendbot('GA2C5RFPE6GCKMY3US5PAB6UZLKIGAHWKXX2GIOVPWW27NOFLWESWDA5');
      expect(ok).toBe(true);
    });

    it('handles fetch exceptions gracefully', async () => {
      globalThis.fetch = jest.fn(async () => {
        throw new Error('Network error');
      }) as unknown as typeof fetch;

      const ok = await fundWithFriendbot('GA2C5RFPE6GCKMY3US5PAB6UZLKIGAHWKXX2GIOVPWW27NOFLWESWDA5');
      expect(ok).toBe(false);
    });
  });

  describe('hasWalletKey', () => {
    it('returns false when no wallet is set', async () => {
      expect(await hasWalletKey()).toBe(false);
    });

    it('returns false when only address is set without secret', async () => {
      mockStore.set('veil_wallet_address', 'GA2C5RFPE6GCKMY3US5PAB6UZLKIGAHWKXX2GIOVPWW27NOFLWESWDA5');
      expect(await hasWalletKey()).toBe(false);
    });

    it('returns true when both address and secret are present', async () => {
      const kp = Keypair.random();
      mockStore.set('veil_wallet_address', kp.publicKey());
      mockStore.set('veil_signer_secret', kp.secret());
      expect(await hasWalletKey()).toBe(true);
    });
  });

  describe('testnetWallet backward-compatibility exports', () => {
    it('aliases createTestnetWallet to createClassicWallet', () => {
      expect(createTestnetWallet).toBe(createClassicWallet);
    });

    it('aliases importTestnetWallet to importClassicWallet', () => {
      expect(importTestnetWallet).toBe(importClassicWallet);
    });
  });
});
