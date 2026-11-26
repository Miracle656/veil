/**
 * Tests for SEP-8 regulated asset approval flow.
 * Covers all five response outcomes and transaction verification.
 */

import {
  Account,
  Asset,
  Memo,
  Networks,
  Operation,
  StrKey,
  TransactionBuilder,
} from '@stellar/stellar-sdk';

import {
  submitSep8Transaction,
  verifyRevisedTransaction,
  isRegulatedAsset,
  Sep8Error,
  type Sep8Response,
} from '../sep8';

describe('SEP-8 Regulated Assets', () => {
  const approvalServerUrl = 'https://issuer.example.com/tx_approve';
  const mockTxXdr = 'AAAAAgAAAABgHLrQzE6YYPCfQZv3xrb4qBYHlpU6EVlGzIBY55ycTQAAAGQAqnZEAAAAAQAAAAAAAAAAAAAAAQAAAAAAAAAACgADsQACgAAAA==';

  beforeEach(() => {
    // Reset fetch mock before each test
    jest.clearAllMocks();
  });

  describe('submitSep8Transaction', () => {
    describe('success outcome', () => {
      it('should handle successful approval response', async () => {
        const successResponse = {
          status: 'success',
          tx: mockTxXdr,
          message: 'Transaction approved',
        };

        global.fetch = jest.fn().mockResolvedValueOnce({
          status: 200,
          headers: new Map([['content-type', 'application/json']]),
          json: jest.fn().mockResolvedValueOnce(successResponse),
        });

        const result = await submitSep8Transaction({
          approvalServerUrl,
          transactionXdr: mockTxXdr,
        });

        expect(result.status).toBe('success');
        expect((result as any).tx).toBe(mockTxXdr);
        expect((result as any).message).toBe('Transaction approved');
      });

      it('should handle success without optional message', async () => {
        const successResponse = {
          status: 'success',
          tx: mockTxXdr,
        };

        global.fetch = jest.fn().mockResolvedValueOnce({
          status: 200,
          headers: new Map([['content-type', 'application/json']]),
          json: jest.fn().mockResolvedValueOnce(successResponse),
        });

        const result = await submitSep8Transaction({
          approvalServerUrl,
          transactionXdr: mockTxXdr,
        });

        expect(result.status).toBe('success');
        expect((result as any).message).toBeUndefined();
      });

      it('should make POST request with correct headers', async () => {
        const fetchMock = jest.fn().mockResolvedValueOnce({
          status: 200,
          headers: new Map([['content-type', 'application/json']]),
          json: jest.fn().mockResolvedValueOnce({ status: 'success', tx: mockTxXdr }),
        });
        global.fetch = fetchMock;

        await submitSep8Transaction({
          approvalServerUrl,
          transactionXdr: mockTxXdr,
        });

        expect(fetchMock).toHaveBeenCalledWith(
          approvalServerUrl,
          expect.objectContaining({
            method: 'POST',
            headers: expect.objectContaining({
              'Content-Type': 'application/json',
            }),
          }),
        );
      });
    });

    describe('revised outcome', () => {
      it('should handle revised transaction response', async () => {
        const revisedResponse = {
          status: 'revised',
          tx: mockTxXdr,
          message: 'Added authorization operations',
        };

        global.fetch = jest.fn().mockResolvedValueOnce({
          status: 200,
          headers: new Map([['content-type', 'application/json']]),
          json: jest.fn().mockResolvedValueOnce(revisedResponse),
        });

        const result = await submitSep8Transaction({
          approvalServerUrl,
          transactionXdr: mockTxXdr,
        });

        expect(result.status).toBe('revised');
        expect((result as any).tx).toBe(mockTxXdr);
        expect((result as any).message).toBe('Added authorization operations');
      });

      it('should reject revised response without message', async () => {
        const invalidResponse = {
          status: 'revised',
          tx: mockTxXdr,
          // Missing message field
        };

        global.fetch = jest.fn().mockResolvedValueOnce({
          status: 200,
          headers: new Map([['content-type', 'application/json']]),
          json: jest.fn().mockResolvedValueOnce(invalidResponse),
        });

        await expect(
          submitSep8Transaction({
            approvalServerUrl,
            transactionXdr: mockTxXdr,
          }),
        ).rejects.toThrow(Sep8Error);
      });

      it('should reject revised response without tx field', async () => {
        const invalidResponse = {
          status: 'revised',
          message: 'Added authorization operations',
          // Missing tx field
        };

        global.fetch = jest.fn().mockResolvedValueOnce({
          status: 200,
          headers: new Map([['content-type', 'application/json']]),
          json: jest.fn().mockResolvedValueOnce(invalidResponse),
        });

        await expect(
          submitSep8Transaction({
            approvalServerUrl,
            transactionXdr: mockTxXdr,
          }),
        ).rejects.toThrow(Sep8Error);
      });
    });

    describe('pending outcome', () => {
      it('should handle pending response with timeout', async () => {
        const pendingResponse = {
          status: 'pending',
          timeout: 5000,
          message: 'Verifying compliance',
        };

        global.fetch = jest.fn().mockResolvedValueOnce({
          status: 200,
          headers: new Map([['content-type', 'application/json']]),
          json: jest.fn().mockResolvedValueOnce(pendingResponse),
        });

        const result = await submitSep8Transaction({
          approvalServerUrl,
          transactionXdr: mockTxXdr,
        });

        expect(result.status).toBe('pending');
        expect((result as any).timeout).toBe(5000);
        expect((result as any).message).toBe('Verifying compliance');
      });

      it('should handle pending response without timeout', async () => {
        const pendingResponse = {
          status: 'pending',
          message: 'Verifying compliance',
        };

        global.fetch = jest.fn().mockResolvedValueOnce({
          status: 200,
          headers: new Map([['content-type', 'application/json']]),
          json: jest.fn().mockResolvedValueOnce(pendingResponse),
        });

        const result = await submitSep8Transaction({
          approvalServerUrl,
          transactionXdr: mockTxXdr,
        });

        expect(result.status).toBe('pending');
        // timeout defaults to 0 if not specified
        expect((result as any).timeout).toBe(0);
      });

      it('should use default 5s timeout if not specified', async () => {
        const pendingResponse = {
          status: 'pending',
        };

        global.fetch = jest.fn().mockResolvedValueOnce({
          status: 200,
          headers: new Map([['content-type', 'application/json']]),
          json: jest.fn().mockResolvedValueOnce(pendingResponse),
        });

        const result = await submitSep8Transaction({
          approvalServerUrl,
          transactionXdr: mockTxXdr,
        });

        expect(result.status).toBe('pending');
      });
    });

    describe('action_required outcome', () => {
      it('should handle action_required response', async () => {
        const actionResponse = {
          status: 'action_required',
          action_url: 'https://issuer.example.com/verify?tx=xyz',
          action_method: 'GET',
          message: 'Please complete KYC verification',
        };

        global.fetch = jest.fn().mockResolvedValueOnce({
          status: 200,
          headers: new Map([['content-type', 'application/json']]),
          json: jest.fn().mockResolvedValueOnce(actionResponse),
        });

        const result = await submitSep8Transaction({
          approvalServerUrl,
          transactionXdr: mockTxXdr,
        });

        expect(result.status).toBe('action_required');
        expect((result as any).action_url).toBe('https://issuer.example.com/verify?tx=xyz');
        expect((result as any).action_method).toBe('GET');
      });

      it('should default action_method to GET if not specified', async () => {
        const actionResponse = {
          status: 'action_required',
          action_url: 'https://issuer.example.com/verify',
          message: 'Please complete verification',
        };

        global.fetch = jest.fn().mockResolvedValueOnce({
          status: 200,
          headers: new Map([['content-type', 'application/json']]),
          json: jest.fn().mockResolvedValueOnce(actionResponse),
        });

        const result = await submitSep8Transaction({
          approvalServerUrl,
          transactionXdr: mockTxXdr,
        });

        expect(result.status).toBe('action_required');
        // action_method defaults to 'GET' when not specified
        expect((result as any).action_method).toBe('GET');
      });

      it('should reject action_required without action_url', async () => {
        const invalidResponse = {
          status: 'action_required',
          message: 'Please complete verification',
          // Missing action_url
        };

        global.fetch = jest.fn().mockResolvedValueOnce({
          status: 200,
          headers: new Map([['content-type', 'application/json']]),
          json: jest.fn().mockResolvedValueOnce(invalidResponse),
        });

        await expect(
          submitSep8Transaction({
            approvalServerUrl,
            transactionXdr: mockTxXdr,
          }),
        ).rejects.toThrow(Sep8Error);
      });
    });

    describe('rejected outcome', () => {
      it('should handle rejected response', async () => {
        const rejectedResponse = {
          status: 'rejected',
          error: 'AML check failed',
        };

        global.fetch = jest.fn().mockResolvedValueOnce({
          status: 200,
          headers: new Map([['content-type', 'application/json']]),
          json: jest.fn().mockResolvedValueOnce(rejectedResponse),
        });

        const result = await submitSep8Transaction({
          approvalServerUrl,
          transactionXdr: mockTxXdr,
        });

        expect(result.status).toBe('rejected');
        expect((result as any).error).toBe('AML check failed');
      });

      it('should require error message for rejected', async () => {
        const invalidResponse = {
          status: 'rejected',
          // Missing error field
        };

        global.fetch = jest.fn().mockResolvedValueOnce({
          status: 200,
          headers: new Map([['content-type', 'application/json']]),
          json: jest.fn().mockResolvedValueOnce(invalidResponse),
        });

        await expect(
          submitSep8Transaction({
            approvalServerUrl,
            transactionXdr: mockTxXdr,
          }),
        ).rejects.toThrow(Sep8Error);
      });
    });

    describe('error handling', () => {
      it('should throw Sep8Error on network error', async () => {
        global.fetch = jest.fn().mockRejectedValueOnce(new Error('Network error'));

        await expect(
          submitSep8Transaction({
            approvalServerUrl,
            transactionXdr: mockTxXdr,
          }),
        ).rejects.toThrow(Sep8Error);
      });

      it('should throw Sep8Error on HTTP error', async () => {
        global.fetch = jest.fn().mockResolvedValueOnce({
          status: 500,
          statusText: 'Internal Server Error',
          headers: new Map([['content-type', 'application/json']]),
          json: jest.fn().mockResolvedValueOnce({ error: 'Server error' }),
        });

        await expect(
          submitSep8Transaction({
            approvalServerUrl,
            transactionXdr: mockTxXdr,
          }),
        ).rejects.toThrow(Sep8Error);
      });

      it('should throw Sep8Error on invalid JSON', async () => {
        global.fetch = jest.fn().mockResolvedValueOnce({
          status: 200,
          headers: new Map([['content-type', 'application/json']]),
          json: jest.fn().mockRejectedValueOnce(new SyntaxError('Invalid JSON')),
        });

        await expect(
          submitSep8Transaction({
            approvalServerUrl,
            transactionXdr: mockTxXdr,
          }),
        ).rejects.toThrow(Sep8Error);
      });

      it('should reject unknown status', async () => {
        global.fetch = jest.fn().mockResolvedValueOnce({
          status: 200,
          headers: new Map([['content-type', 'application/json']]),
          json: jest.fn().mockResolvedValueOnce({
            status: 'unknown_status',
          }),
        });

        await expect(
          submitSep8Transaction({
            approvalServerUrl,
            transactionXdr: mockTxXdr,
          }),
        ).rejects.toThrow(Sep8Error);
      });

      it('should use custom timeout if provided', async () => {
        const fetchMock = jest.fn().mockResolvedValueOnce({
          status: 200,
          headers: new Map([['content-type', 'application/json']]),
          json: jest.fn().mockResolvedValueOnce({ status: 'success', tx: mockTxXdr }),
        });
        global.fetch = fetchMock;

        await submitSep8Transaction({
          approvalServerUrl,
          transactionXdr: mockTxXdr,
          timeoutMs: 30000,
        });

        // Verify that a timeout was specified in the fetch options
        expect(fetchMock).toHaveBeenCalled();
      });
    });
  });

  // Builds real transactions rather than placeholder strings. The previous
  // suite had five cases that all asserted `false` — including one named
  // "should accept identical transactions" — because the fixture was not a
  // parseable envelope, as its own comment admitted. Every case passed on the
  // fail-closed path, so the source comparison, the operation matching and the
  // length check had never executed once, and neither of the two real bugs in
  // the function was visible.
  describe('verifyRevisedTransaction', () => {
    // Deterministic, checksum-valid addresses from fixed seeds. `Keypair.random()`
    // cannot be used here: it needs crypto randomness jest's environment does not
    // provide, and the suite then throws at import and runs zero tests — which is
    // how the previous version of these tests looked green while testing nothing.
    const addr = (seed: number) => StrKey.encodeEd25519PublicKey(Buffer.alloc(32, seed));
    const USER = addr(1);
    const DESTINATION = addr(2);
    const ATTACKER = addr(3);
    const ISSUER = addr(4);
    const OTHER_SOURCE = addr(5);
    const REGULATED = new Asset('REG', ISSUER);

    /** A builder on a fixed sequence, so two builds are byte-comparable. */
    const builder = (fee = '10000', source = USER) =>
      new TransactionBuilder(new Account(source, '41'), {
        fee,
        networkPassphrase: Networks.TESTNET,
      }).setTimeout(180);

    const payment = (destination: string, amount: string) =>
      Operation.payment({ destination, asset: REGULATED, amount });

    const flag = (authorized: boolean) =>
      Operation.setTrustLineFlags({
        trustor: DESTINATION,
        asset: REGULATED,
        flags: { authorized },
        source: ISSUER,
      });

    /** What the user asked for: one payment of a regulated asset. */
    const original = (memo?: Memo) => {
      let b = builder().addOperation(payment(DESTINATION, '100'));
      if (memo) b = b.addMemo(memo);
      return b.build().toXDR();
    };

    /**
     * What a compliant approval server returns: the user's payment sandwiched
     * between the flag changes that authorise and then de-authorise the
     * destination. Note the payment lands at index 1, not 0.
     */
    const sandwiched = (memo?: Memo) => {
      let b = builder()
        .addOperation(flag(true))
        .addOperation(payment(DESTINATION, '100'))
        .addOperation(flag(false));
      if (memo) b = b.addMemo(memo);
      return b.build().toXDR();
    };

    it('accepts an identical transaction', () => {
      const xdrString = original();
      expect(verifyRevisedTransaction(xdrString, xdrString)).toBe(true);
    });

    it('accepts the SEP-8 sandwich, where the payment moves to index 1', () => {
      // The case the feature exists to support. An index-aligned comparison
      // fails this, because revised[0] is a flag change where original[0] is
      // the payment — so the previous implementation refused every real
      // revision.
      expect(verifyRevisedTransaction(original(), sandwiched())).toBe(true);
    });

    it('refuses a revision that redirects the payment to another account', () => {
      const tampered = builder()
        .addOperation(flag(true))
        .addOperation(payment(ATTACKER, '100'))
        .build()
        .toXDR();
      // Still a payment, still the same asset — only the destination changed.
      // Comparing operation types accepts this, which is the hole.
      expect(verifyRevisedTransaction(original(), tampered)).toBe(false);
    });

    it('refuses a bare destination swap, with nothing added to disguise it', () => {
      // One operation in, one out, same index, same type, same asset, same
      // amount — only the destination differs. This is the narrowest form of
      // the hole: comparing `body().switch()` returns true here, so the wallet
      // would have been told a payment redirected to someone else "appears
      // safe to sign".
      const redirected = builder().addOperation(payment(ATTACKER, '100')).build().toXDR();
      expect(verifyRevisedTransaction(original(), redirected)).toBe(false);
    });

    it('refuses a revision that changes the amount', () => {
      const tampered = builder().addOperation(payment(DESTINATION, '100000')).build().toXDR();
      expect(verifyRevisedTransaction(original(), tampered)).toBe(false);
    });

    it('refuses a revision that changes the memo', () => {
      // A memo selects the crediting account at an exchange, so changing it
      // redirects funds without touching an operation.
      expect(
        verifyRevisedTransaction(original(Memo.text('inv-1')), sandwiched(Memo.text('inv-2'))),
      ).toBe(false);
    });

    it('refuses a revision that drops the user operation entirely', () => {
      const stripped = builder().addOperation(flag(true)).build().toXDR();
      expect(verifyRevisedTransaction(original(), stripped)).toBe(false);
    });

    it('refuses a revision that reorders the user operations', () => {
      const inOrder = builder()
        .addOperation(payment(DESTINATION, '1'))
        .addOperation(payment(DESTINATION, '2'))
        .build()
        .toXDR();
      const reversed = builder()
        .addOperation(payment(DESTINATION, '2'))
        .addOperation(payment(DESTINATION, '1'))
        .build()
        .toXDR();

      expect(verifyRevisedTransaction(inOrder, inOrder)).toBe(true);
      // Both operations are present, so a set-membership check accepts this.
      // Order is part of the user's intent.
      expect(verifyRevisedTransaction(inOrder, reversed)).toBe(false);
    });

    it('refuses a revision that changes the transaction source account', () => {
      const other = builder('10000', OTHER_SOURCE)
        .addOperation(payment(DESTINATION, '100'))
        .build()
        .toXDR();
      expect(verifyRevisedTransaction(original(), other)).toBe(false);
    });

    it('allows the fee to rise, since added operations cost more', () => {
      const dearer = builder('30000').addOperation(payment(DESTINATION, '100')).build().toXDR();
      expect(verifyRevisedTransaction(original(), dearer)).toBe(true);
    });

    it('fails closed on unparseable input', () => {
      const valid = original();
      expect(verifyRevisedTransaction('invalid', 'also-invalid')).toBe(false);
      expect(verifyRevisedTransaction('invalid', valid)).toBe(false);
      expect(verifyRevisedTransaction(valid, 'invalid')).toBe(false);
      expect(verifyRevisedTransaction('', '')).toBe(false);
    });
  });

  describe('isRegulatedAsset', () => {
    it('should identify regulated assets with both flags set', () => {
      const flags = 3; // AUTHORIZATION_REQUIRED (1) | AUTHORIZATION_REVOCABLE (2)
      expect(isRegulatedAsset(flags)).toBe(true);
    });

    it('should identify regulated assets with other bits set', () => {
      const flags = 7; // 1 | 2 | 4 (other flag)
      expect(isRegulatedAsset(flags)).toBe(true);
    });

    it('should reject assets with only AUTHORIZATION_REQUIRED', () => {
      const flags = 1; // Only AUTHORIZATION_REQUIRED
      expect(isRegulatedAsset(flags)).toBe(false);
    });

    it('should reject assets with only AUTHORIZATION_REVOCABLE', () => {
      const flags = 2; // Only AUTHORIZATION_REVOCABLE
      expect(isRegulatedAsset(flags)).toBe(false);
    });

    it('should reject assets with neither flag', () => {
      const flags = 0;
      expect(isRegulatedAsset(flags)).toBe(false);
    });

    it('should reject assets with other flags but not both required', () => {
      const flags = 4; // Some other flag
      expect(isRegulatedAsset(flags)).toBe(false);
    });

    it('should handle large flag values', () => {
      const flags = 0xffffffff;
      expect(isRegulatedAsset(flags)).toBe(true);
    });
  });

  describe('Sep8Error', () => {
    it('should create error with status and message', () => {
      const error = new Sep8Error('Network error', 500);
      expect(error.message).toBe('Network error');
      expect(error.status).toBe(500);
      expect(error.name).toBe('Sep8Error');
    });

    it('should create error with approvalServerError', () => {
      const serverError = { error: 'AML check failed' };
      const error = new Sep8Error('Approval failed', 200, serverError);
      expect(error.approvalServerError).toEqual(serverError);
    });

    it('should create error with cause', () => {
      const cause = new Error('Network timeout');
      const error = new Sep8Error('Request failed', 0, undefined, cause);
      expect(error.cause).toBe(cause);
    });

    it('should be instanceof Error', () => {
      const error = new Sep8Error('Test error', 0);
      expect(error instanceof Error).toBe(true);
    });
  });

  describe('integration scenarios', () => {
    it('should handle full success flow', async () => {
      global.fetch = jest.fn().mockResolvedValueOnce({
        status: 200,
        headers: new Map([['content-type', 'application/json']]),
        json: jest.fn().mockResolvedValueOnce({
          status: 'success',
          tx: mockTxXdr,
        }),
      });

      const result = await submitSep8Transaction({
        approvalServerUrl: 'https://issuer.example.com/tx_approve',
        transactionXdr: mockTxXdr,
      });

      expect(result.status).toBe('success');
    });

    it('should handle full action_required flow', async () => {
      global.fetch = jest.fn().mockResolvedValueOnce({
        status: 200,
        headers: new Map([['content-type', 'application/json']]),
        json: jest.fn().mockResolvedValueOnce({
          status: 'action_required',
          action_url: 'https://issuer.example.com/kyc',
          message: 'Please complete KYC',
        }),
      });

      const result = await submitSep8Transaction({
        approvalServerUrl: 'https://issuer.example.com/tx_approve',
        transactionXdr: mockTxXdr,
      });

      expect(result.status).toBe('action_required');
      expect((result as any).action_url).toBeDefined();
    });

    it('should handle full rejection flow', async () => {
      global.fetch = jest.fn().mockResolvedValueOnce({
        status: 200,
        headers: new Map([['content-type', 'application/json']]),
        json: jest.fn().mockResolvedValueOnce({
          status: 'rejected',
          error: 'Transaction violates policy',
        }),
      });

      const result = await submitSep8Transaction({
        approvalServerUrl: 'https://issuer.example.com/tx_approve',
        transactionXdr: mockTxXdr,
      });

      expect(result.status).toBe('rejected');
    });
  });
});
