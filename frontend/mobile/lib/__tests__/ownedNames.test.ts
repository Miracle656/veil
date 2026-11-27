/**
 * "Which names do I hold" — a question the registry cannot answer directly.
 *
 * The case these tests exist for is real (2026-11-11): the holder of `jack`
 * opened the names screen and saw an empty claim form. The name was on the
 * spending account, registered on the web, and the phone had never been told
 * its name.
 */

import AsyncStorage from '@react-native-async-storage/async-storage';
import { Keypair, StrKey, nativeToScVal, scValToNative, type xdr } from '@stellar/stellar-sdk';

import {
  type HorizonPage,
  type OwnedNamesDeps,
  formatNameDate,
  knownNamesKey,
  loadOwnedNames,
  namesFromOperations,
  rememberOwnName,
} from '../ownedNames';

jest.mock('../contractInvoke', () => ({
  simulateRead: jest.fn(),
  invokeAsWallet: jest.fn(),
  invokeAsSpendingAccount: jest.fn(),
}));
jest.mock('../network', () => ({
  getNetwork: () => ({ name: 'mainnet', horizonUrl: 'https://horizon.invalid' }),
}));

// Generated per run: nothing here is a real account.
const REGISTRY = StrKey.encodeContract(Buffer.alloc(32, 5));
const OTHER_CONTRACT = StrKey.encodeContract(Buffer.alloc(32, 6));
const WALLET = StrKey.encodeContract(Buffer.alloc(32, 7));
const SPENDING = Keypair.random().publicKey();
const STRANGER = Keypair.random().publicKey();

const EXPIRY = 1_825_000_000n;

const b64 = (value: unknown, type: string) => nativeToScVal(value, { type }).toXDR('base64');

let nextToken = 1000;

/** One operation, shaped the way Horizon lists a contract call. */
function call(
  method: string,
  args: { type: string; value: string }[],
  over: Record<string, unknown> = {},
  contract = REGISTRY
) {
  nextToken += 1;
  return {
    type: 'invoke_host_function',
    paging_token: String(nextToken),
    transaction_successful: true,
    parameters: [
      { type: 'Address', value: b64(contract, 'address') },
      { type: 'Sym', value: b64(method, 'symbol') },
      ...args,
    ],
    ...over,
  };
}

const register = (name: string, buyer = SPENDING, over: Record<string, unknown> = {}) =>
  call(
    'register',
    [
      { type: 'Address', value: b64(buyer, 'address') },
      { type: 'Str', value: b64(name, 'string') },
      { type: 'U32', value: b64(1, 'u32') },
    ],
    over
  );

const payment = () => {
  nextToken += 1;
  return { type: 'payment', paging_token: String(nextToken), transaction_successful: true };
};

interface Chain {
  /** name -> where it points. Absent means nobody holds it. */
  points?: Record<string, string>;
  /** Names that have run out but are still in recovery. */
  lapsed?: string[];
  /** Names the registry cannot be reached about. */
  unreadable?: string[];
}

function deps(
  pages: (url: string) => HorizonPage | Promise<HorizonPage>,
  chain: Chain = {},
  over: Partial<OwnedNamesDeps> = {}
) {
  const fetchPage = jest.fn(async (url: string) => pages(url));
  const read = jest.fn(async (_id: string, method: string, args: xdr.ScVal[]) => {
    const name = scValToNative(args[0]) as string;
    if (chain.unreadable?.includes(name)) return null;
    if (method === 'state') {
      if (chain.lapsed?.includes(name)) return 1;
      return name in (chain.points ?? {}) ? 0 : 2;
    }
    if (method === 'resolve') return chain.points?.[name] ?? null;
    if (method === 'expires_at') return EXPIRY;
    return null;
  });
  const d: OwnedNamesDeps = {
    registryId: REGISTRY,
    network: 'mainnet',
    horizonUrl: 'https://horizon.invalid/',
    fetchPage,
    read,
    ...over,
  };
  return { d, fetchPage, read };
}

