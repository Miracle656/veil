import { Account, Asset, Horizon, Keypair, Networks, TransactionBuilder } from '@stellar/stellar-sdk';

import {
  ALREADY_CLAIMED_MESSAGE,
  ALREADY_RECLAIMED_MESSAGE,
  CLAIM_LINK_EXPIRY_PRESETS,
  DEFAULT_CLAIM_LINK_EXPIRY_SECONDS,
  EXPIRED_AND_RECLAIMED_MESSAGE,
  RECLAIM_BEFORE_EXPIRY_MESSAGE,
  ReclaimBeforeExpiryError,
  claimEscrowOutcome,
  createEscrow,
  fetchWalletTiedUpSummary,
  formatClaimLinkExpiryForRecipient,
  formatClaimLinkExpiryForSender,
  inspectClaimLinkForOpener,
  reclaimEscrow,
  reclaimEscrowSafely,
  resolveClaimLinkExpirySeconds,
} from '../escrow';

const SENDER = Keypair.random();
const DEVICE_A = Keypair.random();
const DEVICE_B = Keypair.random();
const EPHEMERAL = Keypair.random();
const USDC_ISSUER = Keypair.random().publicKey();
const BALANCE_ID = '00000000aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';

const CONFIG = {
  horizonUrl: 'https://horizon-testnet.stellar.org',
  networkPassphrase: Networks.TESTNET,
};

const NOW_UNIX = 1_760_000_000;

function makeHorizonOpError(opCode: string) {
  const err = new Error(`Horizon rejected operation: ${opCode}`) as Error & {
    response?: {
      status: number;
      data: {
        extras: {
          result_codes: {
            transaction: string;
            operations: string[];
          };
        };
      };
    };
  };
  err.response = {
    status: 400,
    data: {
      extras: {
        result_codes: {
          transaction: 'tx_failed',
          operations: [opCode],
        },
      },
    },
  };
  return err;
}

function makeNotFoundError() {
  const err = new Error('Not Found') as Error & { response?: { status: number } };
  err.name = 'NotFoundError';
  err.response = { status: 404 };
  return err;
}

describe('claim link expiry presets and copy (#1286)', () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('offers a short preset list with a 7-day default', () => {
    expect(CLAIM_LINK_EXPIRY_PRESETS.map((p) => p.id)).toEqual(['1h', '24h', '7d', '30d']);
    expect(resolveClaimLinkExpirySeconds()).toBe(DEFAULT_CLAIM_LINK_EXPIRY_SECONDS);
    expect(resolveClaimLinkExpirySeconds('1h')).toBe(3_600);
    expect(resolveClaimLinkExpirySeconds('24h')).toBe(86_400);
    expect(resolveClaimLinkExpirySeconds('30d')).toBe(2_592_000);
    expect(() => resolveClaimLinkExpirySeconds(0)).toThrow(/positive/i);
  });

  it('formats distinct, clear expiry copy for sender and recipient', () => {
    const expiresAt = NOW_UNIX + 86_400;
    expect(formatClaimLinkExpiryForSender(expiresAt, NOW_UNIX)).toContain('Expires in 1d');
    expect(formatClaimLinkExpiryForSender(expiresAt, NOW_UNIX)).toContain(
      'reclaim unlocks after expiry',
    );
    expect(formatClaimLinkExpiryForRecipient(expiresAt, NOW_UNIX)).toBe('Claim within 1d');

    expect(formatClaimLinkExpiryForSender(expiresAt, expiresAt + 7_200)).toContain(
      'ready to reclaim',
    );
    expect(formatClaimLinkExpiryForRecipient(expiresAt, expiresAt + 7_200)).toContain(
      'sender can now reclaim',
    );
  });

  it('creates an escrow using the chosen preset and reports locked reserve', async () => {
    jest.spyOn(Horizon.Server.prototype, 'loadAccount').mockResolvedValueOnce(
      new Account(SENDER.publicKey(), '100') as unknown as Horizon.AccountResponse,
    );
    jest.spyOn(Horizon.Server.prototype, 'submitTransaction').mockResolvedValueOnce({
      hash: 'tx_create_1',
      balance_id: BALANCE_ID,
    } as unknown as Horizon.HorizonApi.SubmitTransactionResponse);

    const created = await createEscrow({
      senderKeypair: SENDER,
      recipientAddress: DEVICE_A.publicKey(),
      amount: '25',
      asset: Asset.native(),
      expiryPreset: '24h',
      nowUnix: NOW_UNIX,
      config: CONFIG,
    });

    expect(created.balanceId).toBe(BALANCE_ID);
    expect(created.expiresAt).toBe(NOW_UNIX + 86_400);
    expect(created.reserveLockedXlm).toBe('1');
  });
});

