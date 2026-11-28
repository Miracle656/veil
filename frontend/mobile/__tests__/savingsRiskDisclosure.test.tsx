/**
 * #1281 — Say what the risk is: name the pool, the exploit, and that this is
 * not a bank.
 *
 * Acceptance criteria verified here:
 * - The pool is named, with its full 56-char contract id, on a screen the user
 *   can reach before depositing.
 * - The three risks are stated in plain language, visible before the first
 *   deposit: protocol exploit, variable unpromised rate, and full utilization
 *   preventing immediate payout.
 * - No rate is shown as a promise or as an annualised guarantee; rates are
 *   shown as observed-now with a timestamp.
 * - The disclosure is a shared component (`SavingsRiskDisclosure`), used by
 *   every savings entry point rather than copy-pasted per screen.
 * - The disclosure renders before the deposit action is reachable.
 */

import React from 'react';
import { Keypair, StrKey } from '@stellar/stellar-sdk';
import { BLEND_FIXED_V2_MAINNET_POOL_ID } from '../lib/blend';
import {
  formatObservedRate,
  SAVINGS_DISCLOSURE,
  SavingsRiskDisclosure,
} from '../components/SavingsRiskDisclosure';
import EarnRoute from '../app/(tabs)/earn';

const mockWallet = StrKey.encodeContract(Buffer.alloc(32, 7));
const mockSecret = Keypair.random().secret();
const mockOpenExternalUrl = jest.fn(async (_url: string) => true);
const mockLoadBlendPools = jest.fn();
const mockLoadBlendPositions = jest.fn();
const mockLoadEarnBalances = jest.fn();

const mockThemeColors = new Proxy({}, { get: () => '#000000' });
const mockNetwork = {
  name: 'mainnet' as const,
  displayName: 'Stellar Mainnet',
  rpcUrl: 'https://app.useveilapp.xyz/api/rpc/mainnet',
  horizonUrl: 'https://horizon.stellar.org',
  networkPassphrase: 'Public Global Stellar Network ; September 2015',
  factoryContractId: 'CCZ3JLRESNLDADGXWNEH4YQ4NXUUAHRJNCWZHYG6QB4KTDYHOH6OQ7BK',
  friendbotUrl: null,
};
const mockRouter = { push: jest.fn(), replace: jest.fn(), back: jest.fn() };
const mockWalletObj = { deploy: jest.fn() };
const mockMask = (value: string) => value;

let mockSearchParams: Record<string, string> = {};

jest.mock('expo-router', () => ({
  useRouter: () => mockRouter,
  useLocalSearchParams: () => mockSearchParams,
}));

jest.mock('../hooks/useTheme', () => ({
  useTheme: () => ({
    colors: mockThemeColors,
    isDark: true,
  }),
}));

jest.mock('../hooks/useHiddenAmounts', () => ({
  useHiddenAmounts: () => ({ mask: mockMask, hidden: false }),
}));

jest.mock('../hooks/useNetwork', () => ({
  useNetwork: () => ({
    networkName: 'mainnet',
    network: mockNetwork,
  }),
}));

jest.mock('../components/WalletProvider', () => ({
  useWallet: () => ({ wallet: mockWalletObj }),
}));

jest.mock('../lib/walletStore', () => ({
  getWalletAddress: jest.fn(async () => mockWallet),
  getSignerSecret: jest.fn(async () => mockSecret),
}));

jest.mock('../lib/about', () => {
  const actual = jest.requireActual('../lib/about');
  return {
    ...actual,
    openExternalUrl: (url: string) => mockOpenExternalUrl(url),
  };
});

jest.mock('../lib/blend', () => {
  const actual = jest.requireActual('../lib/blend');
  return {
    ...actual,
    loadBlendPools: (...args: unknown[]) => mockLoadBlendPools(...args),
    loadBlendPositions: (...args: unknown[]) => mockLoadBlendPositions(...args),
  };
});

jest.mock('../lib/earnFunding', () => ({
  loadEarnBalances: (...args: unknown[]) => mockLoadEarnBalances(...args),
  fundDeposit: jest.fn(),
}));

jest.mock('../lib/passkey', () => ({
  requirePasskey: jest.fn(),
}));

jest.mock('../lib/sorobanTx', () => ({
  signAndSubmitSorobanXdr: jest.fn(),
}));

