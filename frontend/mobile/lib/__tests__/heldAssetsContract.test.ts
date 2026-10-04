/**
 * The trustlines screen on a smart wallet.
 *
 * A Veil wallet's address is a CONTRACT. Horizon only knows classic accounts,
 * so handing it a C-address fails every time — which is why the Assets screen
 * showed the bare word "Unknown" on precisely the wallets the app creates, and
 * went on failing once a retry was added around it.
 *
 * Trustlines live on the classic account either way: a contract holds issued
 * assets as SAC contract storage and needs no trustline at all. So the account
 * to read is the fee payer.
 */

// `mock`-prefixed so jest.mock's factory may close over them.
const mockLoadAccount = jest.fn();
const mockGetFeePayer = jest.fn();

jest.mock('@stellar/stellar-sdk', () => {
  const actual = jest.requireActual('@stellar/stellar-sdk');
  return {
    ...actual,
    Horizon: { ...actual.Horizon, Server: jest.fn(() => ({ loadAccount: mockLoadAccount })) },
  };
});

jest.mock('../activity', () => ({ getFeePayerAddress: () => mockGetFeePayer() }));

jest.mock('../network', () => ({
  getNetwork: () => ({ name: 'mainnet', horizonUrl: 'https://horizon.example' }),
  getNetworkName: () => 'mainnet',
}));

import { classicAccountExists, fetchHeldAssets } from '../assets';

// A real contract id (USDT0's SAC). StrKey checksums these, so an invented
// C-address silently fails `isValidContract` and the test passes for the wrong
// reason — this one caught exactly that.
const CONTRACT = 'CBSJZEIO5C7KC2SF3MKSNXXJSW5G3VTNBX4ATMKUI3B2MR4JKM4R26YF';
const FEE_PAYER = 'GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN';

const BALANCES = [
  { asset_type: 'native', balance: '12.0000000' },
  {
    asset_type: 'credit_alphanum4',
    asset_code: 'USDC',
    asset_issuer: 'GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN',
    balance: '5.0000000',
  },
];

describe('fetchHeldAssets with a contract wallet', () => {
  beforeEach(() => {
    mockLoadAccount.mockReset();
    mockGetFeePayer.mockReset();
  });

  it('reads the fee payer, never the contract address', async () => {
    mockGetFeePayer.mockResolvedValue(FEE_PAYER);
    mockLoadAccount.mockResolvedValue({ balances: BALANCES });

    const held = await fetchHeldAssets(CONTRACT);

    // The whole bug in one assertion. Horizon must never be asked about a
    // C-address; it cannot answer and the screen dies on the error.
    expect(mockLoadAccount).toHaveBeenCalledWith(FEE_PAYER);
    expect(mockLoadAccount).not.toHaveBeenCalledWith(CONTRACT);
    expect(held.map((a) => a.code)).toContain('USDC');
  });

  it('reports no trustlines, not an error, when no fee payer is stored', async () => {
    mockGetFeePayer.mockResolvedValue(null);

    await expect(fetchHeldAssets(CONTRACT)).resolves.toEqual([]);
    // No classic account exists yet, so there is nothing to ask Horizon about.
    expect(mockLoadAccount).not.toHaveBeenCalled();
  });

  it('still reads a classic address directly', async () => {
    mockLoadAccount.mockResolvedValue({ balances: BALANCES });

    await fetchHeldAssets(FEE_PAYER);

    expect(mockGetFeePayer).not.toHaveBeenCalled();
    expect(mockLoadAccount).toHaveBeenCalledWith(FEE_PAYER);
  });

  it('retries once, then names the host and the cause', async () => {
    const bare = new Error('');
    bare.name = 'Unknown';
    mockLoadAccount.mockRejectedValue(bare);

    // The message must name the host it failed against AND carry the cause, so
    // a screenshot of it is enough to tell "Horizon is down" from "we asked the
    // wrong question". A flat sentence reads the same for both.
    await expect(fetchHeldAssets(FEE_PAYER)).rejects.toThrow(/horizon\.example/);
    await expect(fetchHeldAssets(FEE_PAYER)).rejects.toThrow(/Unknown/);
    expect(mockLoadAccount).toHaveBeenCalledTimes(4);
  });

  it('recognises NotFoundError even when it is not an Error instance', async () => {
    // The shape that actually arrives on device. The stellar-sdk's NotFoundError
    // extends Error, and a class extending a built-in loses its prototype chain
    // once Babel has compiled it for Hermes — so `instanceof Error` is false
    // while `name` is still exactly 'NotFoundError'. Gating on instanceof is why
    // this screen reported a missing account as a hard failure while the
    // dashboard, with the same check minus the gate, handled it.
    const hermesShape = { name: 'NotFoundError', message: 'Resource not found' };
    mockLoadAccount.mockRejectedValue(hermesShape);

    await expect(fetchHeldAssets(FEE_PAYER)).resolves.toEqual([]);
    expect(mockLoadAccount).toHaveBeenCalledTimes(1);
    expect(classicAccountExists()).toBe(false);
  });

  it('recognises a bare 404 from the HTTP layer', async () => {
    mockLoadAccount.mockRejectedValue({ response: { status: 404 } });

    await expect(fetchHeldAssets(FEE_PAYER)).resolves.toEqual([]);
    expect(classicAccountExists()).toBe(false);
  });

  it('reports the account as existing after a successful read', async () => {
    mockLoadAccount.mockResolvedValue({ balances: BALANCES });

    await fetchHeldAssets(FEE_PAYER);

    expect(classicAccountExists()).toBe(true);
  });

  it('treats a missing account as an empty portfolio', async () => {
    const notFound = new Error('not found');
    notFound.name = 'NotFoundError';
    mockLoadAccount.mockRejectedValue(notFound);

    await expect(fetchHeldAssets(FEE_PAYER)).resolves.toEqual([]);
    // Definitive answer: no retry needed.
    expect(mockLoadAccount).toHaveBeenCalledTimes(1);
  });
});