describe('reclaim-before-expiry refusal and post-expiry reserve sweep (#1286)', () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('refuses reclaim before expiry without submitting a transaction', async () => {
    const submitSpy = jest.spyOn(Horizon.Server.prototype, 'submitTransaction');
    const expiresAt = NOW_UNIX + 3_600;

    const safe = await reclaimEscrowSafely({
      senderKeypair: SENDER,
      balanceId: BALANCE_ID,
      expiresAt,
      nowUnix: NOW_UNIX,
      config: CONFIG,
    });

    expect(safe).toEqual({
      status: 'before_expiry',
      expiresAt,
      remainingSeconds: 3_600,
      message: RECLAIM_BEFORE_EXPIRY_MESSAGE,
    });
    expect(submitSpy).not.toHaveBeenCalled();

    await expect(
      reclaimEscrow({
        senderKeypair: SENDER,
        balanceId: BALANCE_ID,
        expiresAt,
        nowUnix: NOW_UNIX,
        config: CONFIG,
      }),
    ).rejects.toBeInstanceOf(ReclaimBeforeExpiryError);
  });

  it('also refuses reclaim when the on-chain predicate deadline is still in the future', async () => {
    const onChainDeadline = NOW_UNIX + 1_800;
    jest.spyOn(Horizon.Server.prototype, 'claimableBalances').mockReturnValue({
      claimableBalance: () => ({
        call: async () => ({
          id: BALANCE_ID,
          asset: 'native',
          amount: '15.0000000',
          sponsor: SENDER.publicKey(),
          claimants: [
            { destination: DEVICE_A.publicKey(), predicate: { unconditional: true } },
            {
              destination: SENDER.publicKey(),
              predicate: { not: { abs_before_epoch: String(onChainDeadline) } },
            },
          ],
        }),
      }),
    } as unknown as ReturnType<Horizon.Server['claimableBalances']>);
    const submitSpy = jest.spyOn(Horizon.Server.prototype, 'submitTransaction');

    const res = await reclaimEscrowSafely({
      senderKeypair: SENDER,
      balanceId: BALANCE_ID,
      nowUnix: NOW_UNIX,
      config: CONFIG,
    });

    expect(res.status).toBe('before_expiry');
    expect(submitSpy).not.toHaveBeenCalled();
  });

  it('reclaims after expiry and sweeps ephemeral account dust, trustline, and base reserve', async () => {
    const expiresAt = NOW_UNIX - 60;
    jest.spyOn(Horizon.Server.prototype, 'claimableBalances').mockReturnValue({
      claimableBalance: () => ({
        call: async () => ({
          id: BALANCE_ID,
          asset: `USDC:${USDC_ISSUER}`,
          amount: '50.0000000',
          sponsor: SENDER.publicKey(),
          claimants: [
            { destination: EPHEMERAL.publicKey(), predicate: { unconditional: true } },
            {
              destination: SENDER.publicKey(),
              predicate: { not: { abs_before_epoch: String(expiresAt) } },
            },
          ],
        }),
      }),
    } as unknown as ReturnType<Horizon.Server['claimableBalances']>);

    let seq = 200;
    jest.spyOn(Horizon.Server.prototype, 'loadAccount').mockImplementation(async (pubKey: string) => {
      seq += 1;
      const acct = new Account(pubKey, String(seq)) as unknown as Horizon.AccountResponse;
      if (pubKey === EPHEMERAL.publicKey()) {
        (acct as unknown as { balances: unknown[] }).balances = [
          {
            asset_type: 'credit_alphanum4',
            asset_code: 'USDC',
            asset_issuer: USDC_ISSUER,
            balance: '0.2500000',
          },
          {
            asset_type: 'native',
            balance: '1.5000000',
          },
        ];
      }
      return acct;
    });

    let submittedXdr = '';
    jest.spyOn(Horizon.Server.prototype, 'submitTransaction').mockImplementation(async (tx) => {
      submittedXdr = tx.toXDR();
      return { hash: 'tx_reclaim_swept' } as unknown as Horizon.HorizonApi.SubmitTransactionResponse;
    });

    const outcome = await reclaimEscrowSafely({
      senderKeypair: SENDER,
      balanceId: BALANCE_ID,
      expiresAt,
      ephemeralKeypair: EPHEMERAL,
      nowUnix: NOW_UNIX,
      config: CONFIG,
    });

    expect(outcome).toEqual({
      status: 'reclaimed',
      txHash: 'tx_reclaim_swept',
      // 1.0 XLM claimable balance + 1.0 XLM ephemeral base + 0.5 XLM USDC trustline = 2.5 XLM
      sweptReserveXlm: '2.5',
      sweptEphemeralAccount: true,
    });

    const parsedTx = TransactionBuilder.fromXDR(submittedXdr, Networks.TESTNET);
    const opTypes = parsedTx.operations.map((op) => op.type);
    expect(opTypes).toEqual([
      'claimClaimableBalance',
      'payment',
      'changeTrust',
      'accountMerge',
    ]);
    expect(parsedTx.signatures).toHaveLength(2);
  });
});

