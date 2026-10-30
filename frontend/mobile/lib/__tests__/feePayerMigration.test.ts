/**
 * Moving a wallet off a fee-payer that cannot be rebuilt from its passkey.
 *
 * Build 10 and earlier read the SDK's credential id from the BARE AsyncStorage
 * key while the storage adapter was already writing it per network. On mainnet
 * that read returned null, PRF was never attempted, and creation fell through
 * to `Keypair.random()`. The result is a gas account that exists in exactly one
 * secure store and is derived from nothing — it dies with the install, and a
 * real user lost a funded one that way.
 *
 * No backup covers this. The encrypted backup holds the wallet address, the
 * signer PUBLIC keys and settings; a private key is never in it. So the only
 * repair is to move the balance onto the passkey-derived account while the old
 * key still exists.
 *
 * The ordering is the whole point: adopting the derived key while the money is
 * still on the old account would put that balance beyond every future install.
 */

import { migrateFeePayerToPasskey } from '../feePayerSweep';
import { retainedForSweep } from '../feePayerRecovery';

const FROM = 'GC5S3DWEG3E5KJZDEOBKQE5KE4UKOYCZVOH5ZZNR6RTCSJK7QAOSWTLN';
const FROM_SECRET = 'SBYAGHOUVBAQGNZF2DGXYTRSJZ3GDUDYBXMLEEIGTBMBPWYOOUKDLHMS';
const TO = 'GA2CDKKI5XY575WCB33XCRCGUZZVA6NODDJWHB7VHXVDRYZ356VI6FNW';

const params = { from: FROM, fromSecret: FROM_SECRET, to: TO };

function deps(snapshot: { xlm: number | null; subentryCount: number } | null, send = jest.fn(async () => 'tx-hash')) {
  return { loadAccount: jest.fn(async () => snapshot), sendXlm: send };
}

it('moves everything above the reserve to the passkey-derived account', async () => {
  // The real figures from the account this was written for.
  const send = jest.fn(async () => 'tx-hash');
  const outcome = await migrateFeePayerToPasskey(params, deps({ xlm: 6.865085, subentryCount: 3 }, send));

  expect(outcome).toEqual({
    swept: true,
    amount: '4.2650850',
    txHash: 'tx-hash',
    from: FROM,
    to: TO,
  });
  expect(send).toHaveBeenCalledWith(FROM_SECRET, TO, '4.2650850');
});

it('leaves the account able to pay a fee afterwards', async () => {
  const send = jest.fn(async () => 'tx-hash');
  await migrateFeePayerToPasskey(params, deps({ xlm: 6.865085, subentryCount: 3 }, send));

  const moved = Number((send.mock.calls[0] as unknown as [string, string, string])[2]);
  expect(6.865085 - moved).toBeCloseTo(retainedForSweep(3), 7);
});

it('reports nothing to move for an account that was never funded', async () => {
  const send = jest.fn(async () => 'tx-hash');
  const outcome = await migrateFeePayerToPasskey(params, deps(null, send));

  expect(outcome).toEqual({ swept: false, reason: 'legacy-empty' });
  expect(send).not.toHaveBeenCalled();
});

it('refuses when the balance is entirely its own reserve', async () => {
  const send = jest.fn(async () => 'tx-hash');
  const outcome = await migrateFeePayerToPasskey(params, deps({ xlm: 2.0, subentryCount: 3 }, send));

  expect(outcome).toEqual({ swept: false, reason: 'below-reserve' });
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
  // The money has not moved. Swapping the signer here would strand it exactly
  // as the old `funded` refusal was written to prevent.
  const send = jest.fn(async () => { throw new Error('tx failed'); });
  const outcome = await migrateFeePayerToPasskey(params, deps({ xlm: 6.865085, subentryCount: 3 }, send));

  expect(outcome).toEqual({ swept: false, reason: 'sweep-failed' });
});

it('treats an unreadable account as a failure, not as an empty one', async () => {
  // Horizon being unreachable must not read as "nothing to move" — that would
  // let the caller adopt the derived key and abandon a funded account.
  const outcome = await migrateFeePayerToPasskey(params, {
    loadAccount: jest.fn(async () => { throw new Error('horizon down'); }),
    sendXlm: jest.fn(async () => 'tx-hash'),
  });

  expect(outcome).toEqual({ swept: false, reason: 'sweep-failed' });
});
