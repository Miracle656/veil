import AsyncStorage from '@react-native-async-storage/async-storage';
import { Account, Horizon, Keypair, Networks, Operation, TransactionBuilder } from '@stellar/stellar-sdk';

import { ASSOCIATED_DOMAINS } from '../deepLinks';
import type { WalletSigner } from '../sendPayment';
import {
  BEARER_LINK_WARNING,
  MAX_CLAIM_LINK_NOTE_LENGTH,
  createSenderClaimLink,
  estimateClaimLinkCost,
  loadSenderClaimLinksOnChain,
  reclaimSenderClaimLink,
  resetClaimLinkIdempotencyForTests,
  validateClaimLinkNote,
} from '../sendClaimLink';

const SENDER = Keypair.random();
const RECIPIENT = Keypair.random();
const BALANCE_ID = `00000000${'b'.repeat(64)}`;
const CB_CLAIMED = `00000000${'1'.repeat(64)}`;
const CB_RECLAIMED = `00000000${'2'.repeat(64)}`;
const CB_UNCLAIMED = `00000000${'3'.repeat(64)}`;
const CB_EXPIRED = `00000000${'4'.repeat(64)}`;
const NOW_UNIX = 1_760_100_000;

function makeSigner(kp: Keypair): WalletSigner {
  return {
    publicKey: kp.publicKey(),
    sign: (tx) => {
      tx.sign(kp);
    },
  };
}

describe('validateClaimLinkNote — phishing and markup lockdown (#1285)', () => {
  it('accepts empty notes and short plain-text messages', () => {
    expect(validateClaimLinkNote('')).toBeNull();
    expect(validateClaimLinkNote(undefined)).toBeNull();
    expect(validateClaimLinkNote('For lunch in Lekki')).toBeNull();
    expect(validateClaimLinkNote('a'.repeat(MAX_CLAIM_LINK_NOTE_LENGTH))).toBeNull();
  });

  it('refuses notes past the length cap', () => {
    expect(validateClaimLinkNote('a'.repeat(MAX_CLAIM_LINK_NOTE_LENGTH + 1))).toMatch(
      /80 characters/i,
    );
  });

  it.each([
    ['https URL', 'Claim bonus at https://evil.example/login'],
    ['http URL', 'Visit http://phish.org now'],
    ['www host', 'Verify at www.veil-support.com'],
    ['bare domain', 'Tap app.veil.xyz to double'],
    ['shortener domain', 'Open bit.ly/claim-now'],
    ['custom scheme', 'Open veil://send?to=GABC'],
    ['javascript URI', 'javascript:alert(1)'],
    ['IPv4 address', 'Go to 192.168.1.10/verify'],
  ])('refuses %s in a note', (_kind, input) => {
    expect(validateClaimLinkNote(input)).toMatch(/cannot include links|web addresses/i);
  });

  it.each([
    ['HTML tag', '<b>Urgent</b> verify wallet'],
    ['script tag', '<script>steal()</script>'],
    ['HTML entity', 'Click &amp; confirm'],
    ['Markdown link', '[Claim twice](spots)'],
    ['inline code backtick', 'Run `approve`'],
  ])('refuses %s markup in a note', (_kind, input) => {
    expect(validateClaimLinkNote(input)).toMatch(/no HTML|markup/i);
  });

  it('refuses control characters and embedded newlines', () => {
    expect(validateClaimLinkNote('Line 1\nLine 2')).toMatch(/line breaks|control/i);
  });
});

describe('estimateClaimLinkCost (#1285)', () => {
  it('shows amount, refundable 1 XLM reserve, and exact network fee', () => {
    const xlmCost = estimateClaimLinkCost('12.5', 'XLM', '1000');
    expect(xlmCost).toEqual({
      amount: '12.5',
      assetCode: 'XLM',
      reserveXlm: '1',
      feeXlm: '0.0001',
      totalXlmRequired: '13.5001',
    });

    const usdcCost = estimateClaimLinkCost('50', 'USDC', '1000');
    expect(usdcCost).toEqual({
      amount: '50',
      assetCode: 'USDC',
      reserveXlm: '1',
      feeXlm: '0.0001',
      totalXlmRequired: '1.0001',
    });
    expect(BEARER_LINK_WARNING).toBe('Anyone with this link can claim it.');
  });
});

