/**
 * The injected script, actually executed.
 *
 * The rest of this feature is tested as TypeScript. This one is about the string
 * that goes into the WebView, which is ES5 and lives in a page we do not control,
 * so it is run inside a fake `window` the way react-native-webview runs it:
 * `postMessage` carries the request out, and the reply hook the app injects calls
 * back in.
 *
 * What it pins is the part a text-matching test cannot: that a dApp loading in
 * Veil finds something, reads an address through it, and hears a clear "no" when
 * the user says no.
 */
import vm from 'vm';

import {
  DAPP_PROVIDER_REPLY_HOOK,
  SEP43_ERROR,
  dappProviderScript,
  errorResponse,
} from '../dappProvider';

const ORIGIN = 'https://app.soroswap.finance';
const WALLET = 'GVAULTTESTADDRESS';
const script = dappProviderScript(ORIGIN);

type Page = {
  sandbox: Record<string, unknown>;
  posted: string[];
  /** The newest request the page sent, parsed. */
  sent: () => { id: string; method: string; params: Record<string, unknown> };
  /** The app's answer, in the shape `serializeProviderReply` writes. */
  answer: (response: unknown) => void;
  provider: Record<string, (...args: unknown[]) => Promise<unknown>>;
};

function installPage(options: { origin?: string; asFrame?: boolean; withBridge?: boolean } = {}): Page {
  const posted: string[] = [];
  const sandbox: Record<string, unknown> = {
    console,
    Date,
    Promise,
    JSON,
    setTimeout: (fn: () => void, ms: number) => setTimeout(fn, ms),
  };
  sandbox.window = sandbox;
  sandbox.self = sandbox;
  sandbox.top = options.asFrame ? { other: true } : sandbox;
  sandbox.location = { origin: options.origin ?? ORIGIN };
  if (options.withBridge !== false) {
    sandbox.ReactNativeWebView = { postMessage: (data: string) => posted.push(data) };
  }
  vm.createContext(sandbox);
  vm.runInContext(script, sandbox);

  const last = () => JSON.parse(posted[posted.length - 1]);

  return {
    sandbox,
    posted,
    sent: last,
    answer: (response) => {
      const message = last();
      const hook = sandbox[DAPP_PROVIDER_REPLY_HOOK] as (raw: string) => void;
      hook(JSON.stringify({ id: message.id, response }));
    },
    provider: sandbox.freighterApi as Page['provider'],
  };
}

/** Both outcomes of a page call, never thrown. */
type Outcome = {
  status: 'resolved' | 'rejected';
  value?: unknown;
  error?: { error?: { code?: number; message?: string } };
};

async function settle(promise: Promise<unknown>): Promise<Outcome> {
  return promise.then(
    (value) => ({ status: 'resolved' as const, value }),
    (error) => ({ status: 'rejected' as const, error: error as Outcome['error'] }),
  );
}

