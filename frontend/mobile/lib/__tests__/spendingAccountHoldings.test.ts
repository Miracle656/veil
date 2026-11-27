/**
 * A Veil user has two accounts, and a name or a figure can be on either.
 *
 * The case these tests exist for is real (2026-11-10): the web wallet bought
 * the name `jack` and Veil-ian #9 AS the spending account, because the wallet
 * was made on a phone and the web cannot use its passkey. The phone then read
 * only the smart wallet, told that user "Veil-ians are for name holders", and
 * showed an empty gallery.
 */

import { Keypair, StrKey, scValToNative, type xdr } from '@stellar/stellar-sdk';

import { invokeAsSpendingAccount, simulateRead } from '../contractInvoke';
import { nameState } from '../names';
import {
  type BuyerState,
  buyFigureFromSpending,
  choosePurchase,
  collectionContractId,
  namesContractId,
  readPurchase,
  usdcContractId,
} from '../veilIans';
import { fetchOwnedVeilIans } from '../veilIansOwned';

jest.mock('../contractInvoke', () => ({
  simulateRead: jest.fn(),
  invokeAsWallet: jest.fn(),
  invokeAsSpendingAccount: jest.fn(),
}));
jest.mock('../network', () => ({ getNetwork: () => ({ name: 'mainnet' }) }));

const read = simulateRead as jest.MockedFunction<typeof simulateRead>;
const invoke = invokeAsSpendingAccount as jest.MockedFunction<typeof invokeAsSpendingAccount>;

// Generated per run: nothing here is a real account.
const WALLET = StrKey.encodeContract(Buffer.alloc(32, 7));
const SPENDING = Keypair.random().publicKey();
const STRANGER = Keypair.random().publicKey();

const PRICE = 50_000_000n;

function state(over: Partial<BuyerState> = {}): BuyerState {
  return {
    hasName: false,
    balanceStroops: 100_000_000n,
    held: 0,
    priceStroops: PRICE,
    short: false,
    ...over,
  };
}

const arg = (args: xdr.ScVal[], i = 0): unknown => scValToNative(args[i]);

/** A chain where each address has what `holdings` says it has. */
function chain(holdings: {
  names?: Record<string, bigint | null>;
  usdc?: Record<string, bigint | null>;
  owners?: Record<number, string>;
  resolves?: Record<string, string>;
}) {
  read.mockImplementation(async (contractId, method, args) => {
    if (contractId === namesContractId()) {
      if (method === 'balance') return holdings.names?.[arg(args) as string] ?? null;
      if (method === 'state') return (arg(args) as string) in (holdings.resolves ?? {}) ? 0 : 2;
      if (method === 'resolve') return holdings.resolves?.[arg(args) as string] ?? null;
    }
    if (contractId === usdcContractId() && method === 'balance') {
      return holdings.usdc?.[arg(args) as string] ?? null;
    }
    if (contractId === collectionContractId()) {
      if (method === 'sold') return Object.keys(holdings.owners ?? {}).map(Number);
      if (method === 'owner_of') return holdings.owners?.[arg(args) as number] ?? null;
      if (method === 'price') return PRICE;
      if (method === 'balance') return 0n;
    }
    return null;
  });
}

beforeEach(() => {
  read.mockReset();
  invoke.mockReset();
});

describe('choosePurchase', () => {
  const wallet = (over?: Partial<BuyerState>) => ({ address: WALLET, state: state(over) });
  const spending = (over?: Partial<BuyerState>) => ({ address: SPENDING, state: state(over) });

  it('buys as the smart wallet when the name is there', () => {
    const p = choosePurchase(wallet({ hasName: true }), spending());
    expect(p).toMatchObject({ payer: 'wallet', address: WALLET });
    expect(p.state.hasName).toBe(true);
  });

  it('buys as the spending account when that is where the name is', () => {
    const p = choosePurchase(wallet(), spending({ hasName: true }));
    expect(p).toMatchObject({ payer: 'spending', address: SPENDING });
    expect(p.state.hasName).toBe(true);
  });

  it('prefers the smart wallet when both hold a name and both can pay', () => {
    const p = choosePurchase(wallet({ hasName: true }), spending({ hasName: true }));
    expect(p.payer).toBe('wallet');
  });

  it('prefers the account that can pay when both hold a name', () => {
    const p = choosePurchase(
      wallet({ hasName: true, short: true, balanceStroops: 0n }),
      spending({ hasName: true })
    );
    expect(p.payer).toBe('spending');
  });

  it('keeps the name-holder as the buyer even when it is short', () => {
    // The message must be "not enough USDC in your spending account", not
    // "get a name". A funded smart wallet with no name cannot buy at all.
    const p = choosePurchase(
      wallet(),
      spending({ hasName: true, short: true, balanceStroops: 0n })
    );
    expect(p).toMatchObject({ payer: 'spending', address: SPENDING });
    expect(p.state).toMatchObject({ hasName: true, short: true });
  });

  it('says "no name" only when both accounts were read and neither has one', () => {
    expect(choosePurchase(wallet(), spending()).state.hasName).toBe(false);
  });

  it('does not say "no name" when the spending account could not be read', () => {
    expect(choosePurchase(wallet(), spending({ hasName: null })).state.hasName).toBeNull();
  });

  it('does not say "no name" when the smart wallet could not be read', () => {
    expect(choosePurchase(wallet({ hasName: null }), spending()).state.hasName).toBeNull();
  });

  it('answers for the smart wallet alone when there is no spending account', () => {
    expect(choosePurchase(wallet(), null)).toMatchObject({ payer: 'wallet', address: WALLET });
    expect(choosePurchase(wallet(), null).state.hasName).toBe(false);
  });
});

