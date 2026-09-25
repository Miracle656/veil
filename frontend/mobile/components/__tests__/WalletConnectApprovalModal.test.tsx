jest.mock('@stellar/stellar-sdk', () => ({
  Address: { fromScAddress: (value: string) => ({ toString: () => value }) },
  TransactionBuilder: { fromXDR: jest.fn() },
  scValToNative: (value: { native: unknown }) => value.native,
}));
jest.mock('../../lib/network', () => ({ getNetwork: () => ({ networkPassphrase: 'test', displayName: 'Testnet' }) }));
jest.mock('../../hooks/useWalletConnect', () => ({ useWalletConnect: () => ({ pendingRequests: [], sessions: [] }) }));
jest.mock('../../lib/passkey', () => ({ registerPasskeySigner: jest.fn() }));
jest.mock('../../lib/walletConnect', () => ({ approveWalletConnectRequest: jest.fn(), rejectWalletConnectRequest: jest.fn() }));
jest.mock('../../lib/walletConnectHelpers', () => ({ extractRequestXdr: (params: { xdr: string }) => params.xdr, isUserRejection: () => false }));

import { TransactionBuilder } from '@stellar/stellar-sdk';
import { parseRequestDetails } from '../WalletConnectApprovalModal';

const fromXDR = TransactionBuilder.fromXDR as jest.Mock;
const request = (xdr = 'AAAA') => ({ id: 1, topic: 'topic', method: 'stellar_signXDR', params: { xdr } });

function contractInvocation(name: string, nested: unknown[] = []) {
  return {
    function: () => ({
      contractFn: () => ({
        contractAddress: () => 'CINNER',
        functionName: () => name,
        args: () => [{ native: 'inner-arg' }],
      }),
    }),
    subInvocations: () => nested,
  };
}

describe('WalletConnectApprovalModal operation decoding', () => {
  it('lists every top-level operation', () => {
    fromXDR.mockReturnValueOnce({ operations: [
      { type: 'payment', amount: '2.5', destination: 'GDEST', asset: { isNative: () => true } },
      { type: 'payment', amount: '7', destination: 'GDEST2', asset: { isNative: () => true } },
    ] });

    const result = parseRequestDetails(request());

    expect(result.operations).toEqual([
      expect.objectContaining({ label: 'Payment', amount: '2.5', destination: 'GDEST', asset: 'XLM' }),
      expect.objectContaining({ label: 'Payment', amount: '7', destination: 'GDEST2', asset: 'XLM' }),
    ]);
  });

  it('decodes contract arguments and auth sub-invocations', () => {
    const nested = contractInvocation('nested');
    fromXDR.mockReturnValueOnce({ operations: [{
      type: 'invokeHostFunction',
      func: { invokeContract: () => ({ contractAddress: () => 'CPARENT', functionName: () => 'transfer', args: () => [{ native: 'parent-arg' }] }) },
      auth: [{ rootInvocation: () => contractInvocation('authorize', [nested]) }],
    }] });

    const result = parseRequestDetails(request());

    expect(result.operations).toEqual([
      expect.objectContaining({ label: 'Contract call', contractAddress: 'CPARENT', functionName: 'transfer', arguments: ['"parent-arg"'], depth: 0 }),
      expect.objectContaining({ label: 'Sub-invocation', contractAddress: 'CINNER', functionName: 'authorize', arguments: ['"inner-arg"'], depth: 1 }),
      expect.objectContaining({ label: 'Sub-invocation', functionName: 'nested', depth: 2 }),
    ]);
  });
});