describe('the script Veil injects', () => {
  // The page's own bail-out timer is ten minutes long and is armed on every call,
  // so it is faked for the whole suite: a real one would outlive the test and keep
  // jest's event loop open after the run.
  beforeEach(() => {
    jest.useFakeTimers();
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it('is JavaScript a WebView can evaluate, and ends the way injected code must', () => {
    expect(() => new Function(script)).not.toThrow();
    expect(script.trimEnd().endsWith('true;')).toBe(true);
  });

  it('installs the wallet under the name dApps already probe', () => {
    const page = installPage();

    expect(page.provider).toBeDefined();
    expect(Object.keys(page.provider)).toEqual([
      'version',
      'isApproved',
      'request',
      'connect',
      'getAddress',
      'getAddresses',
      'getNetwork',
      'signTransaction',
      'signAuthEntry',
      'signMessage',
    ]);
  });

  it('gives the same object to window.veil, so either name finds the wallet', () => {
    const page = installPage();
    expect(page.sandbox.veil).toBe(page.provider);
  });

  it('cannot be replaced from the page', () => {
    const page = installPage();
    const original = page.provider;

    // A dApp deciding to write its own `window.freighterApi` would otherwise take
    // the wallet's name for a request the user never approved.
    page.sandbox.freighterApi = { fake: true };
    expect(page.sandbox.freighterApi).toBe(original);
  });

  it('installs once, because the same text runs before and after the load', () => {
    const page = installPage();
    const original = page.provider;

    vm.runInContext(script, page.sandbox);
    expect(page.sandbox.veil).toBe(original);
  });

  it('declines to install in a page that is not the approved origin', () => {
    const page = installPage({ origin: 'https://evil.example' });
    expect(page.sandbox.freighterApi).toBeUndefined();
  });

  it('declines to install in a frame, even one inside the approved page', () => {
    const page = installPage({ asFrame: true });
    expect(page.sandbox.freighterApi).toBeUndefined();
  });

  it('asks the app for an address and hands the answer back', async () => {
    const page = installPage();
    const pending = settle(page.provider.getAddress!());

    expect(page.sent()).toMatchObject({ method: 'getAddress', params: {} });
    page.answer({ address: WALLET });
    expect(await pending).toEqual({ status: 'resolved', value: { address: WALLET } });
  });

  it('carries the options a dApp passes, wherever it passed them', async () => {
    const page = installPage();
    const pending = settle(page.provider.signTransaction!('AAAA', { address: WALLET }));

    expect(page.sent()).toMatchObject({
      method: 'signTransaction',
      params: { xdr: 'AAAA', opts: { address: WALLET } },
    });
    page.answer({ signedTxXdr: 'SIGNED', signerAddress: WALLET });
    expect((await pending).value).toEqual({ signedTxXdr: 'SIGNED', signerAddress: WALLET });
  });

  it('reads a request dispatched by name, not only the method called directly', () => {
    const page = installPage();
    page.provider.request!({ method: 'getAddresses' });
    expect(page.sent().method).toBe('getAddresses');

    page.provider.request!({ method: 'connect' });
    expect(page.sent().method).toBe('request');

    // An unknown name is the connect gesture, which is what the interface means
    // by it; it is never silently dropped.
    page.provider.request!({ method: 'notAThing' });
    expect(page.sent().method).toBe('request');
  });

  it('sends a batch of auth entries as a batch', () => {
    const page = installPage();
    page.provider.signAuthEntry!(['ENTRY-1', 'ENTRY-2']);

    expect(page.sent()).toMatchObject({ method: 'signAuthEntry', params: { authEntries: ['ENTRY-1', 'ENTRY-2'] } });
  });

  it('sends a single auth entry the way SEP-43 documents it', () => {
    const page = installPage();
    page.provider.signAuthEntry!('ENTRY-1');

    expect(page.sent()).toMatchObject({ method: 'signAuthEntry', params: { xdr: 'ENTRY-1' } });
  });

  it('rejects a refused request, so a dApp cannot read a "no" as a signature', async () => {
    const page = installPage();
    const pending = settle(page.provider.signTransaction!('AAAA'));

    page.answer(errorResponse(SEP43_ERROR.userRejected, 'The user rejected this request.'));
    const outcome = await pending;

    expect(outcome.status).toBe('rejected');
    expect(outcome.error?.error?.code).toBe(SEP43_ERROR.userRejected);
  });

  it('settles a request once, even if the app answers twice', async () => {
    const page = installPage();
    const pending = settle(page.provider.getAddress!());

    page.answer({ address: WALLET });
    page.answer({ address: 'SECOND' });
    expect((await pending).value).toEqual({ address: WALLET });
  });

  it('ignores an answer for a request it never made, without throwing into the page', () => {
    const page = installPage();
    const hook = page.sandbox[DAPP_PROVIDER_REPLY_HOOK] as (raw: string) => void;

    expect(() => hook(JSON.stringify({ id: 'r99-1', response: { address: WALLET } }))).not.toThrow();
    expect(() => hook('not even json')).not.toThrow();
  });

  it('answers a page it cannot reach instead of leaving it waiting', async () => {
    const page = installPage({ withBridge: false });
    const outcome = await settle(page.provider.getAddress!());

    expect(outcome.status).toBe('rejected');
    expect(outcome.error?.error?.message).toMatch(/not available/);
  });

  it('gives up on a request the app never answers, so a dApp does not hang forever', async () => {
    const page = installPage();
    const pending = settle(page.provider.getAddress!());

    // The real wait is ten minutes; the page must not be left with a promise
    // that outlives the request.
    jest.advanceTimersByTime(600_001);
    const outcome = await pending;

    expect(outcome.status).toBe('rejected');
    expect(outcome.error?.error?.code).toBe(SEP43_ERROR.internal);
  });
});
