/**
 * Stellar Wallets Kit module adapter for Veil.
 *
 * Exposes VeilModule implementing ModuleInterface and SEP-43 for Stellar dApps
 * using @creit-tech/stellar-wallets-kit.
 *
 * When inside Veil's in-app dApp browser, detects `window.veil`.
 * When in standard desktop/mobile browsers, bridges via popup to https://wallet.useveilapp.xyz.
 */

export const VEIL_ID = 'veil';

export interface ModuleInterface {
  moduleType: string;
  productId: string;
  productName: string;
  productUrl: string;
  productIcon: string;
  isAvailable(): Promise<boolean>;
  isPlatformWrapper?(): Promise<boolean>;
  getAddress(params?: { path?: string; skipRequestAccess?: boolean }): Promise<{ address: string }>;
  signTransaction(
    xdr: string,
    opts?: { networkPassphrase?: string; address?: string; path?: string }
  ): Promise<{ signedTxXdr: string; signerAddress?: string }>;
  signAuthEntry(
    authEntry: string,
    opts?: { networkPassphrase?: string; address?: string; path?: string }
  ): Promise<{ signedAuthEntry: string; signerAddress?: string }>;
  signMessage?(
    message: string,
    opts?: { networkPassphrase?: string; address?: string; path?: string }
  ): Promise<{ signedMessage: string; signerAddress?: string }>;
  signAndSubmitTransaction?(
    xdr: string,
    opts?: { networkPassphrase?: string; address?: string }
  ): Promise<{ status: 'success' | 'pending' }>;
  getNetwork(): Promise<{ network: string; networkPassphrase: string }>;
  disconnect?(): Promise<void>;
}

export interface VeilProvider {
  getAddress(): Promise<{ address: string }>;
  signTransaction(
    xdr: string,
    opts?: { networkPassphrase?: string; address?: string; path?: string }
  ): Promise<{ signedTxXdr: string; signerAddress?: string }>;
  signAuthEntry(
    authEntry: string,
    opts?: { networkPassphrase?: string; address?: string; path?: string }
  ): Promise<{ signedAuthEntry: string; signerAddress?: string }>;
  signMessage?(
    message: string,
    opts?: { networkPassphrase?: string; address?: string; path?: string }
  ): Promise<{ signedMessage: string; signerAddress?: string }>;
  signAndSubmitTransaction?(
    xdr: string,
    opts?: { networkPassphrase?: string; address?: string }
  ): Promise<{ status: 'success' | 'pending' }>;
  getNetwork?(): Promise<{ network: string; networkPassphrase: string }>;
}

export const VEIL_ICON =
  'data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHZpZXdCb3g9IjAgMCA5NiA5NiIgd2lkdGg9Ijk2IiBoZWlnaHQ9Ijk2IiByb2xlPSJpbWciIGFyaWEtbGFiZWw9IlZlaWwiPgogIDxyZWN0IHdpZHRoPSI5NiIgaGVpZ2h0PSI5NiIgcng9IjIyIiBmaWxsPSIjMEYwRjBGIi8+CiAgPHJlY3QgeD0iMjIiIHk9IjI2IiB3aWR0aD0iNTIiIGhlaWdodD0iMTIiIHJ4PSI2IiBmaWxsPSIjRkREQTI0Ii8+CiAgPHJlY3QgeD0iMjgiIHk9IjQ0IiB3aWR0aD0iNDAiIGhlaWdodD0iMTIiIHJ4PSI2IiBmaWxsPSIjRkREQTI0IiBvcGFjaXR5PSIwLjYyIi8+CiAgPHJlY3QgeD0iMzQiIHk9IjYyIiB3aWR0aD0iMjgiIGhlaWdodD0iMTIiIHJ4PSI2IiBmaWxsPSIjRkREQTI0IiBvcGFjaXR5PSIwLjM0Ii8+Cjwvc3ZnPgo=';

export const STELLAR_NETWORKS = {
  PUBLIC: 'Public Global Stellar Network ; September 2015',
  TESTNET: 'Test SDF Network ; September 2015',
  FUTURENET: 'Test SDF Future Network ; October 2022',
};

const VEIL_NETWORKS: Record<string, { id: string; name: string }> = {
  [STELLAR_NETWORKS.PUBLIC]: { id: 'mainnet', name: 'PUBLIC' },
  [STELLAR_NETWORKS.TESTNET]: { id: 'testnet', name: 'TESTNET' },
  [STELLAR_NETWORKS.FUTURENET]: { id: 'futurenet', name: 'FUTURENET' },
};

const VEIL_UNSENT = ['offline', 'unsent', 'locked', 'moved', 'handOver'];
const VEIL_PROTOCOL = 1;
const VEIL_URL = 'https://wallet.useveilapp.xyz/?connect';
const VEIL_REUSE_MS = 1_500;
const VEIL_READY_MS = 10_000;
const VEIL_TIMEOUT_MS = 60_000;

export class VeilModule implements ModuleInterface {
  readonly moduleType = 'HOT_WALLET';
  readonly productId: string = VEIL_ID;
  readonly productName: string = 'Veil';
  readonly productUrl: string = 'https://useveilapp.xyz';
  readonly productIcon: string = VEIL_ICON;