type Instance = {
  type?: unknown;
  props: Record<string, unknown>;
  children: (Instance | string)[];
};
type Renderer = {
  act: (fn: () => Promise<void> | void) => Promise<void>;
  create: (el: unknown) => {
    root: Instance & {
      findByProps: (p: object) => Instance;
      findAllByProps: (p: object) => Instance[];
      findAllByType: (t: unknown) => Instance[];
    };
  };
};
// eslint-disable-next-line @typescript-eslint/no-require-imports
const renderer: Renderer = require('react-test-renderer');

function collectText(node: Instance | string): string {
  const parts: string[] = [];
  const walk = (current: Instance | string) => {
    if (typeof current === 'string') {
      parts.push(current);
      return;
    }
    if (current && Array.isArray(current.children)) {
      current.children.forEach(walk);
    }
  };
  walk(node);
  return parts.join(' ');
}

/**
 * Flatten the tree in pre-order traversal so we can assert which node renders
 * earlier in the document/screen order.
 */
function flattenNodes(root: Instance): Instance[] {
  const order: Instance[] = [];
  const walk = (node: Instance | string) => {
    if (typeof node === 'string' || !node) return;
    order.push(node);
    if (Array.isArray(node.children)) {
      node.children.forEach(walk);
    }
  };
  walk(root);
  return order;
}

async function renderEarn() {
  let tree!: ReturnType<Renderer['create']>;
  await renderer.act(async () => {
    tree = renderer.create(<EarnRoute />);
    await Promise.resolve();
    await Promise.resolve();
  });
  return tree.root;
}

jest.setTimeout(60_000);

