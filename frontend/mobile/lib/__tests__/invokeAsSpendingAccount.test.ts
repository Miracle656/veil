/**
 * `invokeAsSpendingAccount`: a contract call signed by the spending account's
 * own key, with no passkey. What must hold is that it never signs as an
 * account other than the one the screen read the gate and the balance for.
 */

import {
  Keypair,
  StrKey,
  TransactionBuilder,
  nativeToScVal,
  scValToNative,
} from '@stellar/stellar-sdk';

import { invokeAsSpendingAccount } from '../contractInvoke';
import { signAndSubmitSorobanXdr } from '../sorobanTx';
import { getSignerSecret } from '../walletStore';

const PASSPHRASE = 'Test SDF Network ; September 2015';

jest.mock('../activity', () => ({ getFeePayerAddress: jest.fn() }));
jest.mock('../passkey', () => ({ registerPasskeySigner: jest.fn() }));
jest.mock('../sendPayment', () => ({ pollForResult: jest.fn() }));
jest.mock('../walletConnect', () => ({ signXdrPayload: jest.fn() }));
jest.mock('../walletStore', () => ({ getSignerSecret: jest.fn() }));
jest.mock('../sorobanTx', () => ({ signAndSubmitSorobanXdr: jest.fn() }));
jest.mock('../fees', () => ({ inclusionFee: () => '100' }));
jest.mock('../network', () => ({
  getNetwork: () => ({
    name: 'testnet',
    rpcUrl: 'https://rpc.invalid',
    horizonUrl: 'https://horizon.invalid',
    networkPassphrase: 'Test SDF Network ; September 2015',
  }),
}));

const secretOnDevice = getSignerSecret as jest.MockedFunction<typeof getSignerSecret>;
const submit = signAndSubmitSorobanXdr as jest.MockedFunction<typeof signAndSubmitSorobanXdr>;

// Generated per run: nothing here is a real account.
const spending = Keypair.random();
const other = Keypair.random();
const CONTRACT = StrKey.encodeContract(Buffer.alloc(32, 3));
const args = [
  nativeToScVal(spending.publicKey(), { type: 'address' }),
  nativeToScVal(12, { type: 'u32' }),
];

const call = () =>
  invokeAsSpendingAccount(spending.publicKey(), CONTRACT, 'buy', args, 'Veil-ian purchase');

beforeEach(() => {
  secretOnDevice.mockReset();
  submit.mockReset();
  submit.mockResolvedValue('hash');
});

it('sends nothing when there is no spending account on the device', async () => {
  secretOnDevice.mockResolvedValue(null);

  await expect(call()).rejects.toThrow(/No spending account/);
  expect(submit).not.toHaveBeenCalled();
});

it('sends nothing when the key on the device is a different account', async () => {
  secretOnDevice.mockResolvedValue(other.secret());

  await expect(call()).rejects.toThrow(/has changed/);
  expect(submit).not.toHaveBeenCalled();
});

it('hands over one call, from the spending account, signed with its key', async () => {
  secretOnDevice.mockResolvedValue(spending.secret());

  await expect(call()).resolves.toBe('hash');

  expect(submit).toHaveBeenCalledTimes(1);
  const sent = submit.mock.calls[0][0];
  expect(sent.signerSecret).toBe(spending.secret());
  expect(sent.flow).toBe('Veil-ian purchase');
  expect(sent.networkPassphrase).toBe(PASSPHRASE);

  const tx = TransactionBuilder.fromXDR(sent.xdr, PASSPHRASE);
  if ('innerTransaction' in tx) throw new Error('expected a plain transaction');
  expect(tx.source).toBe(spending.publicKey());
  expect(tx.operations).toHaveLength(1);

  const op = tx.operations[0];
  if (op.type !== 'invokeHostFunction') throw new Error(`unexpected operation ${op.type}`);
  const invoke = op.func.invokeContract();
  expect(StrKey.encodeContract(Buffer.from(invoke.contractAddress().contractId() as never))).toBe(
    CONTRACT
  );
  expect(invoke.functionName().toString()).toBe('buy');
  expect(invoke.args().map((a) => scValToNative(a))).toEqual([spending.publicKey(), 12]);
  // No auth entries of its own: the source account's signature is the auth.
  expect(op.auth ?? []).toHaveLength(0);
});