describe('createSenderClaimLink — idempotency and end-to-end claimability (#1285)', () => {
  beforeEach(async () => {
    await AsyncStorage.clear();
    resetClaimLinkIdempotencyForTests();
    jest.restoreAllMocks();
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('produces one link and one Horizon submission when double-tapped with the same confirmationId', async () => {
    jest.spyOn(Horizon.Server.prototype, 'loadAccount').mockResolvedValue(
      new Account(SENDER.publicKey(), '300') as unknown as Horizon.AccountResponse,
    );
    const submitSpy = jest
      .spyOn(Horizon.Server.prototype, 'submitTransaction')
      .mockImplementation(async () => {
        await Promise.resolve();
        return {
          hash: 'tx_single_link',
          balance_id: BALANCE_ID,
        } as unknown as Horizon.HorizonApi.SubmitTransactionResponse;
      });

    const input = {
      confirmationId: 'confirm_session_1',
      signer: makeSigner(SENDER),
      amount: '15',
      note: 'Taxi split',
      nowUnix: NOW_UNIX,
    };

    const [first, second] = await Promise.all([
      createSenderClaimLink(input),
      createSenderClaimLink(input),
    ]);

    expect(submitSpy).toHaveBeenCalledTimes(1);
    expect(first.balanceId).toBe(BALANCE_ID);
    expect(second.balanceId).toBe(BALANCE_ID);
    expect(first.claimUrl).toBe(second.claimUrl);
    expect(first.claimUrl.startsWith(`https://${ASSOCIATED_DOMAINS[0]}/claim/${BALANCE_ID}?`)).toBe(
      true,
    );
  });

  it('creates, shares, and claims end-to-end using the ephemeral secret in the URL fragment', async () => {
    let submittedCreateXdr = '';
    jest.spyOn(Horizon.Server.prototype, 'loadAccount').mockImplementation(
      async (pubKey: string) => new Account(pubKey, '400') as unknown as Horizon.AccountResponse,
    );
    jest
      .spyOn(Horizon.Server.prototype, 'submitTransaction')
      .mockImplementationOnce(async (tx) => {
        submittedCreateXdr = tx.toXDR();
        return {
          hash: 'tx_create_e2e',
          balance_id: BALANCE_ID,
        } as unknown as Horizon.HorizonApi.SubmitTransactionResponse;
      })
      .mockImplementationOnce(async () => {
        return {
          hash: 'tx_claim_e2e',
        } as unknown as Horizon.HorizonApi.SubmitTransactionResponse;
      });

    const created = await createSenderClaimLink({
      confirmationId: 'confirm_e2e',
      signer: makeSigner(SENDER),
      amount: '20',
      note: 'Happy birthday',
      nowUnix: NOW_UNIX,
    });

    const fragment = created.claimUrl.split('#')[1] ?? '';
    expect(fragment.startsWith('s=S')).toBe(true);
    const ephemeralSecret = decodeURIComponent(fragment.slice(2));
    const ephemeralKeypair = Keypair.fromSecret(ephemeralSecret);

    // Verify the created transaction named the ephemeral keypair as unconditional claimant.
    const createTx = TransactionBuilder.fromXDR(submittedCreateXdr, Networks.TESTNET);
    const createOp = createTx.operations[0] as Operation.CreateClaimableBalance;
    expect(createOp.type).toBe('createClaimableBalance');
    expect(createOp.claimants[0].destination).toBe(ephemeralKeypair.publicKey());
    expect(createOp.claimants[1].destination).toBe(SENDER.publicKey());

    // Simulate recipient claiming with the link's ephemeral keypair and sweeping to RECIPIENT.
    const recipientServer = new Horizon.Server('https://horizon-testnet.stellar.org');
    const recipientAcct = await recipientServer.loadAccount(RECIPIENT.publicKey());
    const claimTx = new TransactionBuilder(recipientAcct, {
      fee: '100',
      networkPassphrase: Networks.TESTNET,
    })
      .addOperation(
        Operation.claimClaimableBalance({
          balanceId: created.balanceId,
          source: ephemeralKeypair.publicKey(),
        }),
      )
      .addOperation(
        Operation.accountMerge({
          destination: RECIPIENT.publicKey(),
          source: ephemeralKeypair.publicKey(),
        }),
      )
      .setTimeout(60)
      .build();
    claimTx.sign(RECIPIENT);
    claimTx.sign(ephemeralKeypair);
    const claimRes = await recipientServer.submitTransaction(claimTx);
    expect(claimRes.hash).toBe('tx_claim_e2e');
  });
});

describe('loadSenderClaimLinksOnChain — real Horizon state over local guesses (#1285)', () => {
  beforeEach(async () => {
    await AsyncStorage.clear();
    resetClaimLinkIdempotencyForTests();
    jest.restoreAllMocks();
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('reflects real on-chain Horizon state (unclaimed, expired, claimed, reclaimed) and supports post-expiry reclaim', async () => {
    // Store two historical links locally; Horizon will report one consumed by RECIPIENT
    // and also return two live sponsored balances (one active, one expired) that were
    // not even in local storage yet.
    await AsyncStorage.setItem(
      `veil_created_claim_links_v1:${SENDER.publicKey()}`,
      JSON.stringify([
        {
          balanceId: CB_CLAIMED,
          claimUrl: `https://app.useveilapp.xyz/claim/${CB_CLAIMED}`,
          amount: '8',
          assetCode: 'XLM',
          assetIssuer: null,
          expiresAt: NOW_UNIX + 3_600,
          createdAt: NOW_UNIX - 600,
          note: 'Coffee',
        },
        {
          balanceId: CB_RECLAIMED,
          claimUrl: `https://app.useveilapp.xyz/claim/${CB_RECLAIMED}`,
          amount: '12',
          assetCode: 'XLM',
          assetIssuer: null,
          expiresAt: NOW_UNIX - 3_600,
          createdAt: NOW_UNIX - 7_200,
          note: null,
        },
      ]),
    );

    jest.spyOn(Horizon.Server.prototype, 'claimableBalances').mockReturnValue({
      sponsor: () => ({
        limit: () => ({
          order: () => ({
            call: async () => ({
              records: [
                {
                  id: CB_UNCLAIMED,
                  asset: 'native',
                  amount: '5.0000000',
                  sponsor: SENDER.publicKey(),
                  claimants: [
                    { destination: RECIPIENT.publicKey(), predicate: { unconditional: true } },
                    {
                      destination: SENDER.publicKey(),
                      predicate: { not: { abs_before_epoch: String(NOW_UNIX + 86_400) } },
                    },
                  ],
                },
                {
                  id: CB_EXPIRED,
                  asset: 'native',
                  amount: '9.0000000',
                  sponsor: SENDER.publicKey(),
                  claimants: [
                    { destination: RECIPIENT.publicKey(), predicate: { unconditional: true } },
                    {
                      destination: SENDER.publicKey(),
                      predicate: { not: { abs_before_epoch: String(NOW_UNIX - 10) } },
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
                    id === CB_RECLAIMED
                      ? [{ type: 'claim_claimable_balance', claimant: SENDER.publicKey() }]
                      : [{ type: 'claim_claimable_balance', claimant: RECIPIENT.publicKey() }],
                }),
              }),
            }),
          }),
        }) as unknown as ReturnType<Horizon.Server['operations']>,
    );

    const list = await loadSenderClaimLinksOnChain(SENDER.publicKey(), { nowUnix: NOW_UNIX });
    const byId = Object.fromEntries(list.map((i) => [i.balanceId, i]));

    expect(byId[CB_UNCLAIMED].status).toBe('unclaimed');
    expect(byId[CB_UNCLAIMED].canReclaim).toBe(false);

    expect(byId[CB_EXPIRED].status).toBe('expired');
    expect(byId[CB_EXPIRED].canReclaim).toBe(true);

    // Locally stored with future expiresAt, yet Horizon shows it is already gone -> 'claimed'!
    expect(byId[CB_CLAIMED].status).toBe('claimed');
    expect(byId[CB_RECLAIMED].status).toBe('reclaimed');

    // Reclaim before expiry is refused; post-expiry reclaim succeeds.
    await expect(
      reclaimSenderClaimLink({
        signer: makeSigner(SENDER),
        balanceId: CB_UNCLAIMED,
        expiresAt: NOW_UNIX + 86_400,
        nowUnix: NOW_UNIX,
      }),
    ).rejects.toThrow(/not expired yet/i);

    jest.spyOn(Horizon.Server.prototype, 'loadAccount').mockResolvedValueOnce(
      new Account(SENDER.publicKey(), '500') as unknown as Horizon.AccountResponse,
    );
    jest.spyOn(Horizon.Server.prototype, 'submitTransaction').mockResolvedValueOnce({
      hash: 'tx_reclaimed_ok',
    } as unknown as Horizon.HorizonApi.SubmitTransactionResponse);

    const reclaimed = await reclaimSenderClaimLink({
      signer: makeSigner(SENDER),
      balanceId: CB_EXPIRED,
      expiresAt: NOW_UNIX - 10,
      nowUnix: NOW_UNIX,
    });
    expect(reclaimed.txHash).toBe('tx_reclaimed_ok');
  });
});