const page = (records: unknown[], status = 200): HorizonPage => ({ status, records });

async function stored() {
  const raw = await AsyncStorage.getItem(knownNamesKey('mainnet'));
  return raw ? (JSON.parse(raw) as { names: string[]; cursors: Record<string, string> }) : null;
}

beforeEach(async () => {
  await AsyncStorage.clear();
  nextToken = 1000;
});

describe('namesFromOperations', () => {
  it('reads a name out of the encoding Horizon actually returns', () => {
    // The function symbol and the name exactly as Horizon sent them for the
    // first registration on mainnet.
    const op = {
      type: 'invoke_host_function',
      transaction_successful: true,
      parameters: [
        { type: 'Address', value: b64(REGISTRY, 'address') },
        { type: 'Sym', value: 'AAAADwAAAAhyZWdpc3Rlcg==' },
        { type: 'Address', value: b64(SPENDING, 'address') },
        { type: 'Str', value: 'AAAADgAAAARqYWNr' },
        { type: 'U32', value: 'AAAAAwAAAAE=' },
      ],
    };

    expect(namesFromOperations([op], REGISTRY)).toEqual(['jack']);
  });

  it('counts a renewal, and lists a name once', () => {
    const renew = call('renew', [
      { type: 'Address', value: b64(SPENDING, 'address') },
      { type: 'Str', value: b64('jack', 'string') },
      { type: 'U32', value: b64(2, 'u32') },
    ]);

    expect(namesFromOperations([register('jack'), renew, register('ada_l')], REGISTRY)).toEqual([
      'jack',
      'ada_l',
    ]);
  });

  it('ignores everything that is not a successful naming call on this registry', () => {
    const elsewhere = call(
      'register',
      [
        { type: 'Address', value: b64(SPENDING, 'address') },
        { type: 'Str', value: b64('jack', 'string') },
        { type: 'U32', value: b64(1, 'u32') },
      ],
      {},
      OTHER_CONTRACT
    );
    const transfer = call('transfer', [
      { type: 'Address', value: b64(SPENDING, 'address') },
      { type: 'Address', value: b64(STRANGER, 'address') },
      { type: 'U32', value: b64(0, 'u32') },
    ]);

    expect(
      namesFromOperations(
        [
          elsewhere,
          transfer,
          payment(),
          register('failed', SPENDING, { transaction_successful: false }),
          register('Not A Name'),
          { type: 'invoke_host_function', parameters: 'nonsense' },
          { type: 'invoke_host_function', parameters: [{ value: '%%%' }, {}, {}, {}] },
          null,
          'nonsense',
        ],
        REGISTRY
      )
    ).toEqual([]);
  });
});

