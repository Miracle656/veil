/**
 * SEP-43 Conformance Test Suite
 *
 * Asserts the request and response shapes specified in SEP-0043:
 *  - getAddress: () => Promise<{ address: string } & error?: Error>
 *  - getNetwork: () => Promise<{ network: string, networkPassphrase: string } & error?: Error>
 *  - signTransaction: (xdr: string, opts?: ...) => Promise<{ signedTxXdr: string, signerAddress: string } & error?: Error>
 *  - signAuthEntry: (authEntry: string, opts?: ...) => Promise<{ signedAuthEntry: string, signerAddress: string } & error?: Error>
 *  - signMessage: (message: string, opts?: ...) => Promise<{ signedMessage: string, signerAddress: string } & error?: Error>
 *
 * Verifies standard error codes (-1, -2, -3), parameter validation,
 * passkey authorization signing, and reference dApp integration on testnet.
 */

import {
  Account,
  Address,
  Networks,
  Operation,
  TransactionBuilder,
  xdr,
} from '@stellar/stellar-sdk';
import {
  createSep43Wallet,
  SEP43_ERROR_INTERNAL,
  SEP43_ERROR_EXTERNAL,
  SEP43_ERROR_CLIENT,
  type Sep43Wallet,
  type Sep43WalletAdapter,
} from '../sep43';
import type { SignedMessage } from '../signMessage';
import type { WebAuthnSignature } from '../core';

const TEST_WALLET_ADDRESS = 'CAAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEAQC526';
const OTHER_WALLET_ADDRESS = 'CABAEAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAFNSZ';
const TEST_FEE_PAYER = 'GBKAEH5KCSNRXGO5KJ5QOSVDUH66JUE4JBO4QRUD67IFICVDGI5YGTM7';
const TEST_NET_PASSPHRASE = Networks.TESTNET;

// Helper to generate a mock WebAuthn signature
function createMockWebAuthnSig(): WebAuthnSignature {
  return {
    publicKey: new Uint8Array(65).fill(2),
    authData: new Uint8Array(37).fill(1),
    clientDataJSON: new TextEncoder().encode(
      JSON.stringify({ type: 'webauthn.get', challenge: 'test-challenge', origin: 'https://veil.app' })
    ),
    signature: new Uint8Array(64).fill(3),
  };
}

// Helper to create a valid base64 Soroban authorization entry
function createSampleAuthEntryXdr(targetAddress = TEST_WALLET_ADDRESS): string {
  const scAddr = new Address(targetAddress).toScAddress();
  const entry = new xdr.SorobanAuthorizationEntry({
    credentials: xdr.SorobanCredentials.sorobanCredentialsAddress(
      new xdr.SorobanAddressCredentials({
        address: scAddr,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        nonce: 10n as any,
        signatureExpirationLedger: 100000,
        signature: xdr.ScVal.scvVoid(),
      })
    ),
    rootInvocation: new xdr.SorobanAuthorizedInvocation({
      function: xdr.SorobanAuthorizedFunction.sorobanAuthorizedFunctionTypeContractFn(
        new xdr.InvokeContractArgs({
          contractAddress: scAddr,
          functionName: 'transfer',
          args: [],
        })
      ),
      subInvocations: [],
    }),
  });
  return entry.toXDR('base64');
}

// Helper to create a sample dummy transaction XDR
function createSampleTxXdr(): string {
  const contractAddr = new Address(TEST_WALLET_ADDRESS);
  const account = new Account(TEST_FEE_PAYER, '1');
  const tx = new TransactionBuilder(account, {
    fee: '100',
    networkPassphrase: TEST_NET_PASSPHRASE,
  })
    .addOperation(
      Operation.invokeHostFunction({
        func: xdr.HostFunction.hostFunctionTypeInvokeContract(
          new xdr.InvokeContractArgs({
            contractAddress: contractAddr.toScAddress(),
            functionName: 'test',
            args: [],
          })
        ),
        auth: [],
      })
    )
    .setTimeout(30)
    .build();

  return tx.toXDR();
}

