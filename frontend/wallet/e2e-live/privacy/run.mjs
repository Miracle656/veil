import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import { readFile, writeFile, mkdir, rename } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from '@playwright/test';
import { verifyPackage } from './verify-package.mjs';
import { transactionHashes, stroops } from './evidence.mjs';
import { verifyChain } from './verify-chain.mjs';
import { Keypair, Networks, TransactionBuilder, rpc } from '@stellar/stellar-sdk';

// Money-moving tests must never be discovered by the ordinary Playwright CI job.
assert.equal(process.env.SPP_LIVE_TESTNET, '1', 'Set SPP_LIVE_TESTNET=1 to deliberately submit testnet payments');
assert.ok(process.env.SPP_SDK_ROOT, 'Set SPP_SDK_ROOT to the verified extracted main-branch SDK package');
const here = path.dirname(fileURLToPath(import.meta.url));
const sdkRoot = path.resolve(process.env.SPP_SDK_ROOT);
const output = path.resolve(process.env.SPP_EVIDENCE_DIR || path.join(here, 'results', new Date().toISOString().replace(/[:.]/g, '-')));
await mkdir(path.dirname(output), { recursive: true });
await mkdir(output);
const config = JSON.parse(await readFile(path.join(here, 'deployments.json'), 'utf8'));
assert.equal(config.network, 'testnet');
assert.equal(config.networkPassphrase, Networks.TESTNET);
assert.equal(config.rpcUrl, 'https://soroban-testnet.stellar.org/');
const expectedLock = await readFile(path.join(here, 'circuits.json'));
assert.deepEqual(JSON.parse(await readFile(path.join(sdkRoot, 'dist/circuits/circuits.json'), 'utf8')), JSON.parse(expectedLock));
await verifyPackage(sdkRoot, JSON.parse(await readFile(path.join(here, 'sdk-files.json'), 'utf8')));
const serverRpc = new rpc.Server(config.rpcUrl);
assert.equal((await serverRpc.getNetwork()).passphrase, Networks.TESTNET);

const sender = Keypair.random();
const recipient = Keypair.random();
const evidence = {
  issue: 1203, startedAt: new Date().toISOString(), status: 'running',
  scope: 'Browser SDK integration with disposable testnet signers; does not exercise Veil passkey onboarding or PRF recovery',
  upstreamCommit: '0ac6da3e171308533b1873155f167a01b69b3aaf',
  artifactId: 14831881878,
  artifactSha256: '4055905225a56d2b7522a1e3054241e0f3ecec6d523b2730025f58ce2389c298',
  packageSha256: '16216bf58241d128997b482a2753b4904fe62d0d68f91902288dca4c27bf565b',
  circuitLockSha256: createHash('sha256').update(expectedLock).digest('hex'),
  network: config.network, rpcUrl: config.rpcUrl, pool: config.pools[0].poolContractId,
  sender: sender.publicKey(), recipient: recipient.publicKey(), events: [], transactions: [],
};
// Signer secrets stay in process memory and are never serialized to evidence or traces.
let pendingSave = Promise.resolve();
const save = () => {
  const snapshot = `${JSON.stringify(evidence, null, 2)}\n`;
  pendingSave = pendingSave.then(async () => {
    await writeFile(path.join(output, 'evidence.tmp'), snapshot);
    await rename(path.join(output, 'evidence.tmp'), path.join(output, 'evidence.json'));
  });
  return pendingSave;
};
await save();

