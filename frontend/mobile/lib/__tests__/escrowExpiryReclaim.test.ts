import { Account, Asset, Horizon, Keypair, Networks, TransactionBuilder } from '@stellar/stellar-sdk';

import {
  ALREADY_CLAIMED_MESSAGE,
  ALREADY_RECLAIMED_MESSAGE,
  BALANCE_NOT_FOUND_MESSAGE,
  CLAIM_LINK_EXPIRY_PRESETS,
  DEFAULT_CLAIM_LINK_EXPIRY_SECONDS,
  EXPIRED_AND_RECLAIMED_MESSAGE,
  HISTORY_CHECK_FAILED_MESSAGE,
  MISSING_CLAIMANT_ACCOUNT_MESSAGE,
  RECLAIM_BEFORE_EXPIRY_MESSAGE,
  ReclaimBeforeExpiryError,
  buildClaimLink,
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
import * as feesModule from '../fees';
import * as signerModule from '../signer';

const SENDER = Keypair.random();
const DEVICE_A = Keypair.random();
const DEVICE_B = Keypair.random();
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

describe('claim link domain, expiry presets, and copy (#1286)', () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('uses APP_HOST (app.useveilapp.xyz) in buildClaimLink and supports optional network parameter', () => {
    expect(buildClaimLink(BALANCE_ID)).toBe(`https://app.useveilapp.xyz/claim/${BALANCE_ID}`);
    expect(buildClaimLink(BALANCE_ID, 'mainnet')).toBe(
      `https://app.useveilapp.xyz/claim/${BALANCE_ID}?network=mainnet`,
    );
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
    expect(created.claimLink).toBe(`https://app.useveilapp.xyz/claim/${BALANCE_ID}`);
    expect(created.expiresAt).toBe(NOW_UNIX + 86_400);
    expect(created.reserveLockedXlm).toBe('1');
  });
});

describe('reclaim-before-expiry refusal and unified requireSigner/inclusionFee reclaim (#1286)', () => {
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

  it('reclaims after expiry using requireSigner() and inclusionFee(), freeing the 1 XLM reserve', async () => {
    const expiresAt = NOW_UNIX - 60;
    const requireSignerSpy = jest.spyOn(signerModule, 'requireSigner').mockResolvedValue({
      publicKey: SENDER.publicKey(),
      sign: (tx) => tx.sign(SENDER),
    });
    const inclusionFeeSpy = jest.spyOn(feesModule, 'inclusionFee').mockReturnValue('100000');

    jest.spyOn(Horizon.Server.prototype, 'claimableBalances').mockReturnValue({
      claimableBalance: () => ({
        call: async () => ({
          id: BALANCE_ID,
          asset: 'native',
          amount: '50.0000000',
          sponsor: SENDER.publicKey(),
          claimants: [
            { destination: DEVICE_A.publicKey(), predicate: { unconditional: true } },
            {
              destination: SENDER.publicKey(),
              predicate: { not: { abs_before_epoch: String(expiresAt) } },
            },
          ],
        }),
      }),
    } as unknown as ReturnType<Horizon.Server['claimableBalances']>);

    jest.spyOn(Horizon.Server.prototype, 'loadAccount').mockResolvedValueOnce(
      new Account(SENDER.publicKey(), '201') as unknown as Horizon.AccountResponse,
    );

    let submittedXdr = '';
    jest.spyOn(Horizon.Server.prototype, 'submitTransaction').mockImplementationOnce(async (tx) => {
      submittedXdr = tx.toXDR();
      return { hash: 'tx_reclaim_signer_fee' } as unknown as Horizon.HorizonApi.SubmitTransactionResponse;
    });

    const outcome = await reclaimEscrowSafely({
      balanceId: BALANCE_ID,
      expiresAt,
      nowUnix: NOW_UNIX,
      config: CONFIG,
    });

    expect(requireSignerSpy).toHaveBeenCalledTimes(1);
    expect(inclusionFeeSpy).toHaveBeenCalled();
    expect(outcome).toEqual({
      status: 'reclaimed',
      txHash: 'tx_reclaim_signer_fee',
      sweptReserveXlm: '1',
    });

    const parsedTx = TransactionBuilder.fromXDR(submittedXdr, Networks.TESTNET);
    expect('fee' in parsedTx ? parsedTx.fee : '').toBe('100000');
    expect('operations' in parsedTx && parsedTx.operations.map((op) => op.type)).toEqual([
      'claimClaimableBalance',
    ]);
  });
});

