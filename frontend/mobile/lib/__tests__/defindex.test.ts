import AsyncStorage from '@react-native-async-storage/async-storage';
import {
  Account,
  Address,
  Keypair,
  Networks,
  StrKey,
  Transaction,
  TransactionBuilder,
  nativeToScVal,
  rpc as SorobanRpc,
  scValToNative,
  xdr,
} from '@stellar/stellar-sdk';

import {
  assertValidContractAddress,
  DEFAULT_DEFINDEX_VAULT_CONTRACTS,
  getDefindexVaultConfig,
} from '../../config/defindex';
import {
  STROOPS_PER_UNIT,
  buildDefindexDepositXdr,
  buildDefindexWithdrawXdr,
  detectStrategyDrift,
  formatBps,
  formatStroops,
  getSavedStrategies,
  loadDefindexUserPosition,
  loadDefindexVaultState,
  parseToStroops,
  saveCurrentStrategies,
  submitDefindexTransaction,
} from '../defindex';

// ── Mocks ────────────────────────────────────────────────────────────────────

const MOCK_FEE_PAYER = Keypair.fromRawEd25519Seed(Buffer.alloc(32, 0x12)).publicKey();
const VALID_VAULT = 'CCA2ZJP5BVRXYTQH4FAGHCAUMRYCXVC4CRYC2NXHWMR7TIVX36U7F5HR';
const VALID_USER = 'CBXBQ7SI5UOCDFGUKBAQS4HIZOUSVTSJYY4L2ZJRBHIYCKDDC3PQ3QTB';
const STRATEGY_FIXED = 'CDB2WMKQQNVZMEBY7Q7GZ5C7E7IAFSNMZ7GGVD6WKTCEWK7XOIAVZSAP';
const STRATEGY_YIELDBLOX = 'CCSRX5E4337QMCMC3KO3RDFYI57T5NZV5XB3W3TWE4USCASKGL5URKJL';

jest.mock('../activity', () => ({
  getFeePayerAddress: jest.fn(async () => MOCK_FEE_PAYER),
}));

jest.mock('../network', () => ({
  getNetwork: jest.fn(() => ({
    name: 'testnet',
    networkPassphrase: 'Test SDF Network ; September 2015',
    rpcUrl: 'https://soroban-testnet.stellar.org',
    horizonUrl: 'https://horizon-testnet.stellar.org',
  })),
}));

const mockSignXdrPayload = jest.fn();
jest.mock('../walletConnect', () => ({
  signXdrPayload: (xdrStr: string) => mockSignXdrPayload(xdrStr),
}));

const mockUnregisterPasskeySigner = jest.fn();
const mockRegisterPasskeySigner = jest.fn(() => mockUnregisterPasskeySigner);
jest.mock('../passkey', () => ({
  registerPasskeySigner: () => mockRegisterPasskeySigner(),
  requirePasskey: jest.fn(async () => true),
}));

const mockPollForResult = jest.fn();
jest.mock('../sendPayment', () => ({
  pollForResult: (...args: unknown[]) => mockPollForResult(...args),
}));

function getFunctionName(tx: any): string {
  try {
    const op = tx.operations[0];
    if (op.func && typeof op.func.value === 'function') {
      return op.func.value().functionName().toString();
    }
  } catch {}
  return '';
}

