/**
 * Earn screen tests for USDT0 unavailability and holding-asset clarity.
 */

import { Asset, Keypair, Networks, StrKey } from '@stellar/stellar-sdk';

import { USDC_MAINNET_ISSUER, USDT0_MAINNET_ISSUER } from '../lib/assets';

const mockWallet = StrKey.encodeContract(Buffer.alloc(32, 9));
const mockSecret = Keypair.random().secret();
const mockRouter = { replace: jest.fn(), push: jest.fn(), back: jest.fn() };
const mockColors = new Proxy({}, { get: () => '#000000' });
const mockWalletCtx = { wallet: { deploy: jest.fn() } };
const mockMask = (v: string) => v;

let mockParams: { asset?: string; issuer?: string; amount?: string } = {};
let mockNetworkName: 'mainnet' | 'testnet' = 'mainnet';

const mockLoadBlendPools = jest.fn();
const mockLoadBlendPositions = jest.fn();

jest.mock('expo-router', () => ({
  useRouter: () => mockRouter,
  useLocalSearchParams: () => mockParams,
}));

jest.mock('../hooks/useTheme', () => ({
  useTheme: () => ({ colors: mockColors, isDark: false }),
}));

jest.mock('../hooks/useHiddenAmounts', () => ({
  useHiddenAmounts: () => ({ mask: mockMask }),
}));

jest.mock('../hooks/useNetwork', () => ({
  useNetwork: () => ({
    networkName: mockNetworkName,
    network:
      mockNetworkName === 'mainnet'
        ? {
            name: 'mainnet',
            displayName: 'Stellar Mainnet',
            rpcUrl: 'https://mainnet.sorobanrpc.com',
            horizonUrl: 'https://horizon.stellar.org',
            networkPassphrase: 'Public Global Stellar Network ; September 2015',
          }
        : {
            name: 'testnet',
            displayName: 'Stellar Testnet',
            rpcUrl: 'https://soroban-testnet.stellar.org',
            horizonUrl: 'https://horizon-testnet.stellar.org',
            networkPassphrase: 'Test SDF Network ; September 2015',
          },
  }),
}));

jest.mock('../components/WalletProvider', () => ({
  useWallet: () => mockWalletCtx,
}));

jest.mock('../lib/walletStore', () => ({
  getWalletAddress: jest.fn(async () => mockWallet),
  getSignerSecret: jest.fn(async () => mockSecret),
}));

jest.mock('../lib/earnFunding', () => ({
  loadEarnBalances: jest.fn(async () => ({ inSpending: 50, inWallet: 0, hasTrustline: true })),
  fundDeposit: jest.fn(async () => undefined),
}));

jest.mock('../lib/blend', () => {
  const actual = jest.requireActual('../lib/blend');
  return {
    ...actual,
    loadBlendPools: (...args: unknown[]) => mockLoadBlendPools(...args),
    loadBlendPositions: (...args: unknown[]) => mockLoadBlendPositions(...args),
  };
});

import React from 'react';
import EarnRoute from '../app/(tabs)/earn';

type Instance = { props: Record<string, unknown>; children: (Instance | string)[] };
type Renderer = {
  act: (fn: () => Promise<void>) => Promise<void>;
  create: (el: unknown) => {
    root: {
      findAllByProps: (p: object) => Instance[];
      findByProps: (p: object) => Instance;
    };
  };
};
// eslint-disable-next-line @typescript-eslint/no-require-imports
const renderer: Renderer = require('react-test-renderer');

function collectText(node: Instance): string {
  return node.children
    .map((c) => (typeof c === 'string' ? c : collectText(c)))
    .join('')
    .replace(/\s+/g, ' ');
}

const USDC_MAINNET_SAC = new Asset('USDC', USDC_MAINNET_ISSUER).contractId(Networks.PUBLIC);