describe('readPurchase', () => {
  it('finds a name on the spending account and makes it the buyer', async () => {
    chain({
      names: { [WALLET]: 0n, [SPENDING]: 1n },
      usdc: { [WALLET]: 0n, [SPENDING]: 148_251_801n },
    });

    const p = await readPurchase(WALLET, SPENDING);

    expect(p).toMatchObject({ payer: 'spending', address: SPENDING });
    expect(p.state).toMatchObject({ hasName: true, short: false, balanceStroops: 148_251_801n });
  });

  it('reports no name when neither account holds one', async () => {
    chain({ names: { [WALLET]: 0n, [SPENDING]: 0n }, usdc: { [WALLET]: PRICE, [SPENDING]: 0n } });

    const p = await readPurchase(WALLET, SPENDING);

    expect(p.payer).toBe('wallet');
    expect(p.state.hasName).toBe(false);
  });

  it('does not ask about a spending account that does not exist', async () => {
    chain({ names: { [WALLET]: 1n }, usdc: { [WALLET]: PRICE } });

    const p = await readPurchase(WALLET, null);

    expect(p).toMatchObject({ payer: 'wallet', address: WALLET });
    const asked = read.mock.calls.map(([, , args]) => (args[0] ? arg(args) : null));
    expect(asked).not.toContain(SPENDING);
  });
});

describe('buyFigureFromSpending', () => {
  it('buys as the spending account, for the spending account', async () => {
    invoke.mockResolvedValue('hash');

    await expect(buyFigureFromSpending(SPENDING, 12)).resolves.toBe('hash');

    expect(invoke).toHaveBeenCalledTimes(1);
    const [expected, contractId, method, args, flow] = invoke.mock.calls[0];
    expect(expected).toBe(SPENDING);
    expect(contractId).toBe(collectionContractId());
    expect(method).toBe('buy');
    // `buy(buyer, token_id)`: the buyer is the account that holds the name.
    expect(arg(args, 0)).toBe(SPENDING);
    expect(arg(args, 1)).toBe(12);
    expect(flow).toBe('Veil-ian purchase');
  });
});

describe('fetchOwnedVeilIans', () => {
  it('lists figures on either of the accounts, and nobody else’s', async () => {
    chain({ owners: { 3: WALLET, 9: SPENDING, 14: STRANGER } });

    const items = await fetchOwnedVeilIans([WALLET, SPENDING]);

    expect(items.map((i) => i.tokenId).sort()).toEqual(['3', '9']);
    expect(items.find((i) => i.tokenId === '9')?.owner).toBe(SPENDING);
    expect(items.find((i) => i.tokenId === '3')?.owner).toBe(WALLET);
  });

  it('misses the figure on the spending account when asked about the wallet alone', async () => {
    // What the gallery did before, pinned so the difference is visible.
    chain({ owners: { 9: SPENDING } });

    expect(await fetchOwnedVeilIans(WALLET)).toEqual([]);
    expect(await fetchOwnedVeilIans([WALLET, SPENDING])).toHaveLength(1);
  });

  it('reads nothing when it is given no address', async () => {
    chain({ owners: { 9: SPENDING } });

    expect(await fetchOwnedVeilIans(['', ''])).toEqual([]);
    expect(read).not.toHaveBeenCalled();
  });
});

describe('nameState', () => {
  it('calls a name pointing at the spending account yours', async () => {
    chain({ resolves: { jack: SPENDING } });

    expect(await nameState('jack', [WALLET, SPENDING])).toBe('yours');
  });

  it('calls a name pointing at somebody else taken', async () => {
    chain({ resolves: { jack: STRANGER } });

    expect(await nameState('jack', [WALLET, SPENDING])).toBe('taken');
  });

  it('ignores a missing address instead of matching on it', async () => {
    chain({ resolves: { jack: STRANGER } });

    expect(await nameState('jack', [WALLET, ''])).toBe('taken');
    expect(await nameState('jack', ['', ''])).toBe('taken');
  });

  it('still accepts a single address', async () => {
    chain({ resolves: { jack: WALLET } });

    expect(await nameState('jack', WALLET)).toBe('yours');
  });
});
