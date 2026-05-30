/**
 * connector.js — Veil content script
 *
 * Injected into every page (world: MAIN) at document_start.
 * Exposes `window.veil` — a minimal EIP-1193-style provider that
 * proxies requests to the Veil extension background via postMessage.
 *
 * Private key material NEVER crosses into the page context.
 */
(function () {
  'use strict';

  if (window.veil) return; // already injected

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
   * Send a request to the Veil extension and return a Promise.
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

  window.veil = Object.freeze({ request });
})();