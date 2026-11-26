import init, { Storage, Client, ProverBridge, configureTelemetry, dump_recent_logs } from '/sdk/js/index.js';

let client;
let account;
let pool;
let availableActions = ['initialize'];
const status = document.querySelector('#status');
const log = (message) => { status.textContent += `\n${message}`; };

async function execute(action, operation) {
  if (document.body.dataset.outcome === 'running') return;
  document.querySelectorAll('button').forEach(button => { button.disabled = true; });
  document.body.dataset.outcome = 'running';
  try {
    log(`${action}: started`);
    const result = await operation();
    await window.recordEvidence({ action, result });
    log(`${action}: ${JSON.stringify(result)}`);
    document.body.dataset.outcome = 'ok';
    for (const id of availableActions) document.querySelector(`#${id}`).disabled = false;
  } catch (error) {
    const message = error?.message ?? String(error);
    await window.recordEvidence({ action, error: message });
    log(`${action}: FAILED: ${message}`);
    document.body.dataset.outcome = 'failed';
  }
}

async function poolOperation(operation) {
  const result = await operation();
  const plain = result.toJSON();
  result.free();
  // Persist even a failed multi-step operation's confirmed hashes before rejecting.
  await window.recordEvidence({ action: 'pool-result', result: plain });
  if (plain.status !== 'ok' || !plain.hashes.length) {
    throw new Error(plain.message || `Pool execution: ${plain.status}`);
  }
  return plain;
}

document.querySelector('#initialize').onclick = () => execute('initialize', async () => {
  await init();
  configureTelemetry({ level: 'debug', sink: 'ringBuffer', revealSensitive: false });
  window.sdkDiagnostics = () => dump_recent_logs();
  const config = await (await fetch('/deployments.json')).json();
  const circuitLock = await (await fetch('/circuits.json')).json();
  const identity = await window.signerIdentity();
  document.querySelector('#address').textContent = identity.address;
  const key = crypto.getRandomValues(new Uint8Array(32));
  const storage = await Storage.open({ keyProvider: () => key, createNew: true });
  key.fill(0);
  client = await Client.new({ rpcUrl: config.rpcUrl, contractConfig: config, circuitLock,
    circuitsBaseUrl: `${location.origin}/sdk/dist/circuits/`, storage,
    bootnodeUrl: 'https://bootnode.dev-nethermind.xyz' });
  // Prepare only circuits exercised here, not unrelated traceable/view-only pools.
  log('Preparing standard blocklist and registration circuit keys');
  const preparation = ProverBridge.spawn(`${location.origin}/sdk/dist/workers/prover-worker.js`);
  try {
    await preparation.configureCircuitsBase(`${location.origin}/sdk/dist/circuits/`, JSON.stringify(circuitLock));
    await preparation.prepareCircuits(['policy_tx_2_2_B', 'keyOwnership']);
  } finally {
    preparation.free();
  }
  await client.sync();
  account = await client.account({ networkPassphrase: config.networkPassphrase }, {
    getPublicKey: async () => identity.address,
    signMessage: window.signMessage,
    signTransaction: window.signTransaction,
    signAuthEntry: window.signAuthEntry,
  });
  await account.derivePrivacyKeys();
  pool = await account.pool({ poolContract: config.pools[0].poolContractId });
  window.privateBalance = async () => { await client.sync(); return String(await pool.balance()); };
  availableActions = ['register'];
  return { address: identity.address, pool: config.pools[0].poolContractId };
});

document.querySelector('#register').onclick = () => execute('register', async () => {
  const hash = await account.registerPublicKeys();
  await client.sync();
  availableActions = ['shield', 'send', 'unshield'];
  return { hashes: hash ? [hash] : [], registered: await account.isRegistered() };
});

document.querySelector('#shield').onclick = () => execute('shield', () => poolOperation(() => pool.deposit(50_000_000n)));
document.querySelector('#send').onclick = () => execute('send', async () => {
  const { recipient } = await window.signerIdentity();
  await client.sync();
  const lookup = await client.recipientLookup(recipient);
  if (!lookup.entry || !lookup.registryFullySynced) throw new Error('Recipient registry is not ready');
  return poolOperation(() => pool.transfer(recipient, 20_000_000n));
});
document.querySelector('#unshield').onclick = () => execute('unshield', async () => {
  const { address } = await window.signerIdentity();
  await client.sync();
  return poolOperation(() => pool.withdraw(10_000_000n, address));
});