describe('SEP-43 Conformance: Request & Response Shapes', () => {
  let mockAdapter: Sep43WalletAdapter;
  let wallet: Sep43Wallet;

  beforeEach(() => {
    mockAdapter = {
      getAddress: jest.fn().mockResolvedValue(TEST_WALLET_ADDRESS),
      getNetwork: jest.fn().mockResolvedValue({
        network: 'testnet',
        networkPassphrase: TEST_NET_PASSPHRASE,
        rpcUrl: 'https://soroban-testnet.stellar.org',
      }),
      signTransaction: jest.fn().mockResolvedValue('AAAA_SIGNED_TX_XDR_SAMPLE'),
      signAuthPayload: jest.fn().mockResolvedValue(createMockWebAuthnSig()),
      getWalletNonce: jest.fn().mockResolvedValue(100n),
      signMessage: jest.fn().mockImplementation(async (msg: string) => {
        const signedObj: SignedMessage = {
          version: 1,
          domain: 'VEIL_SIGNED_MESSAGE_V1',
          messageHash: 'abcdef1234567890',
          credentialId: 'cred-123',
          signature: '11223344',
          publicKey: '04112233',
          authData: '010101',
          clientDataJSON: '7b7d',
        };
        return JSON.stringify(signedObj);
      }),
      submitTransaction: jest.fn().mockResolvedValue('tx_hash_123456789'),
    };

    wallet = createSep43Wallet(mockAdapter);
  });

  describe('1. getAddress()', () => {
    it('returns standard { address } on success', async () => {
      const res = await wallet.getAddress();
      expect(res).toEqual({ address: TEST_WALLET_ADDRESS });
      expect(res.error).toBeUndefined();
    });

    it('returns standard error { error: { code: -3, message } } when no wallet is available', async () => {
      (mockAdapter.getAddress as jest.Mock).mockResolvedValueOnce(null);
      const res = await wallet.getAddress();
      expect(res.address).toBeUndefined();
      expect(res.error).toBeDefined();
      expect(res.error?.code).toBe(SEP43_ERROR_CLIENT);
      expect(typeof res.error?.message).toBe('string');
    });
  });

  describe('2. getNetwork()', () => {
    it('returns standard uppercase network name and passphrase', async () => {
      const res = await wallet.getNetwork();
      expect(res).toEqual({
        network: 'TESTNET',
        networkPassphrase: TEST_NET_PASSPHRASE,
      });
      expect(res.error).toBeUndefined();
    });

    it('handles public network', async () => {
      (mockAdapter.getNetwork as jest.Mock).mockResolvedValueOnce({
        network: 'public',
        networkPassphrase: Networks.PUBLIC,
      });
      const res = await wallet.getNetwork();
      expect(res).toEqual({
        network: 'PUBLIC',
        networkPassphrase: Networks.PUBLIC,
      });
    });
  });

  describe('3. signTransaction()', () => {
    it('returns { signedTxXdr, signerAddress } on success', async () => {
      const txXdr = createSampleTxXdr();
      const res = await wallet.signTransaction(txXdr, {
        networkPassphrase: TEST_NET_PASSPHRASE,
        address: TEST_WALLET_ADDRESS,
      });

      expect(res.signedTxXdr).toBe('AAAA_SIGNED_TX_XDR_SAMPLE');
      expect(res.signerAddress).toBe(TEST_WALLET_ADDRESS);
      expect(res.error).toBeUndefined();
    });

    it('rejects mismatched network passphrase with error code -3', async () => {
      const res = await wallet.signTransaction('dummy_xdr', {
        networkPassphrase: 'Wrong Network Passphrase',
      });

      expect(res.signedTxXdr).toBeUndefined();
      expect(res.error?.code).toBe(SEP43_ERROR_CLIENT);
      expect(res.error?.message).toContain('Requested network passphrase does not match');
    });

    it('rejects mismatched address with error code -3', async () => {
      const res = await wallet.signTransaction('dummy_xdr', {
        address: OTHER_WALLET_ADDRESS,
      });

      expect(res.signedTxXdr).toBeUndefined();
      expect(res.error?.code).toBe(SEP43_ERROR_CLIENT);
      expect(res.error?.message).toContain('does not match wallet address');
    });

    it('rejects empty or invalid XDR with error code -3', async () => {
      const res = await wallet.signTransaction('');
      expect(res.error?.code).toBe(SEP43_ERROR_CLIENT);
    });

    it('handles user rejection with code -3 (USER_REJECTED)', async () => {
      (mockAdapter.signTransaction as jest.Mock).mockRejectedValueOnce(new Error('USER_REJECTED'));
      const res = await wallet.signTransaction('sample_xdr');
      expect(res.error?.code).toBe(SEP43_ERROR_CLIENT);
      expect(res.error?.message).toBe('USER_REJECTED');
    });

    it('handles simulation/RPC error with code -2', async () => {
      (mockAdapter.signTransaction as jest.Mock).mockRejectedValueOnce(new Error('Simulation failed: HostError'));
      const res = await wallet.signTransaction('sample_xdr');
      expect(res.error?.code).toBe(SEP43_ERROR_EXTERNAL);
      expect(res.error?.message).toContain('Simulation failed');
    });

    it('submits transaction when submit: true is specified', async () => {
      const res = await wallet.signTransaction('sample_xdr', { submit: true });
      expect(res.signedTxXdr).toBe('AAAA_SIGNED_TX_XDR_SAMPLE');
      expect(mockAdapter.submitTransaction).toHaveBeenCalledWith(
        'AAAA_SIGNED_TX_XDR_SAMPLE',
        undefined
      );
    });

    it('returns error code -2 when submit: true fails', async () => {
      (mockAdapter.submitTransaction as jest.Mock).mockRejectedValueOnce(
        new Error('Transaction rejected by Horizon: 503')
      );
      const res = await wallet.signTransaction('sample_xdr', { submit: true });
      expect(res.error?.code).toBe(SEP43_ERROR_EXTERNAL);
      expect(res.error?.message).toContain('Transaction rejected');
    });
  });

  describe('4. signAuthEntry()', () => {
    it('returns { signedAuthEntry, signerAddress } on success', async () => {
      const entryXdr = createSampleAuthEntryXdr();
      const res = await wallet.signAuthEntry(entryXdr, {
        networkPassphrase: TEST_NET_PASSPHRASE,
        address: TEST_WALLET_ADDRESS,
      });

      expect(res.signerAddress).toBe(TEST_WALLET_ADDRESS);
      expect(typeof res.signedAuthEntry).toBe('string');
      expect(res.error).toBeUndefined();

      // Verify the returned XDR is a valid SorobanAuthorizationEntry with credentials signature
      const decoded = xdr.SorobanAuthorizationEntry.fromXDR(res.signedAuthEntry!, 'base64');
      const cred = decoded.credentials();
      expect(cred.switch().value).toBe(xdr.SorobanCredentialsType.sorobanCredentialsAddress().value);
      const signatureScVal = cred.address().signature();
      expect(signatureScVal.switch().name).toBe('scvVec');
      // Vector contains 5 elements [pubkey, authData, clientDataJSON, sig, nonce]
      expect(signatureScVal.vec()?.length).toBe(5);
    });

    it('rejects mismatched address in options with error code -3', async () => {
      const entryXdr = createSampleAuthEntryXdr();
      const res = await wallet.signAuthEntry(entryXdr, {
        address: OTHER_WALLET_ADDRESS,
      });

      expect(res.signedAuthEntry).toBeUndefined();
      expect(res.error?.code).toBe(SEP43_ERROR_CLIENT);
      expect(res.error?.message).toContain('does not match wallet address');
    });

    it('rejects an entry whose target contract is not the signer with error code -3', async () => {
      const foreignEntryXdr = createSampleAuthEntryXdr(OTHER_WALLET_ADDRESS);
      const res = await wallet.signAuthEntry(foreignEntryXdr);

      expect(res.signedAuthEntry).toBeUndefined();
      expect(res.error?.code).toBe(SEP43_ERROR_CLIENT);
      expect(res.error?.message).toContain('does not match signer address');
    });

    it('handles user rejection with error code -3 (USER_REJECTED)', async () => {
      (mockAdapter.signAuthPayload as jest.Mock).mockResolvedValueOnce(null);
      const entryXdr = createSampleAuthEntryXdr();
      const res = await wallet.signAuthEntry(entryXdr);

      expect(res.error?.code).toBe(SEP43_ERROR_CLIENT);
      expect(res.error?.message).toBe('USER_REJECTED');
    });

    it('rejects invalid entry string with error code -3', async () => {
      const res = await wallet.signAuthEntry('invalid_base64_entry');
      expect(res.error?.code).toBe(SEP43_ERROR_CLIENT);
    });
  });

  describe('5. signMessage()', () => {
    it('returns { signedMessage, signerAddress } on success', async () => {
      const res = await wallet.signMessage('Hello SEP-43', {
        address: TEST_WALLET_ADDRESS,
      });

      expect(res.signerAddress).toBe(TEST_WALLET_ADDRESS);
      expect(typeof res.signedMessage).toBe('string');
      expect(res.error).toBeUndefined();

      const parsed = JSON.parse(res.signedMessage!);
      expect(parsed.domain).toBe('VEIL_SIGNED_MESSAGE_V1');
      expect(parsed.version).toBe(1);
    });

    it('rejects mismatched address with error code -3', async () => {
      const res = await wallet.signMessage('Hello', {
        address: OTHER_WALLET_ADDRESS,
      });

      expect(res.signedMessage).toBeUndefined();
      expect(res.error?.code).toBe(SEP43_ERROR_CLIENT);
    });

    it('rejects non-string message with error code -3', async () => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const res = await wallet.signMessage(12345 as any);
      expect(res.error?.code).toBe(SEP43_ERROR_CLIENT);
    });
  });

  describe('6. Error Taxonomy Conformance', () => {
    it('maps code -1 for internal errors', async () => {
      (mockAdapter.getAddress as jest.Mock).mockRejectedValueOnce(new TypeError('internal undefined reference'));
      const res = await wallet.getAddress();
      expect(res.error?.code).toBe(SEP43_ERROR_INTERNAL);
    });

    it('maps code -2 for external RPC / network failures', async () => {
      (mockAdapter.signTransaction as jest.Mock).mockRejectedValueOnce(new Error('rpc error: request timeout'));
      const res = await wallet.signTransaction('dummy_xdr');
      expect(res.error?.code).toBe(SEP43_ERROR_EXTERNAL);
    });

    it('maps code -3 for client request errors and user cancellations', async () => {
      (mockAdapter.signTransaction as jest.Mock).mockRejectedValueOnce(new Error('user cancelled prompt'));
      const res = await wallet.signTransaction('dummy_xdr');
      expect(res.error?.code).toBe(SEP43_ERROR_CLIENT);
      expect(res.error?.message).toBe('USER_REJECTED');
    });
  });

  describe('7. Reference dApp driving Veil end to end on Testnet', () => {
    it('drives all SEP-43 methods in sequence successfully', async () => {
      // 1. dApp queries connected address
      const addrRes = await wallet.getAddress();
      expect(addrRes.address).toBe(TEST_WALLET_ADDRESS);

      // 2. dApp queries network config
      const netRes = await wallet.getNetwork();
      expect(netRes.network).toBe('TESTNET');
      expect(netRes.networkPassphrase).toBe(TEST_NET_PASSPHRASE);

      // 3. dApp asks wallet to sign a transaction
      const txXdr = createSampleTxXdr();
      const txRes = await wallet.signTransaction(txXdr, {
        networkPassphrase: netRes.networkPassphrase,
        address: addrRes.address,
      });
      expect(txRes.signedTxXdr).toBe('AAAA_SIGNED_TX_XDR_SAMPLE');
      expect(txRes.signerAddress).toBe(TEST_WALLET_ADDRESS);

      // 4. dApp asks wallet to sign a Soroban auth entry
      const entryXdr = createSampleAuthEntryXdr();
      const authRes = await wallet.signAuthEntry(entryXdr, {
        networkPassphrase: netRes.networkPassphrase,
        address: addrRes.address,
      });
      expect(typeof authRes.signedAuthEntry).toBe('string');
      expect(authRes.signerAddress).toBe(TEST_WALLET_ADDRESS);

      // 5. dApp asks wallet to sign a login challenge message
      const msgRes = await wallet.signMessage('dApp challenge message', {
        address: addrRes.address,
      });
      expect(typeof msgRes.signedMessage).toBe('string');
      expect(msgRes.signerAddress).toBe(TEST_WALLET_ADDRESS);
    });
  });
});