describe('DeFindex Vault mobile integration', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  // ── 1. Contract Address Validation & Config ───────────────────────────────────

  describe('Contract address validation & config', () => {
    it('accepts valid 56-character C... contract addresses', () => {
      expect(assertValidContractAddress(VALID_VAULT)).toBe(VALID_VAULT);
      expect(assertValidContractAddress(STRATEGY_FIXED)).toBe(STRATEGY_FIXED);
    });

    it('rejects classic Stellar G... account addresses with descriptive error', () => {
      expect(() => assertValidContractAddress(MOCK_FEE_PAYER)).toThrow(
        /Expected a valid 56-character Stellar contract ID starting with 'C'/,
      );
    });

    it('rejects malformed, empty or invalid strings', () => {
      expect(() => assertValidContractAddress('')).toThrow(/Invalid DeFindex vault contract address/);
      expect(() => assertValidContractAddress('not-an-address')).toThrow(/Invalid DeFindex vault contract address/);
      expect(() => assertValidContractAddress('C123')).toThrow(/Invalid DeFindex vault contract address/);
    });

    it('returns network config with verified contract address and 0 bps Veil fee', () => {
      const config = getDefindexVaultConfig('mainnet');
      expect(config.vaultAddress).toBe(DEFAULT_DEFINDEX_VAULT_CONTRACTS.mainnet);
      expect(config.name).toBe('DeFindex USDC Vault');
      expect(config.symbol).toBe('dfUSDC');
      expect(config.veilFeeBps).toBe(0);
    });
  });

  // ── 2. Parsing & Formatting ──────────────────────────────────────────────────

  describe('Parsing and formatting helpers', () => {
    it('parses valid decimal amounts to stroops', () => {
      expect(parseToStroops('1')).toBe(10_000_000n);
      expect(parseToStroops('10.5')).toBe(105_000_000n);
      expect(parseToStroops('0.0000001')).toBe(1n);
    });

    it('rejects invalid or zero amounts', () => {
      expect(() => parseToStroops('0')).toThrow(/Amount must be greater than zero/);
      expect(() => parseToStroops('-5')).toThrow(/Enter a valid amount/);
      expect(() => parseToStroops('1.12345678')).toThrow(/no more than 7 decimal places/);
      expect(() => parseToStroops('abc')).toThrow(/Enter a valid amount/);
    });

    it('formats stroops into decimal string', () => {
      expect(formatStroops(10_000_000n)).toBe('1.00');
      expect(formatStroops(105_000_000n)).toBe('10.50');
      expect(formatStroops(0n)).toBe('0.00');
    });

    it('formats basis points to percentage display', () => {
      expect(formatBps(1809)).toBe('18.09%');
      expect(formatBps(2000)).toBe('20.00%');
      expect(formatBps(0)).toBe('0.00%');
    });
  });

  // ── 3. Strategy Drift Detection ──────────────────────────────────────────────

  describe('Strategy drift detection', () => {
    it('returns false when previously seen strategies match current strategies', () => {
      const prev = [STRATEGY_FIXED, STRATEGY_YIELDBLOX];
      const curr = [STRATEGY_YIELDBLOX, STRATEGY_FIXED]; // order independent
      expect(detectStrategyDrift(prev, curr)).toBe(false);
    });

    it('detects strategy change when a strategy is added, removed or rebalanced', () => {
      const prev = [STRATEGY_FIXED];
      const curr = [STRATEGY_FIXED, STRATEGY_YIELDBLOX];
      expect(detectStrategyDrift(prev, curr)).toBe(true);

      const differentStrategy = 'CAUK4MWO3TTFM6PLURSH2GPK3AB747SZGABKTCVLKCU7W2MGKHKP35GA';
      expect(detectStrategyDrift([STRATEGY_FIXED], [differentStrategy])).toBe(true);
    });

    it('persists and restores strategies across sessions', async () => {
      const strategies = [STRATEGY_FIXED, STRATEGY_YIELDBLOX];
      await saveCurrentStrategies(VALID_VAULT, strategies);
      const loaded = await getSavedStrategies(VALID_VAULT);
      expect(loaded).toEqual(strategies);
    });
  });

  // ── 4. Vault State & Simulation ──────────────────────────────────────────────

  describe('loadDefindexVaultState', () => {
    it('successfully decodes vault state, single strategy notice, and fees', async () => {
      const mockFunds = [
        {
          asset: 'CCW67TSZV3SSS2HXMBQ5JFGCKJNXKZM7UQUWUZPUTHXSTZLEO7SJMI75',
          idle_amount: 10_000_000n,
          invested_amount: 100_000_000n,
          strategy_allocations: [
            {
              amount: 100_000_000n,
              paused: false,
              strategy_address: STRATEGY_FIXED,
            },
            {
              amount: 0n,
              paused: false,
              strategy_address: STRATEGY_YIELDBLOX,
            },
          ],
          total_amount: 110_000_000n,
        },
      ];

      const mockAssets = [
        {
          address: 'CCW67TSZV3SSS2HXMBQ5JFGCKJNXKZM7UQUWUZPUTHXSTZLEO7SJMI75',
          strategies: [
            {
              address: STRATEGY_FIXED,
              name: 'USDC Autocompound Blend Fixed',
              paused: false,
            },
            {
              address: STRATEGY_YIELDBLOX,
              name: 'USDC Autocompound Blend YieldBlox',
              paused: false,
            },
          ],
        },
      ];

      jest.spyOn(SorobanRpc.Server.prototype, 'simulateTransaction').mockImplementation(
        async (tx: any) => {
          const fnName = getFunctionName(tx);
          let val: xdr.ScVal = xdr.ScVal.scvVoid();

          if (fnName === 'get_manager') {
            val = nativeToScVal(VALID_USER, { type: 'address' });
          } else if (fnName === 'get_emergency_manager') {
            val = nativeToScVal(MOCK_FEE_PAYER, { type: 'address' });
          } else if (fnName === 'get_fees') {
            val = nativeToScVal([1809, 2000]);
          } else if (fnName === 'get_assets') {
            val = nativeToScVal(mockAssets);
          } else if (fnName === 'fetch_total_managed_funds') {
            val = nativeToScVal(mockFunds);
          } else if (fnName === 'total_supply') {
            val = nativeToScVal(100_000_000n, { type: 'i128' });
          }

          return {
            result: { retval: val },
          } as any;
        },
      );

      const state = await loadDefindexVaultState(VALID_VAULT);
      expect(state.vaultAddress).toBe(VALID_VAULT);
      expect(state.manager).toBe(VALID_USER);
      expect(state.vaultFeeBps).toBe(1809);
      expect(state.veilFeeBps).toBe(0);
      expect(state.sharePrice).toBe(1.1); // 110m total / 100m shares
      expect(state.isPaused).toBe(false);
      expect(state.isEmptied).toBe(false);
      expect(state.singleStrategyNotice).toBe('Single strategy: Blend USDC Fixed pool');
      expect(state.strategies).toHaveLength(2);
      expect(state.strategies[0].name).toBe('USDC Autocompound Blend Fixed');
    });

    it('covers a paused vault properly', async () => {
      const mockFunds = [
        {
          asset: 'CCW67TSZV3SSS2HXMBQ5JFGCKJNXKZM7UQUWUZPUTHXSTZLEO7SJMI75',
          idle_amount: 0n,
          invested_amount: 50_000_000n,
          strategy_allocations: [
            {
              amount: 50_000_000n,
              paused: true, // Emergency paused
              strategy_address: STRATEGY_FIXED,
            },
          ],
          total_amount: 50_000_000n,
        },
      ];

      jest.spyOn(SorobanRpc.Server.prototype, 'simulateTransaction').mockImplementation(
        async (tx: any) => {
          const fnName = getFunctionName(tx);
          if (fnName === 'fetch_total_managed_funds') {
            return { result: { retval: nativeToScVal(mockFunds) } } as any;
          }
          if (fnName === 'total_supply') {
            return { result: { retval: nativeToScVal(50_000_000n, { type: 'i128' }) } } as any;
          }
          return { result: { retval: xdr.ScVal.scvVoid() } } as any;
        },
      );

      const state = await loadDefindexVaultState(VALID_VAULT);
      expect(state.isPaused).toBe(true);
    });

    it('covers an emptied vault (0 TVL, 0 shares)', async () => {
      const mockFunds = [
        {
          asset: 'CCW67TSZV3SSS2HXMBQ5JFGCKJNXKZM7UQUWUZPUTHXSTZLEO7SJMI75',
          idle_amount: 0n,
          invested_amount: 0n,
          strategy_allocations: [],
          total_amount: 0n,
        },
      ];

      jest.spyOn(SorobanRpc.Server.prototype, 'simulateTransaction').mockImplementation(
        async (tx: any) => {
          const fnName = getFunctionName(tx);
          if (fnName === 'fetch_total_managed_funds') {
            return { result: { retval: nativeToScVal(mockFunds) } } as any;
          }
          if (fnName === 'total_supply') {
            return { result: { retval: nativeToScVal(0n, { type: 'i128' }) } } as any;
          }
          return { result: { retval: xdr.ScVal.scvVoid() } } as any;
        },
      );

      const state = await loadDefindexVaultState(VALID_VAULT);
      expect(state.isEmptied).toBe(true);
      expect(state.sharePrice).toBe(1.0);
    });
  });

  // ── 5. User Position ────────────────────────────────────────────────────────

  describe('loadDefindexUserPosition', () => {
    it('covers a zero-share position cleanly without crashing', async () => {
      jest.spyOn(SorobanRpc.Server.prototype, 'simulateTransaction').mockResolvedValue({
        result: { retval: nativeToScVal(0n, { type: 'i128' }) },
      } as any);

      const pos = await loadDefindexUserPosition(VALID_VAULT, VALID_USER);
      expect(pos.shares).toBe(0n);
      expect(pos.sharesFormatted).toBe('0.00');
      expect(pos.underlyingAmount).toBe(0n);
      expect(pos.underlyingFormatted).toBe('0.00');
      expect(pos.sharePrice).toBe(1.0);
    });

    it('calculates underlying value and share price for a non-zero position', async () => {
      jest.spyOn(SorobanRpc.Server.prototype, 'simulateTransaction').mockImplementation(
        async (tx: any) => {
          const fnName = getFunctionName(tx);
          if (fnName === 'balance') {
            return { result: { retval: nativeToScVal(10_000_000n, { type: 'i128' }) } } as any;
          }
          if (fnName === 'get_asset_amounts_per_shares') {
            return { result: { retval: nativeToScVal([10_899_593n]) } } as any;
          }
          return { result: { retval: xdr.ScVal.scvVoid() } } as any;
        },
      );

      const pos = await loadDefindexUserPosition(VALID_VAULT, VALID_USER);
      expect(pos.shares).toBe(10_000_000n);
      expect(pos.sharesFormatted).toBe('1.00');
      expect(pos.underlyingAmount).toBe(10_899_593n);
      expect(pos.underlyingFormatted).toBe('1.09');
      expect(pos.sharePrice).toBeCloseTo(1.0899593);
    });
  });

  // ── 6. Transaction Building ──────────────────────────────────────────────────

  describe('buildDefindexDepositXdr and buildDefindexWithdrawXdr', () => {
    beforeEach(() => {
      jest.spyOn(SorobanRpc.Server.prototype, 'getAccount').mockResolvedValue(
        new Account(MOCK_FEE_PAYER, '100'),
      );
    });

    it('builds deposit XDR with valid parameters and fee payer source', async () => {
      const xdrString = await buildDefindexDepositXdr({
        vaultAddress: VALID_VAULT,
        userAddress: VALID_USER,
        amountStroops: 25_000_000n,
      });

      expect(typeof xdrString).toBe('string');
      const tx = TransactionBuilder.fromXDR(xdrString, Networks.TESTNET) as Transaction;
      expect(tx.source).toBe(MOCK_FEE_PAYER);
      expect(tx.operations).toHaveLength(1);
      const op = tx.operations[0] as any;
      expect(op.type).toBe('invokeHostFunction');
    });

    it('builds withdraw XDR with valid parameters and fee payer source', async () => {
      const xdrString = await buildDefindexWithdrawXdr({
        vaultAddress: VALID_VAULT,
        userAddress: VALID_USER,
        shareAmountStroops: 15_000_000n,
      });

      expect(typeof xdrString).toBe('string');
      const tx = TransactionBuilder.fromXDR(xdrString, Networks.TESTNET) as Transaction;
      expect(tx.source).toBe(MOCK_FEE_PAYER);
      expect(tx.operations).toHaveLength(1);
    });

    it('rejects invalid vault addresses when building XDR', async () => {
      await expect(
        buildDefindexDepositXdr({
          vaultAddress: 'invalid-vault',
          userAddress: VALID_USER,
          amountStroops: 10_000_000n,
        }),
      ).rejects.toThrow(/Invalid DeFindex vault contract address/);
    });
  });

  // ── 7. Signing & Submission Ceremony ─────────────────────────────────────────

  describe('submitDefindexTransaction', () => {
    it('signs exclusively through signXdrPayload and registers/unregisters passkey signer', async () => {
      const mockTx = new TransactionBuilder(new Account(MOCK_FEE_PAYER, '100'), {
        fee: '100',
        networkPassphrase: Networks.TESTNET,
      })
        .setTimeout(30)
        .build();

      const rawXdr = mockTx.toXDR();
      mockSignXdrPayload.mockResolvedValue(rawXdr);
      mockPollForResult.mockResolvedValue('dummy-tx-hash-123');

      jest.spyOn(SorobanRpc.Server.prototype, 'sendTransaction').mockResolvedValue({
        status: 'PENDING',
        hash: 'dummy-tx-hash-123',
      } as any);

      const resultHash = await submitDefindexTransaction(rawXdr);

      // Verified signing pipeline:
      expect(mockRegisterPasskeySigner).toHaveBeenCalledTimes(1);
      expect(mockSignXdrPayload).toHaveBeenCalledWith(rawXdr);
      expect(mockPollForResult).toHaveBeenCalledWith(expect.any(Object), 'dummy-tx-hash-123');
      expect(resultHash).toBe('dummy-tx-hash-123');
      expect(mockUnregisterPasskeySigner).toHaveBeenCalledTimes(1);
    });

    it('cleans up passkey signer registration if signXdrPayload or submission throws', async () => {
      mockSignXdrPayload.mockRejectedValue(new Error('User declined passkey'));

      await expect(submitDefindexTransaction('some-xdr')).rejects.toThrow(
        /User declined passkey/,
      );

      expect(mockRegisterPasskeySigner).toHaveBeenCalledTimes(1);
      expect(mockUnregisterPasskeySigner).toHaveBeenCalledTimes(1);
    });
  });
});
