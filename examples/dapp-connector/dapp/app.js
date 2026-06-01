/**
 * app.js — reference dApp logic
 *
 * Demonstrates connect + sign_tx via window.veil without touching
 * any private key material.  The extension handles all signing;
 * this page only sends XDR payloads and receives signed results.
 */
'use strict';

const statusEl = document.getElementById('status');
const outputEl = document.getElementById('output');
const btnConnect = document.getElementById('btn-connect');
const btnSign    = document.getElementById('btn-sign');

function log(data) {
  outputEl.textContent = typeof data === 'string' ? data : JSON.stringify(data, null, 2);
}

btnConnect.addEventListener('click', async () => {
  if (!window.veil) {
    statusEl.textContent = 'Veil extension not detected. Load the extension first.';
    return;
  }

  try {
    statusEl.textContent = 'Connecting…';
    const result = await window.veil.request({ method: 'connect' });
    statusEl.textContent = `Connected: ${result.publicKey}`;
    log(result);
    btnSign.disabled = false;
    btnConnect.disabled = true;
  } catch (err) {
    statusEl.textContent = `Connection failed: ${err.message}`;
  }
});

btnSign.addEventListener('click', async () => {
  // A placeholder XDR blob — a real dApp would build this via stellar-sdk.
  const sampleXdr = btoa('AAAAAQAAACB placeholder transaction XDR AAAAAAAAAA==');

  try {
    statusEl.textContent = 'Waiting for signature…';
    const result = await window.veil.request({
      method: 'sign_tx',
      params: { xdr: sampleXdr },
    });
    statusEl.textContent = 'Transaction signed.';
    log(result);
  } catch (err) {
    statusEl.textContent = `Signing failed: ${err.message}`;
    log({ error: err.message });
  }
});