describe('loadOwnedNames', () => {
  it('finds a name the web registered on the spending account', async () => {
    const { d, fetchPage } = deps(() => page([payment(), register('jack'), payment()]), {
      points: { jack: SPENDING },
    });

    const owned = await loadOwnedNames({ wallet: WALLET, spending: SPENDING }, d);

    expect(owned).toEqual({
      complete: true,
      names: [{ name: 'jack', pointsAt: SPENDING, account: 'spending', expiresAt: Number(EXPIRY) }],
    });
    expect(fetchPage).toHaveBeenCalledTimes(1);
    expect(fetchPage.mock.calls[0][0]).toBe(
      `https://horizon.invalid/accounts/${SPENDING}/operations?limit=200&include_failed=false&order=desc`
    );
  });

  it('says which account a name points at', async () => {
    const { d } = deps(() => page([register('jack', WALLET)]), { points: { jack: WALLET } });

    const owned = await loadOwnedNames({ wallet: WALLET, spending: SPENDING }, d);

    expect(owned.names).toEqual([
      { name: 'jack', pointsAt: WALLET, account: 'wallet', expiresAt: Number(EXPIRY) },
    ]);
  });

  it('reads only what is new on the next visit, and still knows the name', async () => {
    const first = [payment(), register('jack')];
    const newest = first[0].paging_token;
    const { d, fetchPage } = deps((url) => (url.includes('cursor=') ? page([]) : page(first)), {
      points: { jack: SPENDING },
    });

    await loadOwnedNames({ wallet: WALLET, spending: SPENDING }, d);
    const again = await loadOwnedNames({ wallet: WALLET, spending: SPENDING }, d);

    expect(again.names.map((n) => n.name)).toEqual(['jack']);
    expect(fetchPage.mock.calls[1][0]).toBe(
      `https://horizon.invalid/accounts/${SPENDING}/operations?limit=200&include_failed=false&order=asc&cursor=${newest}`
    );
  });

  it('picks up a name registered since the last visit', async () => {
    const later = [register('ada_l')];
    const { d } = deps(
      (url) => (url.includes('cursor=') ? page(later) : page([register('jack')])),
      { points: { jack: SPENDING, ada_l: SPENDING } }
    );

    await loadOwnedNames({ wallet: WALLET, spending: SPENDING }, d);
    const again = await loadOwnedNames({ wallet: WALLET, spending: SPENDING }, d);

    expect(again.names.map((n) => n.name)).toEqual(['ada_l', 'jack']);
    expect((await stored())?.cursors[SPENDING]).toBe(later[0].paging_token);
  });

  it('keeps reading while Horizon returns full pages', async () => {
    const full = Array.from({ length: 200 }, payment);
    const last = full[199].paging_token;
    const { d, fetchPage } = deps(
      (url) => (url.includes('cursor=') ? page([register('jack')]) : page(full)),
      { points: { jack: SPENDING } }
    );

    const owned = await loadOwnedNames({ wallet: WALLET, spending: SPENDING }, d);

    expect(owned.names.map((n) => n.name)).toEqual(['jack']);
    expect(fetchPage).toHaveBeenCalledTimes(2);
    expect(fetchPage.mock.calls[1][0]).toContain(`order=desc&cursor=${last}`);
    // The resume point is the newest operation, not the oldest one read.
    expect((await stored())?.cursors[SPENDING]).toBe(full[0].paging_token);
  });

  it('does not list a name that points at somebody else, and stops asking about it', async () => {
    const { d, read } = deps(
      (url) => (url.includes('cursor=') ? page([]) : page([register('jack')])),
      { points: { jack: STRANGER } }
    );

    const owned = await loadOwnedNames({ wallet: WALLET, spending: SPENDING }, d);

    expect(owned).toEqual({ names: [], complete: true });
    expect((await stored())?.names).toEqual([]);

    read.mockClear();
    await loadOwnedNames({ wallet: WALLET, spending: SPENDING }, d);
    expect(read).not.toHaveBeenCalled();
  });

  it('does not list a name nobody holds any more', async () => {
    const { d } = deps(() => page([register('jack')]), { points: {} });

    expect(await loadOwnedNames({ wallet: WALLET, spending: SPENDING }, d)).toEqual({
      names: [],
      complete: true,
    });
  });

  it('does not show a lapsed name as held, but keeps asking about it', async () => {
    const { d } = deps(() => page([register('jack')]), { lapsed: ['jack'] });

    const owned = await loadOwnedNames({ wallet: WALLET, spending: SPENDING }, d);

    expect(owned).toEqual({ names: [], complete: true });
    expect((await stored())?.names).toEqual(['jack']);
  });

  it('reports "could not check" when the registry does not answer', async () => {
    const { d } = deps(() => page([register('jack')]), { unreadable: ['jack'] });

    const owned = await loadOwnedNames({ wallet: WALLET, spending: SPENDING }, d);

    // Not "you hold no name": the name is kept and asked about again.
    expect(owned).toEqual({ names: [], complete: false });
    expect((await stored())?.names).toEqual(['jack']);
  });

  it('still shows a remembered name when Horizon is down', async () => {
    await rememberOwnName('jack', 'mainnet');
    const { d } = deps(
      () => {
        throw new Error('network request failed');
      },
      { points: { jack: SPENDING } }
    );

    const owned = await loadOwnedNames({ wallet: WALLET, spending: SPENDING }, d);

    expect(owned.names.map((n) => n.name)).toEqual(['jack']);
    expect(owned.complete).toBe(false);
    // Nothing was read, so the next visit starts from the beginning again.
    expect((await stored())?.cursors).toEqual({});
  });

  it('reports "could not check" when Horizon refuses', async () => {
    const { d } = deps(() => page([], 503));

    expect(await loadOwnedNames({ wallet: WALLET, spending: SPENDING }, d)).toEqual({
      names: [],
      complete: false,
    });
  });

  it('treats an account Horizon has never seen as holding nothing', async () => {
    const { d } = deps(() => page([], 404));

    expect(await loadOwnedNames({ wallet: WALLET, spending: SPENDING }, d)).toEqual({
      names: [],
      complete: true,
    });
  });

  it('lists a name this phone registered when there is no spending account', async () => {
    await rememberOwnName('  Jack ', 'mainnet');
    const { d, fetchPage } = deps(() => page([]), { points: { jack: WALLET } });

    const owned = await loadOwnedNames({ wallet: WALLET, spending: null }, d);

    expect(owned.names).toEqual([
      { name: 'jack', pointsAt: WALLET, account: 'wallet', expiresAt: Number(EXPIRY) },
    ]);
    expect(fetchPage).not.toHaveBeenCalled();
  });

  it('shows the name without a date when only the expiry could not be read', async () => {
    const { d, read } = deps(() => page([register('jack')]), { points: { jack: SPENDING } });
    const answer = read.getMockImplementation()!;
    read.mockImplementation(async (id, method, args) =>
      method === 'expires_at' ? null : answer(id, method, args)
    );

    const owned = await loadOwnedNames({ wallet: WALLET, spending: SPENDING }, d);

    expect(owned.names).toEqual([
      { name: 'jack', pointsAt: SPENDING, account: 'spending', expiresAt: null },
    ]);
  });

  it('asks nothing where there is no registry or no wallet', async () => {
    const off = deps(() => page([register('jack')]), {}, { registryId: '' });
    expect(await loadOwnedNames({ wallet: WALLET, spending: SPENDING }, off.d)).toEqual({
      names: [],
      complete: true,
    });
    expect(off.fetchPage).not.toHaveBeenCalled();

    const nobody = deps(() => page([register('jack')]));
    expect(await loadOwnedNames({ wallet: null, spending: null }, nobody.d)).toEqual({
      names: [],
      complete: true,
    });
    expect(nobody.fetchPage).not.toHaveBeenCalled();
  });

  it('keeps each network to its own names', async () => {
    await rememberOwnName('jack', 'testnet');
    const { d, read } = deps(() => page([]), { points: { jack: SPENDING } });

    expect((await loadOwnedNames({ wallet: WALLET, spending: SPENDING }, d)).names).toEqual([]);
    expect(read).not.toHaveBeenCalled();
  });
});

describe('rememberOwnName', () => {
  it('refuses anything that is not a name', async () => {
    await rememberOwnName('', 'mainnet');
    await rememberOwnName('a', 'mainnet');
    await rememberOwnName('jack*useveilapp.xyz', 'mainnet');

    expect(await stored()).toBeNull();
  });

  it('survives a store somebody else wrote badly', async () => {
    await AsyncStorage.setItem(
      knownNamesKey('mainnet'),
      '{"names":[1,"Bad Name","jack"],"cursors":7}'
    );

    await rememberOwnName('ada_l', 'mainnet');

    expect(await stored()).toEqual({ names: ['ada_l', 'jack'], cursors: {} });
  });
});

describe('formatNameDate', () => {
  it('writes a date the way the rest of the app does', () => {
    // Midday UTC, so the day is the same in every timezone the tests run in
    // except the two at the date line.
    expect(formatNameDate(Date.UTC(2027, 10, 9, 12) / 1000)).toBe('9 Nov 2027');
  });
});