describe('missing claimant account vs consumed balance, history lookup failure, race, and double reclaim (#1286)', () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('surfaces a plain user-friendly sentence (not "already claimed" or raw "Not Found") when the claimant account does not exist yet', async () => {
    jest.spyOn(Horizon.Server.prototype, 'loadAccount').mockRejectedValueOnce(makeNotFoundError());
    const submitSpy = jest.spyOn(Horizon.Server.prototype, 'submitTransaction');

    await expect(
      claimEscrowOutcome({
        claimantKeypair: DEVICE_A,
        balanceId: BALANCE_ID,
        config: CONFIG,
      }),
    ).rejects.toThrow(MISSING_CLAIMANT_ACCOUNT_MESSAGE);
    expect(submitSpy).not.toHaveBeenCalled();
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

  it('tells the next opener plainly when a link was already claimed or reclaimed, and does NOT say claimed on mistyped IDs, network mismatches, or failed history lookups', async () => {
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

    // History lookup failure -> "could not be checked", NOT "already claimed" or "already reclaimed".
    jest.spyOn(Horizon.Server.prototype, 'operations').mockReturnValueOnce({
      forClaimableBalance: () => ({
        order: () => ({
          limit: () => ({
            call: async () => {
              throw new Error('503 Service Unavailable');
            },
          }),
        }),
      }),
    } as unknown as ReturnType<Horizon.Server['operations']>);

    const failedLookupView = await inspectClaimLinkForOpener(BALANCE_ID, CONFIG, {
      senderAddress: SENDER.publicKey(),
      nowUnix: NOW_UNIX,
    });
    expect(failedLookupView.state).toBe('status_unknown');
    expect(failedLookupView.message).toBe(HISTORY_CHECK_FAILED_MESSAGE);

    // Mistyped ID / wrong network (no claim op in history) -> not_found, NOT "already claimed".
    jest.spyOn(Horizon.Server.prototype, 'operations').mockReturnValueOnce({
      forClaimableBalance: () => ({
        order: () => ({
          limit: () => ({
            call: async () => ({ records: [] }),
          }),
        }),
      }),
    } as unknown as ReturnType<Horizon.Server['operations']>);

    const notFoundView = await inspectClaimLinkForOpener(BALANCE_ID, CONFIG, {
      nowUnix: NOW_UNIX,
    });
    expect(notFoundView.state).toBe('not_found');
    expect(notFoundView.message).toBe(BALANCE_NOT_FOUND_MESSAGE);

    // Explicit link network mismatch -> network_mismatch before querying Horizon.
    const mismatchView = await inspectClaimLinkForOpener(BALANCE_ID, CONFIG, {
      linkNetwork: 'mainnet',
      activeNetwork: 'testnet',
      nowUnix: NOW_UNIX,
    });
    expect(mismatchView.state).toBe('network_mismatch');
    expect(mismatchView.message).toMatch(/Stellar Mainnet.*Stellar Testnet/);
  });

  it('reports status_unknown ("could not be checked") in reclaimEscrowSafely when history lookup fails', async () => {
    jest.spyOn(Horizon.Server.prototype, 'claimableBalances').mockReturnValueOnce({
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
            call: async () => {
              throw new Error('Horizon timeout');
            },
          }),
        }),
      }),
    } as unknown as ReturnType<Horizon.Server['operations']>);

    const res = await reclaimEscrowSafely({
      senderKeypair: SENDER,
      balanceId: BALANCE_ID,
      expiresAt: NOW_UNIX - 300,
      nowUnix: NOW_UNIX,
      config: CONFIG,
    });
    expect(res).toEqual({
      status: 'status_unknown',
      message: HISTORY_CHECK_FAILED_MESSAGE,
    });
  });
});