  private address: string | null = null;
  private passphrase: string = STELLAR_NETWORKS.PUBLIC;
  private readonly page: { url?: string; timeoutMs?: number };

  constructor(params: { network?: string; url?: string; timeoutMs?: number } = {}) {
    const { network, ...page } = params;
    if (network) this.passphrase = network;
    this.page = page;
  }

  async isAvailable(): Promise<boolean> {
    const win = typeof globalThis.window !== 'undefined' ? (globalThis.window as any) : undefined;
    if (!win) return false;
    if (win.veil && typeof win.veil.getAddress === 'function') return true;
    return typeof win.open === 'function';
  }

  async isPlatformWrapper(): Promise<boolean> {
    const win = typeof globalThis.window !== 'undefined' ? (globalThis.window as any) : undefined;
    return Boolean(win?.veil && typeof win.veil.getAddress === 'function');
  }

  async getAddress(): Promise<{ address: string }> {
    const injected = this.getInjected();
    if (injected) {
      const res = await injected.getAddress();
      this.address = res.address;
      return { address: res.address };
    }

    const result = await this.request<{ address: string }>('connect', {}, undefined);
    this.address = result.address;
    return { address: result.address };
  }

  async signTransaction(
    xdr: string,
    opts?: { networkPassphrase?: string; address?: string; path?: string }
  ): Promise<{ signedTxXdr: string; signerAddress?: string }> {
    const passphrase = opts?.networkPassphrase ?? this.passphrase;
    const injected = this.getInjected();
    if (injected) {
      const res = await injected.signTransaction(xdr, { ...opts, networkPassphrase: passphrase });
      this.network(passphrase);
      return res;
    }

    const params = { payload: xdr, submit: false, address: this.signer(opts) };
    const result = await this.request<{ blob: string; address: string }>('sign', params, passphrase);
    return { signedTxXdr: result.blob, signerAddress: result.address };
  }

  async signAuthEntry(
    authEntry: string,
    opts?: { networkPassphrase?: string; address?: string; path?: string }
  ): Promise<{ signedAuthEntry: string; signerAddress?: string }> {
    const passphrase = opts?.networkPassphrase ?? this.passphrase;
    const injected = this.getInjected();
    if (injected) {
      const res = await injected.signAuthEntry(authEntry, { ...opts, networkPassphrase: passphrase });
      this.network(passphrase);
      return res;
    }

    const params = { payload: authEntry, address: this.signer(opts) };
    const result = await this.request<{ signature: string; address: string }>('signAuthEntry', params, passphrase);
    return { signedAuthEntry: result.signature, signerAddress: result.address };
  }

  async signMessage(
    message: string,
    opts?: { networkPassphrase?: string; address?: string; path?: string }
  ): Promise<{ signedMessage: string; signerAddress?: string }> {
    const passphrase = opts?.networkPassphrase ?? this.passphrase;
    const injected = this.getInjected();
    if (injected && injected.signMessage) {
      const res = await injected.signMessage(message, { ...opts, networkPassphrase: passphrase });
      this.network(passphrase);
      return res;
    }

    const params = { message, address: this.signer(opts) };
    const result = await this.request<{ signature: string; address: string }>('signMessage', params, passphrase);
    return { signedMessage: result.signature, signerAddress: result.address };
  }

  async signAndSubmitTransaction(
    xdr: string,
    opts?: { networkPassphrase?: string; address?: string }
  ): Promise<{ status: 'success' | 'pending' }> {
    const passphrase = opts?.networkPassphrase ?? this.passphrase;
    const injected = this.getInjected();
    if (injected && injected.signAndSubmitTransaction) {
      const res = await injected.signAndSubmitTransaction(xdr, { ...opts, networkPassphrase: passphrase });
      this.network(passphrase);
      return res;
    }

    const params = { payload: xdr, submit: true, address: this.signer(opts) };
    const result = await this.request<any>('sign', params, passphrase);
    const { handOver, submitted, hash } = result;
    if (handOver || (submitted && VEIL_UNSENT.includes(submitted.kind))) {
      throw { code: -2, message: `Nothing was submitted: ${handOver || submitted?.kind}. Transaction hash: ${hash}` };
    }
    if (submitted?.ok === false) {
      throw {
        code: -2,
        message: `The transaction failed: ${submitted.code ?? submitted.kind}. Transaction hash: ${hash}`,
      };
    }
    return { status: submitted?.ok === true ? 'success' : 'pending' };
  }

  async getNetwork(): Promise<{ network: string; networkPassphrase: string }> {
    const injected = this.getInjected();
    if (injected && injected.getNetwork) {
      return await injected.getNetwork();
    }
    return { network: this.network().name, networkPassphrase: this.passphrase };
  }

  async disconnect(): Promise<void> {
    this.address = null;
  }

  private getInjected(): VeilProvider | null {
    const win = typeof globalThis.window !== 'undefined' ? (globalThis.window as any) : undefined;
    if (win?.veil && typeof win.veil.getAddress === 'function') {
      return win.veil;
    }
    return null;
  }

