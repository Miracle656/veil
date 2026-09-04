import { horizonErrorMessage } from '../horizonError';
import { errorMessage } from '../errorMessage';

/** The document Horizon actually returns, trimmed of its XDR blobs. */
function horizonFailure(codes: { transaction?: string; operations?: string[] }) {
  return {
    type: 'https://stellar.org/horizon-errors/transaction_failed',
    title: 'Transaction Failed',
    status: 400,
    detail:
      'The transaction failed when submitted to the stellar network. The `extras.result_codes` field on this response contains further details. Descriptions of each code can be found at: https://developers.stellar.org/api/errors/http-status-codes/horizon-specific/transaction-failed/',
    extras: {
      envelope_xdr: 'AAAAAgAAA…',
      result_codes: codes,
      result_xdr: 'AAAAAAAAAGT…',
    },
  };
}

describe('horizonErrorMessage', () => {
  it('explains what tx_insufficient_balance actually means', () => {
    // Not "the account is empty" — the balance cannot fall below the reserve,
    // which is 1 XLM plus 0.5 per trustline. An account holding exactly 1 XLM
    // has nothing spendable, which is what broke the swap.
    const message = horizonErrorMessage(
      horizonFailure({ transaction: 'tx_insufficient_balance' }),
    );
    expect(message).toContain('1 XLM per account');
    expect(message).toContain('0.5');
  });

  it('prefers the operation code over a bare tx_failed', () => {
    expect(
      horizonErrorMessage(
        horizonFailure({ transaction: 'tx_failed', operations: ['op_low_reserve'] }),
      ),
    ).toContain('0.5 XLM');
  });

  it('skips successful operations when finding the failure', () => {
    expect(
      horizonErrorMessage(
        horizonFailure({ transaction: 'tx_failed', operations: ['op_success', 'op_underfunded'] }),
      ),
    ).toContain("isn't enough of that asset");
  });

  it('names an unrecognised code rather than inventing a meaning for it', () => {
    const message = horizonErrorMessage(horizonFailure({ transaction: 'tx_not_supported' }));
    expect(message).toContain('tx_not_supported');
  });

  it('is not fooled by objects that are not Horizon failures', () => {
    expect(horizonErrorMessage({ message: 'nope' })).toBeNull();
    expect(horizonErrorMessage(null)).toBeNull();
    expect(horizonErrorMessage('a string')).toBeNull();
  });
});

describe('a Horizon failure reaching the user', () => {
  /**
   * This is the whole path the swap error took: axios wraps the response, the
   * Error's own message is only the status line, and the readable prose in the
   * body is a paragraph about where to find documentation. Before this, the
   * user was shown the entire document, XDR blobs and all.
   */
  it('reads as a sentence rather than a wall of JSON', () => {
    const error = new Error('Request failed with status code 400');
    Object.assign(error, {
      isAxiosError: true,
      response: { status: 400, data: horizonFailure({ transaction: 'tx_insufficient_balance' }) },
    });

    const message = errorMessage(error);

    expect(message).toContain('enough XLM');
    expect(message).not.toContain('envelope_xdr');
    expect(message).not.toContain('result_xdr');
    expect(message).not.toContain('http-status-codes');
    expect(message.length).toBeLessThan(200);
  });
});
