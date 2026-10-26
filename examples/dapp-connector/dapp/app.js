/**
 * app.js — SEP-43 Reference dApp Logic
 *
 * Drives the Veil wallet through Stellar's SEP-0043 standard interface:
 *  - getAddress()
 *  - getNetwork()
 *  - signTransaction()
 *  - signAuthEntry()
 *  - signMessage()
 *
 * Zero private key material or custom wallet logic is present in this dApp.
 */
'use strict';

const statusEl = document.getElementById('status');
const outputEl = document.getElementById('output');
const btnConnect = document.getElementById('btn-connect');
const btnSignTx = document.getElementById('btn-sign-tx');
const btnSignAuth = document.getElementById('btn-sign-auth');
const btnSignMsg = document.getElementById('btn-sign-msg');

let connectedAddress = null;
let connectedNetwork = null;

function log(title, data) {
  const content = typeof data === 'string' ? data : JSON.stringify(data, null, 2);
  outputEl.textContent = `=== ${title} ===\n${content}`;
}

function getProvider() {
  return window.stellar?.veil || window.veil || null;
}

// 1. Connect via getAddress() and getNetwork()
btnConnect.addEventListener('click', async () => {
  const provider = getProvider();
  if (!provider) {
    statusEl.textContent = 'Status: Veil wallet not detected. Please inject provider or extension.';
    return;
  }

  try {
    statusEl.textContent = 'Status: Fetching wallet address and network...';
    
    // Call standard SEP-43 getAddress()
    const addressRes = await provider.getAddress();
    if (addressRes.error) {
      throw new Error(`getAddress error: ${addressRes.error.message} (code ${addressRes.error.code})`);
    }
    connectedAddress = addressRes.address;

    // Call standard SEP-43 getNetwork()
    const networkRes = await provider.getNetwork();
    if (networkRes.error) {
      throw new Error(`getNetwork error: ${networkRes.error.message} (code ${networkRes.error.code})`);
    }
    connectedNetwork = networkRes;

    statusEl.textContent = `Status: Connected to ${connectedAddress} on ${connectedNetwork.network}`;
    log('Connected via SEP-43', {
      address: connectedAddress,
      network: connectedNetwork.network,
      networkPassphrase: connectedNetwork.networkPassphrase,
    });

    btnSignTx.disabled = false;
    btnSignAuth.disabled = false;
    btnSignMsg.disabled = false;
  } catch (err) {
    statusEl.textContent = `Status: Connection failed (${err.message})`;
    log('Connection Error', { error: err.message });
  }
});

// 2. Sign Transaction via signTransaction()
btnSignTx.addEventListener('click', async () => {
  const provider = getProvider();
  if (!provider || !connectedAddress) return;

  // Sample base64 transaction XDR for testnet
  const sampleTxXdr = 'AAAAAgAAAAD2vC9J7b4HwPq3N0vE5xK8vO1mQ8L7W9X2pL0sX3vR5AAAAAZAAB6IAAAAAQAAAAAAAAAAAAAAAQAAAAAAAAABAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA==';

  try {
    statusEl.textContent = 'Status: Requesting transaction signature...';
    const result = await provider.signTransaction(sampleTxXdr, {
      networkPassphrase: connectedNetwork?.networkPassphrase,
      address: connectedAddress,
      submit: false,
    });

    if (result.error) {
      throw new Error(`signTransaction error: ${result.error.message} (code ${result.error.code})`);
    }

    statusEl.textContent = 'Status: Transaction successfully signed.';
    log('signTransaction Result', result);
  } catch (err) {
    statusEl.textContent = `Status: Signing failed (${err.message})`;
    log('Transaction Signing Error', { error: err.message });
  }
});

// 3. Sign Soroban Auth Entry via signAuthEntry()
btnSignAuth.addEventListener('click', async () => {
  const provider = getProvider();
  if (!provider || !connectedAddress) return;

  // Sample base64 SorobanAuthorizationEntry XDR
  const sampleAuthEntryXdr = 'AAAAAgAAAAAAAAAFAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=';

  try {
    statusEl.textContent = 'Status: Requesting Soroban auth entry signature...';
    const result = await provider.signAuthEntry(sampleAuthEntryXdr, {
      networkPassphrase: connectedNetwork?.networkPassphrase,
      address: connectedAddress,
    });

    if (result.error) {
      throw new Error(`signAuthEntry error: ${result.error.message} (code ${result.error.code})`);
    }

    statusEl.textContent = 'Status: Auth entry successfully signed.';
    log('signAuthEntry Result', result);
  } catch (err) {
    statusEl.textContent = `Status: Auth entry signing failed (${err.message})`;
    log('Auth Entry Signing Error', { error: err.message });
  }
});

// 4. Sign Message via signMessage()
btnSignMsg.addEventListener('click', async () => {
  const provider = getProvider();
  if (!provider || !connectedAddress) return;

  const sampleMessage = 'Sign into Veil Reference dApp on Testnet';

  try {
    statusEl.textContent = 'Status: Requesting message signature...';
    const result = await provider.signMessage(sampleMessage, {
      address: connectedAddress,
    });

    if (result.error) {
      throw new Error(`signMessage error: ${result.error.message} (code ${result.error.code})`);
    }

    statusEl.textContent = 'Status: Message successfully signed.';
    log('signMessage Result', result);
  } catch (err) {
    statusEl.textContent = `Status: Message signing failed (${err.message})`;
    log('Message Signing Error', { error: err.message });
  }
});