describe('EarnRoute USDT0 unavailable path', () => {
  beforeEach(() => {
    mockParams = {};
    mockNetworkName = 'mainnet';
    mockLoadBlendPools.mockResolvedValue([
      {
        id: 'CAJJZSGMMM3PD7N33TAPHGBUGTB43OC73HVIK2L2G6BNGGGYOSSYBXBD',
        name: 'Fixed',
        reserves: [
          {
            assetId: USDC_MAINNET_SAC,
            code: 'USDC',
            supplyApy: 0.064,
            totalSupply: '1000000000',
          },
        ],
      },
    ]);
    mockLoadBlendPositions.mockResolvedValue([]);
  });

  it('shows USDT0 as unavailable on mainnet with issuer, reason, and holding statement', async () => {
    let tree!: ReturnType<Renderer['create']>;
    await renderer.act(async () => {
      tree = renderer.create(React.createElement(EarnRoute));
    });
    await renderer.act(async () => {
      await Promise.resolve();
    });

    const card = tree.root.findByProps({ testID: 'earn-unavailable-USDT0' });
    const content = collectText(card);

    expect(content).toContain('USDT0 · Tether (GATI…HN6Q)');
    expect(content).toContain('Earning not available for this asset yet');
    expect(content).toContain('Blend Fixed V2 does not have a USDT0 reserve on Stellar mainnet yet.');
    expect(content).toContain('Your USDT0 stays in your wallet as USDT0');
    expect(card.children).toBeDefined();
  });

  it('hides the USDT0 unavailable card on testnet', async () => {
    mockNetworkName = 'testnet';
    mockLoadBlendPools.mockResolvedValue([]);

    let tree!: ReturnType<Renderer['create']>;
    await renderer.act(async () => {
      tree = renderer.create(React.createElement(EarnRoute));
    });
    await renderer.act(async () => {
      await Promise.resolve();
    });

    expect(tree.root.findAllByProps({ testID: 'earn-unavailable-USDT0' })).toHaveLength(0);
  });

  it('shows unavailable notice when deep-linked with pinned Tether USDT0 issuer', async () => {
    mockParams = {
      asset: 'USDT0',
      issuer: USDT0_MAINNET_ISSUER,
      amount: '25',
    };

    let tree!: ReturnType<Renderer['create']>;
    await renderer.act(async () => {
      tree = renderer.create(React.createElement(EarnRoute));
    });
    await renderer.act(async () => {
      await Promise.resolve();
    });

    const notice = tree.root.findByProps({ testID: 'earn-param-notice' });
    const content = collectText(notice);
    expect(content).toContain('Earning not available');
    expect(content).toContain('GATI…HN6Q');
    expect(content).toContain('stays in your wallet as USDT0');
  });

  it('warns and refuses when deep-linked with an impostor USDT0 issuer', async () => {
    mockParams = {
      asset: 'USDT0',
      issuer: 'GC35JBERU4SFTDVOF32A2SIJN5FHSLSZFZSGP6VVFWCZNDVGJFLQBANK',
      amount: '25',
    };

    let tree!: ReturnType<Renderer['create']>;
    await renderer.act(async () => {
      tree = renderer.create(React.createElement(EarnRoute));
    });
    await renderer.act(async () => {
      await Promise.resolve();
    });

    const notice = tree.root.findByProps({ testID: 'earn-param-notice' });
    const content = collectText(notice);
    expect(content).toContain('Unregistered issuer');
    expect(content).toContain('GATI…HN6Q');
  });

  it('states what the user will actually hold on the USDC deposit form', async () => {
    mockParams = {
      asset: 'USDC',
      issuer: USDC_MAINNET_ISSUER,
      amount: '10',
    };

    let tree!: ReturnType<Renderer['create']>;
    await renderer.act(async () => {
      tree = renderer.create(React.createElement(EarnRoute));
    });
    await renderer.act(async () => {
      await Promise.resolve();
    });

    const allText = collectText(tree.root as unknown as Instance);
    expect(allText).toContain('You will hold a USDC supply position');
    expect(allText).toContain('no asset conversion happens');
  });
});
