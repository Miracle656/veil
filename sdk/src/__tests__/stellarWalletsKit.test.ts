import { VeilModule, type VeilProvider, STELLAR_NETWORKS } from '../stellarWalletsKit';

describe('VeilModule (Stellar Wallets Kit adapter)', () => {
  let listeners: Set<(e: any) => void>;
  let received: any[];
  let popup: any;
  let dapp: any;
  let page: any;

  const originalOpen = window.open;

  beforeEach(() => {
    listeners = new Set();
    received = [];
    popup = {
      closed: false,
      close() {
        this.closed = true;
      },
      focus() {},
      postMessage(data: unknown) {
        received.push(data);
      },
    };
    dapp = {
      opened: 0,
      open() {
        dapp.opened += 1;
        popup.closed = false;
        return popup;
      },
    };
    (window as any).open = dapp.open;
    window.addEventListener = ((t: string, fn: any) => {
      if (t === 'message') listeners.add(fn);
    }) as any;
    window.removeEventListener = ((_t: string, fn: any) => {
      listeners.delete(fn);
    }) as any;

    page = {
      received,
      last: () => received[received.length - 1],
      post(data: unknown) {
        for (const fn of [...listeners]) fn({ origin: 'https://wallet.useveilapp.xyz', source: popup, data });
      },
      ready() {
        this.post({ veil: 1, type: 'ready' });
      },
      reply(id: string, result: unknown) {
        this.post({ veil: 1, id, type: 'result', result });
      },
      fail(id: string, error: { code: number; message: string }) {
        this.post({ veil: 1, id, type: 'error', error });
      },
    };
  });

  afterEach(() => {
    delete (window as any).veil;
    window.open = originalOpen;
  });

  const ACCOUNT = { address: 'CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA' };
  const SIGNED = { ...ACCOUNT, hash: 'CAFE', blob: 'AAAAAgAA', signature: 'ff'.repeat(64) };

  test('metadata: hot wallet, available, with icon', async () => {
    const mod = new VeilModule();
    expect(mod.productId).toBe('veil');
    expect(mod.productName).toBe('Veil');
    expect(mod.productIcon.startsWith('data:image/svg+xml;base64,')).toBe(true);
    expect(await mod.isAvailable()).toBe(true);
    expect(await mod.isPlatformWrapper()).toBe(false);
  });

  test('injected provider: detects window.veil without popup', async () => {
    let called = false;
    const mockProvider: VeilProvider = {
      getAddress: () => {
        called = true;
        return Promise.resolve({ address: ACCOUNT.address });
      },
      signTransaction: () => Promise.resolve({ signedTxXdr: SIGNED.blob, signerAddress: ACCOUNT.address }),
      signAuthEntry: () => Promise.resolve({ signedAuthEntry: 'c2ln', signerAddress: ACCOUNT.address }),
      signMessage: () => Promise.resolve({ signedMessage: 'bXNn', signerAddress: ACCOUNT.address }),
      signAndSubmitTransaction: () => Promise.resolve({ status: 'success' }),
      getNetwork: () => Promise.resolve({ network: 'TESTNET', networkPassphrase: STELLAR_NETWORKS.TESTNET }),
    };

    (global as any).window.veil = mockProvider;

    const mod = new VeilModule();
    expect(await mod.isAvailable()).toBe(true);
    expect(await mod.isPlatformWrapper()).toBe(true);

    const addr = await mod.getAddress();
    expect(addr).toEqual({ address: ACCOUNT.address });
    expect(called).toBe(true);
    expect(dapp.opened).toBe(0);

    const txRes = await mod.signTransaction('AAAA', { networkPassphrase: STELLAR_NETWORKS.TESTNET });
    expect(txRes).toEqual({ signedTxXdr: SIGNED.blob, signerAddress: ACCOUNT.address });

    const authRes = await mod.signAuthEntry('AAAACQ');
    expect(authRes).toEqual({ signedAuthEntry: 'c2ln', signerAddress: ACCOUNT.address });

    const msgRes = await mod.signMessage('hello');
    expect(msgRes).toEqual({ signedMessage: 'bXNn', signerAddress: ACCOUNT.address });

    const submitRes = await mod.signAndSubmitTransaction('AAAA');
    expect(submitRes).toEqual({ status: 'success' });

    const netRes = await mod.getNetwork();
    expect(netRes).toEqual({ network: 'TESTNET', networkPassphrase: STELLAR_NETWORKS.TESTNET });
  });

  test('popup flow: getAddress connects via popup', async () => {
    const mod = new VeilModule({ network: STELLAR_NETWORKS.TESTNET });
    const pending = mod.getAddress();
    expect(dapp.opened).toBe(1);

    page.ready();
    expect(page.last().method).toBe('connect');
    expect(page.last().network).toBe('testnet');

    page.reply(page.last().id, ACCOUNT);
    expect(await pending).toEqual({ address: ACCOUNT.address });
  });

  test('popup flow: signTransaction communicates with popup', async () => {
    const mod = new VeilModule();
    const pending = mod.signTransaction('AAAA', { networkPassphrase: STELLAR_NETWORKS.PUBLIC, address: ACCOUNT.address });

    page.ready();
    expect(page.last().method).toBe('sign');
    expect(page.last().params).toEqual({ payload: 'AAAA', submit: false, address: ACCOUNT.address });

    page.reply(page.last().id, SIGNED);
    expect(await pending).toEqual({ signedTxXdr: 'AAAAAgAA', signerAddress: ACCOUNT.address });
  });

  test('refuses unknown passphrase with code -3', async () => {
    const mod = new VeilModule();
    await expect(mod.signTransaction('AAAA', { networkPassphrase: 'invalid' })).rejects.toEqual(
      expect.objectContaining({ code: -3 })
    );
    expect(dapp.opened).toBe(0);
  });
});