describe('race conditions, double reclaim, and second-opener messages (#1286)', () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('produces one claim and one clear refusal when two devices race the same link', async () => {
    let settled = false;
    let seq = 10;

    jest.spyOn(Horizon.Server.prototype, 'loadAccount').mockImplementation(async (pubKey: string) => {
      seq += 1;
      return new Account(pubKey, String(seq)) as unknown as Horizon.AccountResponse;
    });

    jest.spyOn(Horizon.Server.prototype, 'submitTransaction').mockImplementation(async () => {
      await Promise.resolve();
      if (!settled) {
        settled = true;
        return { hash: 'winner_tx_hash' } as unknown as Horizon.HorizonApi.SubmitTransactionResponse;
      }
      throw makeHorizonOpError('op_does_not_exist');
    });

    const [first, second] = await Promise.all([
      claimEscrowOutcome({ claimantKeypair: DEVICE_A, balanceId: BALANCE_ID, config: CONFIG }),
      claimEscrowOutcome({ claimantKeypair: DEVICE_B, balanceId: BALANCE_ID, config: CONFIG }),
    ]);

    const outcomes = [first, second];
    const winners = outcomes.filter((o) => o.status === 'claimed');
    const losers = outcomes.filter((o) => o.status === 'already_claimed');

    expect(winners).toHaveLength(1);
    expect(losers).toHaveLength(1);
    expect(losers[0]).toEqual({
      status: 'already_claimed',
      message: ALREADY_CLAIMED_MESSAGE,
    });
  });

  it('handles double reclaim cleanly: first succeeds, second reports already reclaimed', async () => {
    const expiresAt = NOW_UNIX - 120;
    let balanceConsumed = false;
    let seq = 50;

    jest.spyOn(Horizon.Server.prototype, 'claimableBalances').mockReturnValue({
      claimableBalance: () => ({
        call: async () => {
          if (balanceConsumed) {
            throw makeNotFoundError();
          }
          return {
            id: BALANCE_ID,
            asset: 'native',
            amount: '10.0000000',
            sponsor: SENDER.publicKey(),
            claimants: [
              { destination: DEVICE_A.publicKey(), predicate: { unconditional: true } },
              {
                destination: SENDER.publicKey(),
                predicate: { not: { abs_before_epoch: String(expiresAt) } },
              },
            ],
          };
        },
      }),
    } as unknown as ReturnType<Horizon.Server['claimableBalances']>);

    jest.spyOn(Horizon.Server.prototype, 'operations').mockReturnValue({
      forClaimableBalance: () => ({
        order: () => ({
          limit: () => ({
            call: async () => ({
              records: balanceConsumed
                ? [{ type: 'claim_claimable_balance', claimant: SENDER.publicKey() }]
                : [],
            }),
          }),
        }),
      }),
    } as unknown as ReturnType<Horizon.Server['operations']>);

    jest.spyOn(Horizon.Server.prototype, 'loadAccount').mockImplementation(async (pubKey: string) => {
      seq += 1;
      return new Account(pubKey, String(seq)) as unknown as Horizon.AccountResponse;
    });

    jest.spyOn(Horizon.Server.prototype, 'submitTransaction').mockImplementation(async () => {
      if (!balanceConsumed) {
        balanceConsumed = true;
        return { hash: 'reclaim_winner_hash' } as unknown as Horizon.HorizonApi.SubmitTransactionResponse;
      }
      throw makeHorizonOpError('op_does_not_exist');
    });

    const [attemptOne, attemptTwo] = await Promise.all([
      reclaimEscrowSafely({
        senderKeypair: SENDER,
        balanceId: BALANCE_ID,
        expiresAt,
        nowUnix: NOW_UNIX,
        config: CONFIG,
      }),
      reclaimEscrowSafely({
        senderKeypair: SENDER,
        balanceId: BALANCE_ID,
        expiresAt,
        nowUnix: NOW_UNIX,
        config: CONFIG,
      }),
    ]);

    expect([attemptOne.status, attemptTwo.status].sort()).toEqual([
      'already_reclaimed',
      'reclaimed',
    ]);
    const secondTry = await reclaimEscrowSafely({
      senderKeypair: SENDER,
      balanceId: BALANCE_ID,
      expiresAt,
      nowUnix: NOW_UNIX,
      config: CONFIG,
    });
    expect(secondTry).toEqual({
      status: 'already_reclaimed',
      message: ALREADY_RECLAIMED_MESSAGE,
    });
  });

  it('tells the next opener plainly when a link was already claimed or reclaimed', async () => {
    jest.spyOn(Horizon.Server.prototype, 'claimableBalances').mockReturnValue({
      claimableBalance: () => ({
        call: async () => {
          throw makeNotFoundError();
        },
      }),
    } as unknown as ReturnType<Horizon.Server['claimableBalances']>);

    jest.spyOn(Horizon.Server.prototype, 'operations').mockReturnValueOnce({
      forClaimableBalance: () => ({
        order: () => ({
          limit: () => ({
            call: async () => ({
              records: [{ type: 'claim_claimable_balance', claimant: DEVICE_A.publicKey() }],
            }),
          }),
        }),
      }),
    } as unknown as ReturnType<Horizon.Server['operations']>);

    const claimedView = await inspectClaimLinkForOpener(BALANCE_ID, CONFIG, {
      senderAddress: SENDER.publicKey(),
      nowUnix: NOW_UNIX,
    });
    expect(claimedView.state).toBe('claimed_by_other');
    expect(claimedView.message).toBe(ALREADY_CLAIMED_MESSAGE);

    jest.spyOn(Horizon.Server.prototype, 'operations').mockReturnValueOnce({
      forClaimableBalance: () => ({
        order: () => ({
          limit: () => ({
            call: async () => ({
              records: [{ type: 'claim_claimable_balance', claimant: SENDER.publicKey() }],
            }),
          }),
        }),
      }),
    } as unknown as ReturnType<Horizon.Server['operations']>);

    const reclaimedView = await inspectClaimLinkForOpener(BALANCE_ID, CONFIG, {
      senderAddress: SENDER.publicKey(),
      nowUnix: NOW_UNIX,
    });
    expect(reclaimedView.state).toBe('expired_and_reclaimed');
    expect(reclaimedView.message).toBe(EXPIRED_AND_RECLAIMED_MESSAGE);
  });
});