describe('wallet tied-up links and reserve accounting (#1286)', () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('computes open principal, locked reserves, terminal outcomes, and "Could not be checked" when history lookup fails', async () => {
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
                      predicate: { not: { abs_before_epoch: String(NOW_UNIX + 3_600) } },
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
                call: async () => {
                  if (id === 'cb_history_down') {
                    throw new Error('Horizon 502');
                  }
                  return {
                    records:
                      id === 'cb_reclaimed_old'
                        ? [{ type: 'claim_claimable_balance', claimant: SENDER.publicKey() }]
                        : [{ type: 'claim_claimable_balance', claimant: DEVICE_A.publicKey() }],
                  };
                },
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
          reclaimedBySender: true,
        },
        {
          balanceId: 'cb_history_down',
          amount: '9',
          assetCode: 'XLM',
          assetIssuer: null,
          expiresAt: NOW_UNIX - 500,
          reclaimedBySender: true,
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
      cb_history_down: 'status_unknown',
    });

    const historyDownItem = summary.links.find((l) => l.balanceId === 'cb_history_down');
    expect(historyDownItem?.statusLabel).toBe('Could not be checked');
    expect(historyDownItem?.senderExpiryLabel).toContain('could not be checked');
  });

  it('derives balanceId locally when Horizon omits balance_id and restores missing trustlines on reclaim', async () => {
    jest.spyOn(Horizon.Server.prototype, 'loadAccount').mockResolvedValueOnce(
      new Account(SENDER.publicKey(), '900') as unknown as Horizon.AccountResponse,
    );
    let derivedId = '';
    jest.spyOn(Horizon.Server.prototype, 'submitTransaction').mockImplementationOnce(async (tx) => {
      if ('getClaimableBalanceId' in tx && typeof tx.getClaimableBalanceId === 'function') {
        derivedId = tx.getClaimableBalanceId(0);
      }
      return { hash: 'tx_no_balance_id' } as unknown as Horizon.HorizonApi.SubmitTransactionResponse;
    });

    const created = await createEscrow({
      senderKeypair: SENDER,
      recipientAddress: DEVICE_A.publicKey(),
      amount: '10',
      asset: new Asset('USDC', USDC_ISSUER),
      expiryPreset: '1h',
      nowUnix: NOW_UNIX,
      config: CONFIG,
    });
    expect(created.balanceId).toBe(BALANCE_ID === derivedId ? BALANCE_ID : derivedId);

    // Reclaim when sender's classic account lacks the USDC trustline: prepends changeTrust.
    jest.spyOn(Horizon.Server.prototype, 'claimableBalances').mockReturnValueOnce({
      claimableBalance: () => ({
        call: async () => ({
          id: derivedId,
          asset: `USDC:${USDC_ISSUER}`,
          amount: '10.0000000',
          claimants: [
            {
              destination: SENDER.publicKey(),
              predicate: { not: { abs_before_epoch: String(NOW_UNIX - 60) } },
            },
          ],
        }),
      }),
    } as unknown as ReturnType<Horizon.Server['claimableBalances']>);

    const senderAcct = new Account(SENDER.publicKey(), '901') as unknown as Horizon.AccountResponse;
    (senderAcct as unknown as { balances: unknown[] }).balances = [
      { asset_type: 'native', balance: '20.0000000' },
    ];
    jest.spyOn(Horizon.Server.prototype, 'loadAccount').mockResolvedValueOnce(senderAcct);

    let reclaimXdr = '';
    jest.spyOn(Horizon.Server.prototype, 'submitTransaction').mockImplementationOnce(async (tx) => {
      reclaimXdr = tx.toXDR();
      return { hash: 'tx_reclaim_usdc' } as unknown as Horizon.HorizonApi.SubmitTransactionResponse;
    });

    const outcome = await reclaimEscrowSafely({
      senderKeypair: SENDER,
      balanceId: derivedId,
      nowUnix: NOW_UNIX,
      config: CONFIG,
    });
    expect(outcome).toMatchObject({ status: 'reclaimed', txHash: 'tx_reclaim_usdc' });

    const parsed = TransactionBuilder.fromXDR(reclaimXdr, Networks.TESTNET);
    expect('operations' in parsed && parsed.operations.map((o) => o.type)).toEqual([
      'changeTrust',
      'claimClaimableBalance',
    ]);
  });
});
