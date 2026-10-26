/**
 * The decoder both approval surfaces read.
 *
 * `components/WalletConnectApprovalModal.tsx` and the dApp browser's approval
 * sheet show the same class of request, and a user comparing the two needs the
 * two to mean the same thing. These tests hold that shared reading honest: what a
 * user can judge is the contract, the function, and whether the thing could be
 * read at all.
 */
import {
  Account,
  Address,
  Asset,
  Keypair,
  Networks,
  Operation,
  StrKey,
  TransactionBuilder,
  nativeToScVal,
  xdr,
} from '@stellar/stellar-sdk';

import {
  describeAuthEntryXdr,
  describeTransactionXdr,
  REQUEST_TYPE_LABELS,
} from '../transactionRequestDetails';

const WALLET = StrKey.encodeContract(Buffer.alloc(32, 0x11));
const TOKEN = StrKey.encodeContract(Buffer.alloc(32, 0x22));
const RECIPIENT = Keypair.fromRawEd25519Seed(Buffer.alloc(32, 0x33)).publicKey();
const SOURCE = Keypair.fromRawEd25519Seed(Buffer.alloc(32, 0x44)).publicKey();

function build(operations: never[], passphrase = Networks.TESTNET): string {
  const builder = new TransactionBuilder(new Account(SOURCE, '9'), {
    fee: '100',
    networkPassphrase: passphrase,
  });
  for (const operation of operations) builder.addOperation(operation);
  return builder.setTimeout(30).build().toXDR();
}

function invokeTx(): string {
  return build([
    Operation.invokeContractFunction({
      contract: TOKEN,
      function: 'transfer',
      args: [nativeToScVal(Address.fromString(RECIPIENT)), nativeToScVal(100n, { type: 'i128' })],
    }),
  ] as never[]);
}

function paymentTx(): string {
  return build([
    Operation.payment({ destination: RECIPIENT, amount: '12.5000000', asset: Asset.native() }),
  ] as never[]);
}

function authEntryXdr(): string {
  return new xdr.SorobanAuthorizationEntry({
    credentials: xdr.SorobanCredentials.sorobanCredentialsAddress(
      new xdr.SorobanAddressCredentials({
        address: Address.fromString(WALLET).toScAddress(),
        nonce: xdr.Int64.fromString('777'),
        signatureExpirationLedger: 0,
        signature: xdr.ScVal.scvVoid(),
      }),
    ),
    rootInvocation: new xdr.SorobanAuthorizedInvocation({
      function: xdr.SorobanAuthorizedFunction.sorobanAuthorizedFunctionTypeContractFn(
        new xdr.InvokeContractArgs({
          contractAddress: Address.fromString(TOKEN).toScAddress(),
          functionName: 'transfer',
          args: [nativeToScVal(Address.fromString(RECIPIENT))],
        }),
      ),
      subInvocations: [],
    }),
  }).toXDR('base64');
}

describe('describeTransactionXdr', () => {
  it('names a Soroban call by the contract and function it invokes', () => {
    expect(describeTransactionXdr(invokeTx(), Networks.TESTNET)).toMatchObject({
      operationType: 'contract',
      contractAddress: TOKEN,
      functionName: 'transfer',
      operationCount: 1,
    });
  });

  it('names a classic payment by its amount and destination', () => {
    expect(describeTransactionXdr(paymentTx(), Networks.TESTNET)).toMatchObject({
      operationType: 'payment',
      amount: '12.5000000',
      destination: RECIPIENT,
    });
  });

  it('counts operations, because that is what a wallet that signs one has to say', () => {
    const two = build([
      Operation.invokeContractFunction({ contract: TOKEN, function: 'a', args: [] }),
      Operation.invokeContractFunction({ contract: TOKEN, function: 'b', args: [] }),
    ] as never[]);

    expect(describeTransactionXdr(two, Networks.TESTNET).operationCount).toBe(2);
  });

  it('describes the transaction inside a fee bump, not the wrapper', () => {
    const inner = TransactionBuilder.fromXDR(invokeTx(), Networks.TESTNET) as never;
    const feeBump = TransactionBuilder.buildFeeBumpTransaction(SOURCE, '120', inner, Networks.TESTNET).toXDR();

    const details = describeTransactionXdr(feeBump, Networks.TESTNET);
    expect(details.operationType).toBe('contract');
    expect(details.operationCount).toBe(1);
  });

  it('says it could not read something, rather than describing it as safe', () => {
    const unknown = describeTransactionXdr('not-an-envelope', Networks.TESTNET);

    expect(unknown.operationType).toBe('unknown');
    expect(unknown.undecodable).toBe(true);
  });

  it('never throws, whatever the page sent', () => {
    const payloads = ['', '%%%', 'eA==', Buffer.alloc(4).toString('base64'), '{"a":1}'];
    for (const payload of payloads) {
      // The wrong passphrase is the interesting case: the same bytes decode to a
      // different transaction, so this must not raise.
      expect(() => describeTransactionXdr(payload, Networks.PUBLIC)).not.toThrow();
    }
  });

  it('reports an unknown type for an operation it does not render', () => {
    const bumped = build([Operation.bumpSequence({ bumpTo: '1234' })] as never[]);

    expect(describeTransactionXdr(bumped, Networks.TESTNET)).toMatchObject({
      operationType: 'unknown',
      undecodable: true,
      operationCount: 1,
    });
  });
});

describe('describeAuthEntryXdr', () => {
  it('reads the contract and function a signature would authorise', () => {
    expect(describeAuthEntryXdr(authEntryXdr())).toMatchObject({
      operationType: 'authEntry',
      contractAddress: TOKEN,
      functionName: 'transfer',
    });
  });

  it('is honest about an entry it cannot parse', () => {
    expect(describeAuthEntryXdr('!!!')).toMatchObject({ operationType: 'unknown', undecodable: true });
  });
});

describe('REQUEST_TYPE_LABELS', () => {
  it('labels every operation type a prompt can be handed', () => {
    expect(Object.keys(REQUEST_TYPE_LABELS).sort()).toEqual([
      'authEntry',
      'contract',
      'payment',
      'unknown',
    ]);
  });
});
