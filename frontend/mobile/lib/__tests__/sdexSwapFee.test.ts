/**
 * #1201 — a Veil fee riding on a classic SDEX swap must never be the reason
 * the swap fails.
 *
 * These drive `sdexSwap` end to end against a stubbed Horizon and assert what
 * actually goes on chain, at the two edges where an account spending to its
 * last stroop cannot carry the fee:
 *
 *   • affordable swap + fee, but not the inclusion bid for the transaction's
 *     real operation count (the fee op is one more than the swap's own);
 *   • affordable swap + fee + bid, but not the 0.5 XLM subentry the trustline
 *     this same transaction adds will lock.
 *
 * In both, the swap must GO OUT — feeless — and resolve with a hash. A red
 * assertion here means the whole swap died with txINSUFFICIENT_BALANCE over a
 * charge nobody asked for.
 */

import { Keypair, Networks } from '@stellar/stellar-sdk';

import { sdexSwap } from '../sdexSwap';

const TREASURY = 'GDYAZCT2QZZEEOG3WXBRF6IQNUVSUR3V5RW6M4RVMWGDWH3PWCSWYEF4';
const USDC_TESTNET_ISSUER = 'GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5';
const TX_HASH = 'a'.repeat(64);

const mockSubmitTransaction = jest.fn();
const mockLoadAccount = jest.fn();
const mockStrictSendPathsCall = jest.fn();
const mockFetchPlatformFee = jest.fn();

let signerSecret: string;
let signerPubKey: string;

beforeAll(() => {
  const kp = Keypair.random();
  signerSecret = kp.secret();
  signerPubKey = kp.publicKey();
});

// Pinned testnet: a checkout whose .env sets EXPO_PUBLIC_NETWORK=mainnet must
// not decide which registry the USDC fixture resolves against. Literals only —
// a jest.mock factory cannot close over an import.
jest.mock('../network', () => ({
  getNetwork: () => ({
    name: 'testnet',
    displayName: 'Stellar Testnet',
    networkPassphrase: 'Test SDF Network ; September 2015',
    horizonUrl: 'https://horizon-testnet.stellar.org',
    rpcUrl: 'https://soroban-testnet.stellar.org',
    // The deployed testnet passkey-wallet factory — the same id lib/network pins.
    factoryContractId: 'CAUK4MWO3TTFM6PLURSH2GPK3AB747SZGABKTCVLKCU7W2MGKHKP35GA',
    friendbotUrl: 'https://friendbot.stellar.org',
  }),
}));
// 100 stroops per operation: the fee op must add 0.00001 XLM to what the
// account has to be able to cover.
jest.mock('../fees', () => ({ inclusionFee: () => '100' }));
jest.mock('../feePayerCheck', () => ({
  assertFeePayerCanCoverFee: jest.fn(async () => undefined),
}));
jest.mock('../platformFee', () => ({
  fetchPlatformFee: (...args: unknown[]) => mockFetchPlatformFee(...args),
}));
jest.mock('@stellar/stellar-sdk', () => {
  const actual = jest.requireActual('@stellar/stellar-sdk');
  const MockServer = jest.fn().mockImplementation(() => ({
    strictSendPaths: () => ({ call: (...args: unknown[]) => mockStrictSendPathsCall(...args) }),
    loadAccount: (...args: unknown[]) => mockLoadAccount(...args),
    submitTransaction: (...args: unknown[]) => mockSubmitTransaction(...args),
  }));
  return { ...actual, Horizon: { ...actual.Horizon, Server: MockServer } };
});

/** The order book answer for a 10 XLM → USDC path. */
function xlmToUsdcPath() {
  mockStrictSendPathsCall.mockResolvedValue({
    records: [
      {
        destination_asset_type: 'credit_alphanum4',
        destination_asset_code: 'USDC',
        destination_asset_issuer: USDC_TESTNET_ISSUER,
        destination_amount: '9.95',
        path: [],
      },
    ],
  });
}

/**
 * An account whose native XLM leaves `spendable` after the (2 + subentries) ×
 * 0.5 reserve — balance = spendable + 1 + 0.5 × subentries. `trusted` decides
 * whether the destination trustline already exists and so whether the swap
 * transaction adds the changeTrust that locks a further 0.5 XLM.
 */
function accountWithSpendable(spendable: string, { trusted }: { trusted: boolean }) {
  const subentries = trusted ? 2 : 1;
  const balance = (Number(spendable) + 1 + 0.5 * subentries).toFixed(7);
  const balances: Array<Record<string, string>> = [
    { asset_type: 'native', balance, selling_liabilities: '0' },
  ];
  if (trusted) {
    balances.push({
      asset_type: 'credit_alphanum4',
      asset_code: 'USDC',
      asset_issuer: USDC_TESTNET_ISSUER,
      balance: '1.0000000',
    });
  }
  return {
    accountId: () => signerPubKey,
    sequenceNumber: () => '100',
    incrementSequenceNumber: () => undefined,
    subentry_count: subentries,
    balances,
  };
}

const XLM = { code: 'XLM', issuer: null };
const USDC = { code: 'USDC', issuer: USDC_TESTNET_ISSUER };

