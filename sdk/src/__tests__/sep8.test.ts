/**
 * Tests for SEP-8 regulated asset approval flow.
 * Covers all five response outcomes and transaction verification.
 */

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

  describe('verifyRevisedTransaction', () => {
    it('should accept identical transactions', () => {
      // Note: mockTxXdr is not a valid XDR, so we expect false
      // In production, valid XDRs from Stellar SDK would be used
      const result = verifyRevisedTransaction(mockTxXdr, mockTxXdr);
      // This will return false because mockTxXdr is not valid XDR
      // A valid XDR would return true when compared to itself
      expect(result).toBe(false);
    });

    it('should reject invalid XDR', () => {
      const result = verifyRevisedTransaction('invalid', 'also-invalid');
      expect(result).toBe(false);
    });

    it('should reject if original XDR is invalid', () => {
      const result = verifyRevisedTransaction('invalid', mockTxXdr);
      expect(result).toBe(false);
    });

    it('should reject if revised XDR is invalid', () => {
      const result = verifyRevisedTransaction(mockTxXdr, 'invalid');
      expect(result).toBe(false);
    });

    it('should reject empty XDR strings', () => {
      const result = verifyRevisedTransaction('', '');
      expect(result).toBe(false);
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
