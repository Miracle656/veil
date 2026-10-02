/**
 * Tests for the agent conversation model.
 *
 * The two things that keep the user in control are here rather than in the
 * screen: frames from the agent service are only accepted in shapes we
 * understand, and a proposed transaction is described from its own XDR rather
 * than from the summary the agent wrote for it.
 */

import {
  Account,
  Asset,
  BASE_FEE,
  Keypair,
  Memo,
  Networks,
  Operation,
  TransactionBuilder,
} from '@stellar/stellar-sdk';

import {
  describeSubmissionError,
  isProposalForFeePayer,
  nextMessageId,
  parseInlineMarkup,
  proposalRefusal,
  reviewProposedTransaction,
  shortenAddress,
  type ProposalReview,
} from '../agentMessages';

const USDC_ISSUER = 'GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN';

function builder(source: Keypair) {
  return new TransactionBuilder(new Account(source.publicKey(), '7'), {
    fee: BASE_FEE,
    networkPassphrase: Networks.TESTNET,
  });
}

describe('nextMessageId', () => {
  it('never repeats an id', () => {
    const ids = [nextMessageId(), nextMessageId('agent'), nextMessageId('agent')];

    expect(new Set(ids).size).toBe(3);
  });
});

// ── Inline markup ────────────────────────────────────────────────────────────

describe('parseInlineMarkup', () => {
  it('splits bold and code out of the surrounding text', () => {
    expect(parseInlineMarkup('You have **12 XLM** in `GABC`.')).toEqual([
      { text: 'You have ', style: 'plain' },
      { text: '12 XLM', style: 'strong' },
      { text: ' in ', style: 'plain' },
      { text: 'GABC', style: 'code' },
      { text: '.', style: 'plain' },
    ]);
  });

  it('leaves plain text as a single segment', () => {
    expect(parseInlineMarkup('nothing to mark up')).toEqual([
      { text: 'nothing to mark up', style: 'plain' },
    ]);
  });

  it('leaves unmatched markers alone rather than guessing', () => {
    expect(parseInlineMarkup('**unclosed and `also this')).toEqual([
      { text: '**unclosed and `also this', style: 'plain' },
    ]);
  });

  it('keeps markup-looking text as text', () => {
    // The segments are rendered as Text children, so this can only ever be read
    // as characters — but it must survive the parser intact to be shown at all.
    const segments = parseInlineMarkup('<script>alert(1)</script>');

    expect(segments).toEqual([{ text: '<script>alert(1)</script>', style: 'plain' }]);
  });

  it('handles an empty string', () => {
    expect(parseInlineMarkup('')).toEqual([]);
  });
});

// ── Transaction review ───────────────────────────────────────────────────────

describe('reviewProposedTransaction', () => {
  it('describes a payment from the transaction itself', () => {
    const source = Keypair.random();
    const destination = Keypair.random();
    const xdr = builder(source)
      .addOperation(
        Operation.payment({ destination: destination.publicKey(), asset: Asset.native(), amount: '25.5000000' })
      )
      .addMemo(Memo.text('rent'))
      .setTimeout(180)
      .build()
      .toXDR();

    const review = reviewProposedTransaction(xdr, Networks.TESTNET);

    expect(review.source).toBe(source.publicKey());
    expect(review.operations).toEqual([
      `Send 25.5000000 XLM to ${shortenAddress(destination.publicKey())}`,
    ]);
    expect(review.memo).toBe('rent');
    expect(review.hasUnknownOperation).toBe(false);
  });

  it('describes a swap with the minimum the user will receive', () => {
    const source = Keypair.random();
    const usdc = new Asset('USDC', USDC_ISSUER);
    const xdr = builder(source)
      .addOperation(
        Operation.pathPaymentStrictSend({
          sendAsset: Asset.native(),
          sendAmount: '100.0000000',
          destination: source.publicKey(),
          destAsset: usdc,
          destMin: '11.9000000',
          path: [],
        })
      )
      .setTimeout(180)
      .build()
      .toXDR();

    const review = reviewProposedTransaction(xdr, Networks.TESTNET);

    expect(review.operations[0]).toBe(
      `Swap 100.0000000 XLM for at least 11.9000000 USDC to ${shortenAddress(source.publicKey())}`
    );
  });

  it('describes every operation in a multi-operation transaction', () => {
    const source = Keypair.random();
    const usdc = new Asset('USDC', USDC_ISSUER);
    const xdr = builder(source)
      .addOperation(Operation.changeTrust({ asset: usdc }))
      .addOperation(
        Operation.payment({ destination: source.publicKey(), asset: usdc, amount: '1.0000000' })
      )
      .setTimeout(180)
      .build()
      .toXDR();

    const review = reviewProposedTransaction(xdr, Networks.TESTNET);

    expect(review.operations).toHaveLength(2);
    expect(review.operations[0]).toMatch(/^Add a trustline for USDC/);
  });

  it('flags an operation it cannot describe instead of staying quiet', () => {
    const source = Keypair.random();
    const xdr = builder(source)
      .addOperation(Operation.bumpSequence({ bumpTo: '9' }))
      .setTimeout(180)
      .build()
      .toXDR();

    const review = reviewProposedTransaction(xdr, Networks.TESTNET);

    expect(review.hasUnknownOperation).toBe(true);
    expect(review.operations[0]).toMatch(/Unrecognised operation/);
  });

  it('throws on XDR it cannot parse, rather than returning an empty review', () => {
    expect(() => reviewProposedTransaction('not-xdr', Networks.TESTNET)).toThrow();
  });
});

