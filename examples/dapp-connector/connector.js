/**
 * connector.js — Veil content script & SEP-43 standard wallet provider
 *
 * Injected into every page at document_start.
 * Exposes `window.stellar.veil` and `window.veil` conforming to SEP-0043
 * (Standard Web Wallet API Interface):
 *   - getAddress()
 *   - getNetwork()
 *   - signTransaction(xdr, opts)
 *   - signAuthEntry(authEntry, opts)
 *   - signMessage(message, opts)
 *
 * Also preserves backwards-compatible request({ method, params }) dispatch.
 * Private key material NEVER crosses into the page context.
 */
(function () {
  'use strict';

  if (window.stellar?.veil && window.veil?.getAddress) return; // already injected

  let _nextId = 1;
  const _pending = new Map(); // id → { resolve, reject }

  // Listen for responses forwarded back from the background via the
  // extension's content-script bridge (background → content-script → page).
  window.addEventListener('message', (event) => {
    if (event.source !== window) return;
    const msg = event.data;
    if (!msg || msg.__veil_direction !== 'from_background') return;

    const handler = _pending.get(msg.id);
    if (!handler) return;
    _pending.delete(msg.id);

    if (msg.error) {
      handler.reject(new Error(msg.error));
    } else {
      handler.resolve(msg.result);
    }
  });

  /**
   * Send a request to the Veil extension background and return a Promise.
   *
   * @param {{ method: string, params?: object }} req
   * @returns {Promise<any>}
   */
  function request(req) {
    return new Promise((resolve, reject) => {
      if (!req || typeof req.method !== 'string') {
        return reject(new Error('veil: request must have a string method'));
      }

      const id = _nextId++;
      _pending.set(id, { resolve, reject });

      // Forward to the content-script injected in ISOLATED world, which
      // relays to the background service worker.
      window.postMessage(
        { __veil_direction: 'to_background', id, method: req.method, params: req.params ?? {} },
        window.location.origin,
      );

      // Timeout safety — avoid leaking pending handlers.
      setTimeout(() => {
        if (_pending.has(id)) {
          _pending.delete(id);
          reject(new Error(`veil: request "${req.method}" timed out`));
        }
      }, 30_000);
    });
  }

  // ── SEP-43 Standard Web Wallet API Surface ────────────────────────────────

  const sep43Provider = Object.freeze({
    /**
     * Retrieve the active wallet address.
     * @returns {Promise<{ address?: string, error?: { code: number, message: string } }>}
     */
    async getAddress() {
      try {
        const result = await request({ method: 'getAddress' });
        if (result && typeof result === 'object' && result.address) {
          return result;
        }
        if (typeof result === 'string') {
          return { address: result };
        }
        return result ?? { error: { code: -3, message: 'No wallet available' } };
      } catch (err) {
        return { error: { code: -3, message: err.message || String(err) } };
      }
    },

    /**
     * Retrieve the current network configuration.
     * @returns {Promise<{ network?: string, networkPassphrase?: string, error?: { code: number, message: string } }>}
     */
    async getNetwork() {
      try {
        return await request({ method: 'getNetwork' });
      } catch (err) {
        return { error: { code: -1, message: err.message || String(err) } };
      }
    },

    /**
     * Sign a transaction envelope XDR.
     * @param {string} xdr
     * @param {{ networkPassphrase?: string, address?: string, submit?: boolean, submitUrl?: string }} [opts]
     * @returns {Promise<{ signedTxXdr?: string, signerAddress?: string, error?: { code: number, message: string } }>}
     */
    async signTransaction(xdr, opts = {}) {
      try {
        return await request({
          method: 'signTransaction',
          params: { xdr, ...opts },
        });
      } catch (err) {
        return { error: { code: -3, message: err.message || String(err) } };
      }
    },

    /**
     * Sign a Soroban authorization entry XDR.
     * @param {string} authEntry
     * @param {{ networkPassphrase?: string, address?: string }} [opts]
     * @returns {Promise<{ signedAuthEntry?: string, signerAddress?: string, error?: { code: number, message: string } }>}
     */
    async signAuthEntry(authEntry, opts = {}) {
      try {
        return await request({
          method: 'signAuthEntry',
          params: { authEntry, ...opts },
        });
      } catch (err) {
        return { error: { code: -3, message: err.message || String(err) } };
      }
    },

    /**
     * Sign an arbitrary message.
     * @param {string} message
     * @param {{ networkPassphrase?: string, address?: string }} [opts]
     * @returns {Promise<{ signedMessage?: string, signerAddress?: string, error?: { code: number, message: string } }>}
     */
    async signMessage(message, opts = {}) {
      try {
        return await request({
          method: 'signMessage',
          params: { message, ...opts },
        });
      } catch (err) {
        return { error: { code: -3, message: err.message || String(err) } };
      }
    },

    /** Backwards-compatible generic request dispatcher. */
    request,
  });

  // Expose as window.veil and window.stellar.veil
  window.veil = sep43Provider;
  window.stellar = window.stellar || {};
  window.stellar.veil = sep43Provider;
})();