describe('SavingsRiskDisclosure & Earn screen (#1281)', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockSearchParams = {};
    mockLoadBlendPools.mockResolvedValue([
      {
        id: BLEND_FIXED_V2_MAINNET_POOL_ID,
        name: 'Fixed V2',
        reserves: [
          {
            assetId: 'CCW67TSZV3SSS2HXMBQ5JFGCKJNXKZM7UQUWUZPUTHXSTZLEO7SJMI75',
            code: 'USDC',
            supplyApy: 0.0485,
            totalSupply: '100000000000',
          },
          {
            assetId: 'CAS3J7GYLGXMF6TDJBBYYSE3HQ6BBSMLNUQ34T6TZMYMW2EVH34XOWMA',
            code: 'XLM',
            supplyApy: 0.021,
            totalSupply: '50000000000',
          },
        ],
      },
    ]);
    mockLoadBlendPositions.mockResolvedValue([]);
    mockLoadEarnBalances.mockResolvedValue({ inSpending: 50, inWallet: 50 });
  });

  it('names the Blend Fixed V2 pool, its full 56-character contract id, and the Feb 2026 YieldBlox exploit before depositing', async () => {
    const root = await renderEarn();
    const screenText = collectText(root);

    // Must name the protocol and the pool with its un-truncated contract ID
    expect(screenText).toContain('Blend Protocol');
    expect(screenText).toContain('Blend Fixed V2');
    expect(screenText).toContain(BLEND_FIXED_V2_MAINNET_POOL_ID);
    expect(BLEND_FIXED_V2_MAINNET_POOL_ID).toBe(
      'CAJJZSGMMM3PD7N33TAPHGBUGTB43OC73HVIK2L2G6BNGGGYOSSYBXBD',
    );

    // Must accurately distinguish the February 2026 YieldBlox oracle exploit
    expect(screenText).toContain('YieldBlox');
    expect(screenText).toContain('USTRY');
    expect(screenText).toContain('Reflector');
    expect(screenText).toContain('not the pool that was hit');

    // Must link to the pool contract on stellar.expert
    const contractLink = root.findByProps({ testID: 'savings-pool-contract-link' });
    await renderer.act(async () => {
      (contractLink.props.onPress as () => void)();
    });
    expect(mockOpenExternalUrl).toHaveBeenCalledWith(
      `https://stellar.expert/explorer/public/contract/${BLEND_FIXED_V2_MAINNET_POOL_ID}`,
    );
  });

  it('states the three real risks and that this is not an insured bank deposit in plain language before the first deposit', async () => {
    const root = await renderEarn();
    const screenText = collectText(root);

    // Plain statement that this is not a bank deposit and nothing is insured
    expect(screenText).toMatch(/not a bank deposit and nothing is insured/i);

    // The three required risks in plain language:
    // 1. The protocol can be exploited
    const exploitRisk = root.findByProps({ testID: 'savings-risk-protocol-exploit' });
    expect(collectText(exploitRisk)).toMatch(/protocol can be exploited/i);

    // 2. The rate is variable and not promised
    const rateRisk = root.findByProps({ testID: 'savings-risk-variable-rate' });
    expect(collectText(rateRisk)).toMatch(/rate is variable and not promised/i);

    // 3. A fully utilised pool cannot pay out immediately
    const utilizationRisk = root.findByProps({ testID: 'savings-risk-pool-utilization' });
    expect(collectText(utilizationRisk)).toMatch(/fully utilised pool cannot pay out immediately/i);
  });

  it('shows rates as observed-now with a timestamp and never as a promise or annualised guarantee', async () => {
    // Unit-check the formatter with a deterministic timestamp
    const formatted = formatObservedRate(0.0485, '2026-11-20T10:00:00.000Z');
    expect(formatted).toBe('4.85% observed at 2026-11-20T10:00:00Z (variable, not promised)');

    const root = await renderEarn();
    const screenText = collectText(root);

    // Observed rate with ISO timestamp is shown on the pools view
    const usdcRate = root.findByProps({ testID: 'reserve-rate-USDC' });
    expect(collectText(usdcRate)).toMatch(/4\.85% observed at \d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z/);
    expect(collectText(usdcRate)).toMatch(/variable, not promised/);

    // No rate is shown as a promise, guarantee, or annual projection
    expect(screenText).not.toMatch(/guaranteed/i);
    expect(screenText).not.toMatch(/annual return/i);
    expect(screenText).not.toMatch(/Est\. earned in 1 year/i);
    expect(screenText).not.toMatch(/a year at today's rate/i);
    expect(screenText).not.toMatch(/Nothing is locked, withdraw any time/i);
  });

  it('renders the shared SavingsRiskDisclosure component before the deposit action is reachable on both the pool list and the deposit form', async () => {
    const root = await renderEarn();

    // Shared component is mounted on the initial pools view
    const disclosuresOnPools = root.findAllByType(SavingsRiskDisclosure);
    expect(disclosuresOnPools.length).toBeGreaterThanOrEqual(1);

    const nodesOnPools = flattenNodes(root);
    const disclosureNodeOnPools = root.findByProps({ testID: 'savings-risk-disclosure' });
    const depositButtonsOnPools = nodesOnPools.filter(
      (n) => n.props?.label === 'Deposit' && typeof n.props?.onPress === 'function',
    );
    expect(depositButtonsOnPools.length).toBeGreaterThan(0);

    // Assert the disclosure renders earlier in the tree than every Deposit button
    const disclosureIdxPools = nodesOnPools.indexOf(disclosureNodeOnPools);
    const firstDepositBtnIdxPools = nodesOnPools.indexOf(depositButtonsOnPools[0]);
    expect(disclosureIdxPools).toBeGreaterThanOrEqual(0);
    expect(firstDepositBtnIdxPools).toBeGreaterThan(disclosureIdxPools);

    // Open the deposit form (or reach it via deep-link / agent prefill)
    await renderer.act(async () => {
      (depositButtonsOnPools[0].props.onPress as () => void)();
    });

    // Shared component is also rendered on the deposit form before the submit action
    const disclosuresOnForm = root.findAllByType(SavingsRiskDisclosure);
    expect(disclosuresOnForm.length).toBe(1);

    const nodesOnForm = flattenNodes(root);
    const disclosureNodeOnForm = root.findByProps({ testID: 'savings-risk-disclosure' });
    const submitWrapperOnForm = root.findByProps({ testID: 'deposit-submit-button' });

    const disclosureIdxForm = nodesOnForm.indexOf(disclosureNodeOnForm);
    const submitIdxForm = nodesOnForm.indexOf(submitWrapperOnForm);
    expect(disclosureIdxForm).toBeGreaterThanOrEqual(0);
    expect(submitIdxForm).toBeGreaterThan(disclosureIdxForm);

    // And the deposit form rate is also observed-now with timestamp
    const formRate = root.findByProps({ testID: 'deposit-form-observed-rate' });
    expect(collectText(formRate)).toMatch(/4\.85% observed at \d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z/);
    expect(collectText(formRate)).toContain(SAVINGS_DISCLOSURE.risks[1].id ? 'variable, not promised' : '');
  });
});
