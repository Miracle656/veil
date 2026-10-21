import { Asset, Horizon, Keypair, Operation, Transaction } from '@stellar/stellar-sdk';
import { sdexSwap } from '../sdexSwap';
import * as platformFeeModule from '../platformFee';

const testKp = Keypair.random();
const G_SENDER = testKp.publicKey();
const G_TREASURY = 'GB3JS2AJZ3FKIGVOOPXDEYYR3XOHQA474WGCYAMNFSGX6OW5HGWCKUZW';
const USDC_ISSUER = 'GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN';

jest.mock('../feePayerCheck', () => ({
  assertFeePayerCanCoverFee: jest.fn(async () => undefined),
}));

describe('sdexSwap platform fee', () => {
  let mockStrictSendPaths: jest.Mock;
  let mockLoadAccount: jest.Mock;
  let mockSubmitTransaction: jest.Mock;
  let fetchPlatformFeeSpy: jest.SpyInstance;

  beforeEach(() => {
    mockStrictSendPaths = jest.fn().mockReturnValue({
      call: async () => ({
        records: [
          {
            destination_asset_type: 'credit_alphanum4',
            destination_asset_code: 'USDC',
            destination_asset_issuer: USDC_ISSUER,
            source_asset_type: 'native',
            destination_amount: '20.0000000',
            path: [],
          },
        ],
      }),
    });

    mockLoadAccount = jest.fn().mockImplementation(async () => {
      const acc = new Horizon.AccountResponse({
        id: G_SENDER,
        account_id: G_SENDER,
        sequence: '100',
        subentry_count: 0,
        balances: [
          { asset_type: 'native', balance: '100.0000000', buying_liabilities: '0', selling_liabilities: '0' },
          { asset_type: 'credit_alphanum4', asset_code: 'USDC', asset_issuer: USDC_ISSUER, balance: '50.0000000', limit: '10000', buying_liabilities: '0', selling_liabilities: '0', last_modified_ledger: 1 },
        ],
        thresholds: { low_threshold: 0, med_threshold: 0, high_threshold: 0 },
        flags: { auth_required: false, auth_revocable: false, auth_immutable: false, auth_clawback_enabled: false },
        signers: [{ key: G_SENDER, weight: 1, type: 'ed25519_public_key' }],
        data: {} as any,
      } as any);
      return acc;
    });

    mockSubmitTransaction = jest.fn().mockResolvedValue({ hash: 'mock-hash-12345' });

    jest.spyOn(Keypair, 'fromSecret').mockReturnValue(testKp);
    jest.spyOn(Horizon.Server.prototype, 'strictSendPaths').mockImplementation(mockStrictSendPaths);
    jest.spyOn(Horizon.Server.prototype, 'loadAccount').mockImplementation(mockLoadAccount);
    jest.spyOn(Horizon.Server.prototype, 'submitTransaction').mockImplementation(mockSubmitTransaction);

    fetchPlatformFeeSpy = jest.spyOn(platformFeeModule, 'fetchPlatformFee');
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('charges the quoted platform fee alongside the swap when affordable', async () => {
    fetchPlatformFeeSpy.mockResolvedValue({
      amount: '0.5',
      assetCode: 'XLM',
      assetIssuer: null,
      destination: G_TREASURY,
    });

    const hash = await sdexSwap({
      signerSecret: 'S...',
      from: { code: 'XLM', issuer: null },
      amountIn: '10',
      to: { code: 'USDC', issuer: USDC_ISSUER },
      slippageBps: 50,
    });

    expect(hash).toBe('mock-hash-12345');
    expect(fetchPlatformFeeSpy).toHaveBeenCalledWith('XLM', 10);
    expect(mockSubmitTransaction).toHaveBeenCalledTimes(1);

    const submittedTx: Transaction = mockSubmitTransaction.mock.calls[0][0];
    expect(submittedTx.operations.length).toBe(2);

    const swapOp = submittedTx.operations[0] as Operation.PathPaymentStrictSend;
    expect(swapOp.type).toBe('pathPaymentStrictSend');
    expect(swapOp.sendAmount).toBe('10.0000000');

    const feeOp = submittedTx.operations[1] as Operation.Payment;
    expect(feeOp.type).toBe('payment');
    expect(feeOp.destination).toBe(G_TREASURY);
    expect(feeOp.amount).toBe('0.5000000');
    expect(feeOp.asset.isNative()).toBe(true);
  });

  it('drops the fee without affecting the swap when the fee is unaffordable', async () => {
    // Only 10 XLM spendable, but swap requires 10 and fee requires 0.5
    mockLoadAccount.mockImplementation(async () => {
      const acc = new Horizon.AccountResponse({
        id: G_SENDER,
        account_id: G_SENDER,
        sequence: '100',
        subentry_count: 0, // Reserve is (2 + 0) * 0.5 = 1.0 XLM
        balances: [
          { asset_type: 'native', balance: '11.0000000', buying_liabilities: '0', selling_liabilities: '0' }, // 11 - 1.0 = 10.0 spendable
          { asset_type: 'credit_alphanum4', asset_code: 'USDC', asset_issuer: USDC_ISSUER, balance: '50.0000000', limit: '10000', buying_liabilities: '0', selling_liabilities: '0', last_modified_ledger: 1 },
        ],
        thresholds: { low_threshold: 0, med_threshold: 0, high_threshold: 0 },
        flags: { auth_required: false, auth_revocable: false, auth_immutable: false, auth_clawback_enabled: false },
        signers: [{ key: G_SENDER, weight: 1, type: 'ed25519_public_key' }],
        data: {} as any,
      } as any);
      return acc;
    });

    fetchPlatformFeeSpy.mockResolvedValue({
      amount: '0.5',
      assetCode: 'XLM',
      assetIssuer: null,
      destination: G_TREASURY,
    });

    const hash = await sdexSwap({
      signerSecret: 'S...',
      from: { code: 'XLM', issuer: null },
      amountIn: '10',
      to: { code: 'USDC', issuer: USDC_ISSUER },
      slippageBps: 50,
    });

    expect(hash).toBe('mock-hash-12345');
    expect(mockSubmitTransaction).toHaveBeenCalledTimes(1);

    const submittedTx: Transaction = mockSubmitTransaction.mock.calls[0][0];
    // Fee was unaffordable, so ONLY the swap operation is present
    expect(submittedTx.operations.length).toBe(1);
    expect(submittedTx.operations[0].type).toBe('pathPaymentStrictSend');
  });

  it('proceeds without fee if fetchPlatformFee returns null (e.g. backend down)', async () => {
    fetchPlatformFeeSpy.mockResolvedValue(null);

    const hash = await sdexSwap({
      signerSecret: 'S...',
      from: { code: 'XLM', issuer: null },
      amountIn: '10',
      to: { code: 'USDC', issuer: USDC_ISSUER },
      slippageBps: 50,
    });

    expect(hash).toBe('mock-hash-12345');
    const submittedTx: Transaction = mockSubmitTransaction.mock.calls[0][0];
    expect(submittedTx.operations.length).toBe(1);
    expect(submittedTx.operations[0].type).toBe('pathPaymentStrictSend');
  });
});