const server = createServer(async (request, response) => {
  try {
    const pathname = decodeURIComponent(new URL(request.url, 'http://localhost').pathname);
    const sdk = pathname.startsWith('/sdk/');
    const root = sdk ? sdkRoot : here;
    const file = path.resolve(root, '.' + (sdk ? pathname.slice(4) : pathname === '/' ? '/browser.html' : pathname));
    if (!file.startsWith(root + path.sep)) { response.writeHead(404).end(); return; }
    // Serve an explicit local fixture allowlist; evidence is never exposed by this server.
    if (!sdk && !['browser.html', 'browser.js', 'deployments.json', 'circuits.json'].includes(path.relative(here, file))) {
      response.writeHead(404).end(); return;
    }
    response.setHeader('content-type', ({ '.html': 'text/html', '.js': 'text/javascript', '.json': 'application/json', '.wasm': 'application/wasm' })[path.extname(file)] || 'application/octet-stream');
    response.end(await readFile(file));
  } catch { response.writeHead(404).end(); }
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
let browser;
async function publicBalance(address) {
  const response = await fetch(`https://horizon-testnet.stellar.org/accounts/${address}`);
  assert.ok(response.ok, `Horizon account lookup failed: ${response.status}`);
  const data = await response.json();
  return data.balances.find(balance => balance.asset_type === 'native').balance;
}
async function fund(keypair) {
  const response = await fetch(`https://friendbot.stellar.org?addr=${keypair.publicKey()}`);
  assert.ok(response.ok, `Friendbot failed: ${response.status}`);
  for (let i = 0; i < 30; i++) {
    try { await serverRpc.getAccount(keypair.publicKey()); return; } catch { await new Promise(resolve => setTimeout(resolve, 1000)); }
  }
  throw new Error('Funded account did not become visible');
}
async function openPage(keypair) {
  const context = await browser.newContext();
  const page = await context.newPage();
  page.setDefaultTimeout(15 * 60_000);
  await page.exposeFunction('signerIdentity', () => ({ address: keypair.publicKey(), recipient: recipient.publicKey() }));
  await page.exposeFunction('signMessage', (message, options) => {
    assert.ok(!options?.address || options.address === keypair.publicKey());
    const digest = createHash('sha256').update(`Stellar Signed Message:\n${message}`).digest();
    return { signedMessage: Buffer.from(keypair.sign(digest)).toString('base64'), signerAddress: keypair.publicKey() };
  });
  await page.exposeFunction('signTransaction', async (xdr, options) => {
    assert.equal(options?.networkPassphrase, Networks.TESTNET);
    const transaction = TransactionBuilder.fromXDR(xdr, Networks.TESTNET);
    transaction.sign(keypair);
    // A broadcast may succeed even when the SDK never returns a PoolExecuteResult.
    evidence.events.push({ at: new Date().toISOString(), address: keypair.publicKey(), action: 'signed-transaction', hash: transaction.hash().toString('hex') });
    await save();
    return { signedTxXdr: transaction.toXDR(), signerAddress: keypair.publicKey() };
  });
  await page.exposeFunction('signAuthEntry', entry => ({
    signedAuthEntry: Buffer.from(keypair.sign(createHash('sha256').update(Buffer.from(entry, 'base64')).digest())).toString('base64'),
    signerAddress: keypair.publicKey(),
  }));
  await page.exposeFunction('recordEvidence', async event => {
    evidence.events.push({ at: new Date().toISOString(), address: keypair.publicKey(), ...event });
    await save();
  });
  page.on('requestfailed', request => {
    console.error('Request failed:', request.method(), request.url(), request.failure()?.errorText);
  });
  page.on('response', response => {
    if (!response.ok()) console.error('HTTP failure:', response.status(), response.url());
  });
  page.on('pageerror', error => console.error('Browser:', error.message));
  await page.goto(`http://127.0.0.1:${server.address().port}`);
  return page;
}
async function confirmTransaction(hash) {
  if (evidence.transactions.some(transaction => transaction.hash === hash && transaction.status === 'SUCCESS')) return;
  let transaction;
  for (let attempt = 0; attempt < 30; attempt++) {
    transaction = await serverRpc.getTransaction(hash);
    if (transaction.status !== 'NOT_FOUND') break;
    await new Promise(resolve => setTimeout(resolve, 1000));
  }
  evidence.transactions = evidence.transactions.filter(transaction => transaction.hash !== hash);
  evidence.transactions.push({ hash, status: transaction.status, ledger: transaction.ledger, createdAt: transaction.createdAt });
  await save();
  assert.equal(transaction.status, 'SUCCESS', `Transaction ${hash} must independently confirm`);
}
async function click(page, action) {
  console.log(`${action}: ${await page.locator('#address').innerText()}`);
  const firstEvent = evidence.events.length;
  await page.locator(`#${action}`).click();
  await page.waitForFunction(() => ['ok', 'failed'].includes(document.body.dataset.outcome), null, { timeout: 15 * 60_000 });
  await page.screenshot({ path: path.join(output, `${evidence.events.length}-${action}.png`), fullPage: true });
  // Confirm hashes even if the UI reported failure after a successful submission.
  for (const hash of transactionHashes(evidence.events.slice(firstEvent))) await confirmTransaction(hash);
  assert.equal(await page.locator('body').getAttribute('data-outcome'), 'ok', await page.locator('#status').innerText());
}
async function balance(page, minimum) {
  for (let i = 0; i < 30; i++) {
    const value = BigInt(await page.evaluate(() => window.privateBalance()));
    if (value >= minimum) return value;
    await new Promise(resolve => setTimeout(resolve, 2000));
  }
  throw new Error(`Private balance did not reach ${minimum}`);
}
try {
  browser = await chromium.launch({ headless: process.env.SPP_HEADED !== '1' });
  evidence.browserVersion = browser.version();
  evidence.nodeVersion = process.version;
  await save();
  const senderPage = await openPage(sender);
  const recipientPage = await openPage(recipient);
  await click(senderPage, 'initialize');
  await click(recipientPage, 'initialize');
  // Fund only after both clients prove they can sync this exact deployment.
  await fund(sender);
  await fund(recipient);
  evidence.initialPublicBalances = { sender: await publicBalance(sender.publicKey()), recipient: await publicBalance(recipient.publicKey()) };
  await save();
  await click(senderPage, 'register');
  await click(recipientPage, 'register');
  await click(senderPage, 'shield');
  evidence.afterShield = { senderPrivate: String(await balance(senderPage, 40_000_000n)) };
  await save();
  await click(senderPage, 'send');
  const received = await balance(recipientPage, 10_000_000n);
  evidence.afterSend = { senderPrivate: await senderPage.evaluate(() => window.privateBalance()), recipientPrivate: String(received) };
  const beforeWithdraw = await publicBalance(recipient.publicKey());
  await save();
  await click(recipientPage, 'unshield');
  const remaining = BigInt(await recipientPage.evaluate(() => window.privateBalance()));
  assert.ok(remaining < received, 'Withdrawal must consume recipient private notes');
  const hashes = transactionHashes(evidence.events);
  assert.ok(hashes.length >= 5, 'Require registration and all three payment operations');
  for (const hash of hashes) await confirmTransaction(hash);
  const afterWithdraw = await publicBalance(recipient.publicKey());
  assert.ok(stroops(afterWithdraw) > stroops(beforeWithdraw), 'Withdrawal must credit public XLM after fees');
  evidence.afterUnshield = { recipientPrivate: String(remaining), recipientPublicBefore: beforeWithdraw, recipientPublicAfter: afterWithdraw };
  evidence.status = 'completed';
  evidence.chainVerification = await verifyChain(evidence, config);
  console.log(`Completed; evidence: ${path.join(output, 'evidence.json')}`);
} catch (error) {
  for (const hash of transactionHashes(evidence.events)) {
    try { await confirmTransaction(hash); }
    catch (confirmationError) { console.error('Confirmation:', confirmationError.message); }
  }
  try {
    const diagnostics = await Promise.all((browser?.contexts() || []).flatMap(context => context.pages()).map(page => page.evaluate(() => window.sdkDiagnostics?.())));
    await writeFile(path.join(output, 'sdk-diagnostics.json'), JSON.stringify(diagnostics, null, 2));
  } catch (diagnosticError) { console.error('Diagnostics unavailable:', diagnosticError.message); }
  evidence.status = 'failed';
  evidence.error = error.message;
  console.error(error.message);
  process.exitCode = 1;
} finally {
  evidence.finishedAt = new Date().toISOString();
  await save();
  await browser?.close();
  await new Promise(resolve => server.close(resolve));
}
