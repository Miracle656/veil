/**
 * Moving a wallet off a fee-payer that cannot be rebuilt from its passkey.
 */

import { migrateFeePayerToPasskey } from '../feePayerSweep';

const FROM = 'GC5S3DWEG3E5KJZDEOBKQE5KE4UKOYCZVOH5ZZNR6RTCSJK7QAOSWTLN';
const FROM_SECRET = 'SBYAGHOUVBAQGNZF2DGXYTRSJZ3GDUDYBXMLEEIGTBMBPWYOOUKDLHMS';
const TO = 'GA2CDKKI5XY575WCB33XCRCGUZZVA6NODDJWHB7VHXVDRYZ356VI6FNW';

const TO_SECRET = 'S_DESTINATION_SECRET';
const params = { from: FROM, fromSecret: FROM_SECRET, to: TO, toSecret: TO_SECRET };

function deps(
  snapshot: { xlm: number | null; subentryCount: number; hasOtherAssets?: boolean } | null,
  send = jest.fn(async () => 'tx-hash'),
) {
  return { loadAccount: jest.fn(async () => snapshot), sendXlm: send };
}

it('moves the full balance (including freed reserves) to the passkey-derived account', async () => {
  const send = jest.fn(async () => 'tx-hash');
  const outcome = await migrateFeePayerToPasskey(params, deps({ xlm: 2.66, subentryCount: 3 }, send));

  expect(outcome).toEqual({
    swept: true,
    amount: '2.6600000',
    txHash: 'tx-hash',
    from: FROM,
    to: TO,
  });
  expect(send).toHaveBeenCalledWith(FROM_SECRET, TO, '2.6600000', TO_SECRET);
});

it('moves USDC even when every drop of XLM is reserve', async () => {
  const send = jest.fn(async () => 'tx-hash');
  const outcome = await migrateFeePayerToPasskey(
    params,
    deps({ xlm: 2.5, subentryCount: 3, hasOtherAssets: true }, send),
  );

  expect(outcome).toMatchObject({ swept: true, amount: '2.5000000' });
  expect(send).toHaveBeenCalledWith(FROM_SECRET, TO, '2.5000000', TO_SECRET);
});

it('reports nothing to move for an account that was never funded', async () => {
  const send = jest.fn(async () => 'tx-hash');
  const outcome = await migrateFeePayerToPasskey(params, deps(null, send));

  expect(outcome).toEqual({ swept: false, reason: 'legacy-empty' });
  expect(send).not.toHaveBeenCalled();
});

it('does nothing when the fee-payer is already the derived one', async () => {
  const send = jest.fn(async () => 'tx-hash');
  const outcome = await migrateFeePayerToPasskey(
    { ...params, to: FROM },
    deps({ xlm: 10, subentryCount: 0 }, send),
  );

  expect(outcome).toEqual({ swept: false, reason: 'same-account' });
  expect(send).not.toHaveBeenCalled();
});

it('reports a failed transfer as failed, so the caller does not adopt the new key', async () => {
  const send = jest.fn(async () => {
    throw new Error('tx failed');
  });
  const outcome = await migrateFeePayerToPasskey(params, deps({ xlm: 6.865085, subentryCount: 3 }, send));

  expect(outcome).toEqual({ swept: false, reason: 'sweep-failed' });
});

it('treats an unreadable account as a failure, not as an empty one', async () => {
  const outcome = await migrateFeePayerToPasskey(params, {
    loadAccount: jest.fn(async () => {
      throw new Error('horizon down');
    }),
    sendXlm: jest.fn(async () => 'tx-hash'),
  });

  expect(outcome).toEqual({ swept: false, reason: 'sweep-failed' });
});