  private signer(opts?: { address?: string }): string | undefined {
    return opts?.address ?? this.address ?? undefined;
  }

  private network(passphrase?: string): { id: string; name: string } {
    const asked = passphrase || this.passphrase;
    const net = VEIL_NETWORKS[asked];
    if (!net) throw { code: -3, message: `Veil does not know the network "${asked}"` };
    this.passphrase = asked;
    return net;
  }

  private async request<T>(method: string, params: Record<string, unknown>, passphrase?: string): Promise<T> {
    const { id } = this.network(passphrase);
    return await veilRequest<T>({ chain: 'stellar', network: id, method, params, ...this.page });
  }
}

const veilHeld = new WeakMap<any, any>();

function veilFeatures(win: any): string {
  const width = 420;
  const height = 720;
  const outerW = win.outerWidth || win.screen?.width || width;
  const outerH = win.outerHeight || win.screen?.height || height;
  const left = Math.max(0, Math.round((win.screenX || 0) + (outerW - width) / 2));
  const top = Math.max(0, Math.round((win.screenY || 0) + (outerH - height) / 2));
  return `popup=yes,width=${width},height=${height},left=${left},top=${top},resizable=yes,scrollbars=yes`;
}

function veilId(): string {
  const c = globalThis.crypto;
  if (c && typeof c.randomUUID === 'function') return c.randomUUID();
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
}

function veilPageUrl(url?: string): URL {
  let parsed: URL;
  try {
    parsed = new URL(url ?? VEIL_URL);
  } catch {
    throw { code: -3, message: `"${String(url)}" is not a URL` };
  }
  const defaultUrl = new URL(VEIL_URL);
  if (parsed.origin === defaultUrl.origin || parsed.origin === 'https://useveilapp.xyz') return parsed;
  if (parsed.hostname === 'localhost' && parsed.protocol === 'http:') return parsed;
  throw { code: -3, message: `Veil is at ${defaultUrl.origin}. A copy at ${parsed.origin} is not opened` };
}

function veilRequest<T>(req: any): Promise<T> {
  const win = typeof window === 'undefined' ? undefined : (window as any);
  if (!win || typeof win.open !== 'function') {
    return Promise.reject({ code: -1, message: 'This environment cannot open a popup', ext: 'popup_blocked' });
  }
  const page = veilPageUrl(req.url);
  const origin = page.origin;
  const timeoutMs = req.timeoutMs ?? VEIL_TIMEOUT_MS;

  const held = veilHeld.get(win);
  veilHeld.delete(win);
  const reuse =
    held &&
    !held.popup.closed &&
    held.origin === origin &&
    held.chain === req.chain &&
    held.network === req.network &&
    Date.now() - held.at < VEIL_REUSE_MS;

  let popup: any;
  if (reuse) {
    popup = held.popup;
  } else {
    try {
      popup = win.open(page.href, `veil-${veilId()}`, veilFeatures(win));
    } catch {
      popup = null;
    }
    if (!popup || popup.closed) {
      return Promise.reject({
        code: -1,
        message: 'The browser blocked the Veil popup. Allow popups for this site and try again',
        ext: 'popup_blocked',
      });
    }
  }

  const id = veilId();
  const request = {
    veil: VEIL_PROTOCOL,
    id,
    type: 'request',
    method: req.method,
    chain: req.chain,
    network: req.network,
    params: req.params ?? {},
  };

  return new Promise<T>((resolve, reject) => {
    let done = false;
    let posted = reuse;
    const finish = (err: any, val?: T) => {
      if (done) return;
      done = true;
      win.removeEventListener('message', onMessage);
      clearInterval(poll);
      clearTimeout(readyTimer);
      clearTimeout(timer);
      if (!err && req.method === 'connect') {
        veilHeld.set(win, { popup, origin, chain: req.chain, network: req.network, at: Date.now() });
      } else if (err?.ext) {
        try {
          if (!popup.closed) popup.close();
        } catch {}
      }
      if (err) reject(err);
      else resolve(val as T);
    };

    const onMessage = (event: any) => {
      if (event.origin !== origin || event.source !== popup) return;
      const data = event.data;
      if (!data || data.veil !== VEIL_PROTOCOL) return;
      if (data.type === 'ready') {
        posted = true;
        popup.postMessage(request, origin);
        return;
      }
      if (data.id !== id) return;
      if (data.type === 'result') {
        finish(null, data.result);
      } else if (data.type === 'error') {
        finish({ code: data.error?.code ?? -1, message: data.error?.message ?? 'Veil refused request' });
      }
    };

    win.addEventListener('message', onMessage);
    if (reuse) popup.postMessage(request, origin);

    const poll = setInterval(() => {
      if (popup.closed) finish({ code: -4, message: 'Popup closed before answer', ext: 'popup_closed' });
    }, 500);

    const readyTimer = setTimeout(() => {
      if (!posted) finish({ code: -1, message: 'Veil did not answer ready', ext: 'unreachable' });
    }, Math.min(VEIL_READY_MS, timeoutMs));

    const timer = setTimeout(() => finish({ code: -1, message: 'Timeout', ext: 'timeout' }), timeoutMs);
  });
}
