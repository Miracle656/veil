/**
 * readSigners: how the app learns whether a wallet is deployed, and how it
 * tells "no wallet at this address" apart from "the network is down".
 *
 * Only the classification is unit-tested here; the passkey side of the address
 * sign-in is covered in passkeyLogin.test.ts. The RPC layer is faked, while
 * the transaction `get_signers` simulation is built for real so the test pins
 * down that readSigners genuinely asks the contract on chain.
 */

const mockSimulateTransaction = jest.fn();
const mockRpcServer = jest.fn();
const mockGetNetwork = jest.fn();

jest.mock('@stellar/stellar-sdk', () => {
  const actual = jest.requireActual('@stellar/stellar-sdk');
  return {
    ...actual,
    rpc: {
      ...actual.rpc,
      Server: jest.fn((...a: unknown[]) => mockRpcServer(...a)),
    },
  };
});
jest.mock('../network', () => ({
  getNetwork: () => mockGetNetwork(),
}));

import { rpc, xdr } from '@stellar/stellar-sdk';

import { readSigners, WalletContractNotFoundError } from '../signers';

const WALLET = 'CABCH3GZPGJOOZXPLN4EBXTLZSV6BUGFBXIKMNO2VJIPZ7ERENL7PCJ7';
const KEY = new Uint8Array(65).fill(7);
KEY[0] = 0x04;
const KEY_HEX = Buffer.from(KEY).toString('hex');

/** A Map<u32, BytesN<65>> ScVal as the wallet contract returns it. */
function signersScVal(entries: Array<[number, Uint8Array]>) {
  return xdr.ScVal.scvMap(
    entries.map(([index, key]) =>
      new xdr.ScMapEntry({ key: xdr.ScVal.scvU32(index), val: xdr.ScVal.scvBytes(Buffer.from(key)) }),
    ),
  );
}

beforeEach(() => {
  jest.resetAllMocks();
  // resetAllMocks() clears the implementations wired up above; re-arm the
  // RPC stub so `new Server()` hands signers a working simulateTransaction.
  (rpc.Server as unknown as jest.Mock).mockImplementation((...a: unknown[]) => mockRpcServer(...a));
  mockRpcServer.mockReturnValue({ simulateTransaction: (...a: unknown[]) => mockSimulateTransaction(...a) });
  mockGetNetwork.mockReturnValue({
    rpcUrl: 'https://rpc.example.test',
    networkPassphrase: 'Test SDF Network ; September 2015',
  });
});

describe('readSigners', () => {
  it('simulates get_signers against the given address', async () => {
    mockSimulateTransaction.mockResolvedValue({ error: 'MissingValue' });

    await expect(readSigners(WALLET)).rejects.toBeInstanceOf(WalletContractNotFoundError);
    expect(mockGetNetwork).toHaveBeenCalledTimes(1);
    expect(mockSimulateTransaction).toHaveBeenCalledTimes(1);
  });

  it('classifies a missing-contract diagnostic as a wallet that is not deployed', async () => {
    mockSimulateTransaction.mockResolvedValue({ error: 'MissingValue: contract not found' });

    await expect(readSigners(WALLET)).rejects.toBeInstanceOf(WalletContractNotFoundError);
  });

  it('leaves other simulation errors as ordinary failures, not a missing wallet', async () => {
    mockSimulateTransaction.mockResolvedValue({ error: 'HostError: internal error' });

    await expect(readSigners(WALLET)).rejects.not.toBeInstanceOf(WalletContractNotFoundError);
  });

  it('propagates a network failure as-is, never a missing wallet', async () => {
    mockSimulateTransaction.mockRejectedValue(new Error('Failed to fetch'));

    await expect(readSigners(WALLET)).rejects.toThrow('Failed to fetch');
    await expect(readSigners(WALLET)).rejects.not.toBeInstanceOf(WalletContractNotFoundError);
  });

  it('returns signers lowest index first, keys as lowercase hex', async () => {
    mockSimulateTransaction.mockResolvedValue({ result: { retval: signersScVal([[1, KEY], [0, KEY]]) } });

    await expect(readSigners(WALLET)).resolves.toEqual([
      { index: 0, publicKey: KEY_HEX },
      { index: 1, publicKey: KEY_HEX },
    ]);
  });
});