describe('isProposalForFeePayer', () => {
  const review: ProposalReview = {
    source: 'GSOURCE',
    fee: '100',
    memo: null,
    operations: ['Send 1 XLM to GABC'],
    hasUnknownOperation: false,
  };

  it('accepts a transaction sourced from this wallet fee payer', () => {
    expect(isProposalForFeePayer(review, 'GSOURCE')).toBe(true);
  });

  it('refuses another account, and refuses when there is no fee payer', () => {
    expect(isProposalForFeePayer(review, 'GOTHER')).toBe(false);
    expect(isProposalForFeePayer(review, null)).toBe(false);
  });
});

describe('describeSubmissionError', () => {
  it('surfaces Horizon result codes', () => {
    const error = {
      response: {
        data: { extras: { result_codes: { transaction: 'tx_failed', operations: ['op_underfunded'] } } },
      },
    };

    expect(describeSubmissionError(error)).toBe('tx_failed — op_underfunded');
  });

  it('falls back to the error message', () => {
    expect(describeSubmissionError(new Error('network down'))).toBe('network down');
    expect(describeSubmissionError('plain string')).toBe('plain string');
  });
});

describe('shortenAddress', () => {
  it('keeps both ends of a long address and leaves short values alone', () => {
    const address = Keypair.random().publicKey();

    expect(shortenAddress(address)).toBe(`${address.slice(0, 6)}…${address.slice(-6)}`);
    expect(shortenAddress('GABC')).toBe('GABC');
  });
});

describe('proposalRefusal', () => {
  const owner = Keypair.random();
  const stranger = Keypair.random();

  function review(build: (b: TransactionBuilder) => TransactionBuilder, source = owner) {
    const xdr = build(builder(source)).setTimeout(60).build().toXDR();
    return reviewProposedTransaction(xdr, Networks.TESTNET);
  }

  const payment = (b: TransactionBuilder) =>
    b.addOperation(
      Operation.payment({ destination: stranger.publicKey(), asset: Asset.native(), amount: '1' })
    );

  it("allows a payment from this wallet's own fee payer", () => {
    expect(proposalRefusal(review(payment), owner.publicKey())).toBeNull();
  });

  it('refuses a transaction it could not decode', () => {
    expect(proposalRefusal(null, owner.publicKey())).toMatch(/could not be decoded/);
  });

  it("refuses a transaction sourced from someone else's account", () => {
    expect(proposalRefusal(review(payment, stranger), owner.publicKey())).toMatch(/not this wallet's fee payer/);
  });

  it('refuses when this device has no fee payer to compare with', () => {
    expect(proposalRefusal(review(payment), null)).not.toBeNull();
  });

  it('refuses an operation the screen cannot show — the kind a manipulated agent slips in', () => {
    const takeover = (b: TransactionBuilder) =>
      payment(b).addOperation(Operation.setOptions({ masterWeight: 0 }));
    expect(proposalRefusal(review(takeover), owner.publicKey())).toMatch(/cannot show you/);

    const merge = (b: TransactionBuilder) =>
      b.addOperation(Operation.accountMerge({ destination: stranger.publicKey() }));
    expect(proposalRefusal(review(merge), owner.publicKey())).toMatch(/cannot show you/);
  });
});