/** Swaps 10 XLM for USDC from an account holding `spendable` spendable XLM. */
async function runSwap(spendable: string, trusted: boolean) {
  mockLoadAccount.mockResolvedValue(accountWithSpendable(spendable, { trusted }));
  mockSubmitTransaction.mockResolvedValue({ hash: TX_HASH });
  return sdexSwap({ signerSecret, from: XLM, amountIn: '10', to: USDC, slippageBps: 50 });
}

/** The transaction that was actually submitted. */
function submitted() {
  return mockSubmitTransaction.mock.calls[0][0] as {
    operations: Array<Record<string, unknown> & { type: string }>;
    networkPassphrase: string;
  };
}

beforeEach(() => {
  jest.clearAllMocks();
  xlmToUsdcPath();
  mockFetchPlatformFee.mockResolvedValue({
    amount: '0.1',
    assetCode: 'XLM',
    assetIssuer: null,
    destination: TREASURY,
  });
});

describe('sdexSwap attaches the Veil fee only within the full margin (#1201)', () => {
  it('sends the swap FEELESS when swap + fee fit but the inclusion bid for the real op count does not', async () => {
    // With the fee the transaction is changeTrust + pathPayment + payment and
    // must cover 3 bids: 10 + 0.1 + 3 × 0.00001 = 10.10003.
    // 10.1 covers the swap and the fee themselves — all the old check looked
    // at — and nothing else.
    await expect(runSwap('10.1000000', false)).resolves.toBe(TX_HASH);

    const tx = submitted();
    // changeTrust + pathPayment, NO fee payment. 3 here means the swap above
    // went out carrying a fee the account could not pay the network for.
    expect(tx.operations).toHaveLength(2);
    expect(tx.operations[0].type).toBe('changeTrust');
    expect(tx.operations[1].type).toBe('pathPaymentStrictSend');
    expect(tx.operations[1].sendAmount).toBe('10.0000000');
  });

  it('sends the swap FEELESS when swap + fee + bid fit but the new trustline reserve does not', async () => {
    // 10.6 clears 10 + 0.1 + 3 bids (10.10003) but not the further 0.5 XLM the
    // changeTrust this transaction makes locks: 10.60003.
    await expect(runSwap('10.6000000', false)).resolves.toBe(TX_HASH);

    const tx = submitted();
    expect(tx.operations).toHaveLength(2);
    expect(tx.operations[0].type).toBe('changeTrust');
    expect(tx.operations[1].type).toBe('pathPaymentStrictSend');
  });

  it('rides the fee along once the margin covers swap + fee + bid + new subentry', async () => {
    await expect(runSwap('10.6000300', false)).resolves.toBe(TX_HASH);

    const tx = submitted();
    expect(tx.operations).toHaveLength(3);
    expect(tx.operations[0].type).toBe('changeTrust');
    expect(tx.operations[1].type).toBe('pathPaymentStrictSend');
    // Appended, never prepended: the operations the user asked for apply first.
    expect(tx.operations[2].type).toBe('payment');
    expect(tx.operations[2].destination).toBe(TREASURY);
    expect((tx.operations[2].asset as { isNative(): boolean }).isNative()).toBe(true);
    expect(tx.operations[2].amount).toBe('0.1000000');
  });

  it('holds no trustline reserve once the account already trusts the destination', async () => {
    // 2 ops with the fee: 10 + 0.1 + 2 × 0.00001 = 10.10002.
    await expect(runSwap('10.1000200', true)).resolves.toBe(TX_HASH);

    const tx = submitted();
    expect(tx.operations).toHaveLength(2);
    expect(tx.operations[0].type).toBe('pathPaymentStrictSend');
    expect(tx.operations[1].type).toBe('payment');
    expect(tx.operations[1].destination).toBe(TREASURY);
  });

  it('prices the fee in the asset the swap is spending', async () => {
    await runSwap('20', false);
    expect(mockFetchPlatformFee).toHaveBeenCalledWith('XLM', 10);
  });

  it('never asks for a fee when the swap pays in an issued asset', async () => {
    mockStrictSendPathsCall.mockResolvedValue({
      records: [{ destination_asset_type: 'native', destination_amount: '9.95', path: [] }],
    });
    mockLoadAccount.mockResolvedValue(accountWithSpendable('20', { trusted: true }));
    mockSubmitTransaction.mockResolvedValue({ hash: TX_HASH });

    await sdexSwap({ signerSecret, from: USDC, amountIn: '5', to: XLM, slippageBps: 50 });

    expect(mockFetchPlatformFee).not.toHaveBeenCalled();
    const tx = submitted();
    expect(tx.operations).toHaveLength(1);
    expect(tx.operations[0].type).toBe('pathPaymentStrictSend');
  });

  it('goes out feeless when the fee service says nothing', async () => {
    mockFetchPlatformFee.mockResolvedValue(null);
    await expect(runSwap('20', false)).resolves.toBe(TX_HASH);
    expect(submitted().operations).toHaveLength(2);
  });

  it('signs the fee-carrying transaction for the network the swap runs on', async () => {
    await runSwap('20', false);
    // The fee check must not have changed how the transaction is built.
    expect(submitted().networkPassphrase).toBe(Networks.TESTNET);
  });
});