describe('wallet tied-up links and reserve accounting (#1286)', () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('computes open principal, locked reserves, and terminal outcomes from Horizon', async () => {
    jest.spyOn(Horizon.Server.prototype, 'claimableBalances').mockReturnValue({
      sponsor: () => ({
        limit: () => ({
          order: () => ({
            call: async () => ({
              records: [
                {
                  id: 'cb_active_xlm',
                  asset: 'native',
                  amount: '12.5000000',
                  sponsor: SENDER.publicKey(),
                  claimants: [
                    { destination: DEVICE_A.publicKey(), predicate: { unconditional: true } },
                    {
                      destination: SENDER.publicKey(),
                      predicate: { not: { abs_before_epoch: String(NOW_UNIX + 7_200) } },
                    },
                  ],
                },
                {
                  id: 'cb_expired_xlm',
                  asset: 'native',
                  amount: '7.2500000',
                  sponsor: SENDER.publicKey(),
                  claimants: [
                    { destination: DEVICE_B.publicKey(), predicate: { unconditional: true } },
                    {
                      destination: SENDER.publicKey(),
                      predicate: { not: { abs_before_epoch: String(NOW_UNIX - 300) } },
                    },
                  ],
                },
              ],
            }),
          }),
        }),
      }),
    } as unknown as ReturnType<Horizon.Server['claimableBalances']>);

    jest.spyOn(Horizon.Server.prototype, 'operations').mockImplementation(
      () =>
        ({
          forClaimableBalance: (id: string) => ({
            order: () => ({
              limit: () => ({
                call: async () => ({
                  records:
                    id === 'cb_reclaimed_old'
                      ? [{ type: 'claim_claimable_balance', claimant: SENDER.publicKey() }]
                      : [{ type: 'claim_claimable_balance', claimant: DEVICE_A.publicKey() }],
                }),
              }),
            }),
          }),
        }) as unknown as ReturnType<Horizon.Server['operations']>,
    );

    const summary = await fetchWalletTiedUpSummary(SENDER.publicKey(), CONFIG, {
      nowUnix: NOW_UNIX,
      knownLinks: [
        {
          balanceId: 'cb_claimed_old',
          amount: '5',
          assetCode: 'XLM',
          assetIssuer: null,
          expiresAt: NOW_UNIX - 1_000,
        },
        {
          balanceId: 'cb_reclaimed_old',
          amount: '3',
          assetCode: 'XLM',
          assetIssuer: null,
          expiresAt: NOW_UNIX - 2_000,
        },
      ],
    });

    expect(summary.openLinkCount).toBe(2);
    expect(summary.activeLinkCount).toBe(1);
    expect(summary.expiredUnreclaimedCount).toBe(1);
    expect(summary.lockedReserveXlm).toBe('2');
    expect(summary.reclaimableReserveXlm).toBe('1');
    expect(summary.assets).toEqual([
      {
        assetKey: 'XLM:native',
        assetCode: 'XLM',
        assetIssuer: null,
        totalAmount: '19.75',
        reclaimableAmount: '7.25',
        linkCount: 2,
      },
    ]);

    const statesById = Object.fromEntries(summary.links.map((l) => [l.balanceId, l.state]));
    expect(statesById).toEqual({
      cb_active_xlm: 'active',
      cb_expired_xlm: 'expired_unreclaimed',
      cb_claimed_old: 'claimed_by_other',
      cb_reclaimed_old: 'expired_and_reclaimed',
    });
  });
});
