import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { rpc, StrKey, scValToNative, TransactionBuilder, Networks, Address } from '@stellar/stellar-sdk';
import { transactionHashes } from './evidence.mjs';

function tokenTransfers(transaction, token) {
  const meta = transaction.resultMetaXdr;
  const events = meta.switch() === 4
    ? meta.v4().operations().flatMap(operation => operation.events())
    : meta.v3().sorobanMeta()?.events() || [];
  return events.filter(event => event.contractId() && StrKey.encodeContract(event.contractId()) === token)
    .flatMap(event => {
      const topics = event.body().v0().topics().map(scValToNative);
      if (topics[0] !== 'transfer') return [];
      return [{ from: topics[1], to: topics[2], amount: String(scValToNative(event.body().v0().data())) }];
    });
}

export async function verifyChain(evidence, config) {
  assert.equal(evidence.status, 'completed', 'Only completed runs can be payment evidence');
  assert.equal(evidence.network, 'testnet');
  assert.equal(evidence.rpcUrl, 'https://soroban-testnet.stellar.org/');
  assert.equal(evidence.pool, config.pools[0].poolContractId);
  const server = new rpc.Server(evidence.rpcUrl);
  const transactions = new Map();
  const confirmations = [];
  for (const hash of transactionHashes(evidence.events)) {
    const tx = await server.getTransaction(hash);
    assert.equal(tx.status, 'SUCCESS', `Transaction ${hash} must independently confirm`);
    const tokenEvents = tokenTransfers(tx, config.pools[0].tokenContractId);
    transactions.set(hash, { tx, tokenEvents });
    confirmations.push({ hash, status: tx.status, ledger: tx.ledger, createdAt: tx.createdAt, tokenTransfers: tokenEvents });
  }
  const paymentHashes = new Set();
  for (const [action, address] of [['shield', evidence.sender], ['send', evidence.sender], ['unshield', evidence.recipient]]) {
    const event = evidence.events.find(event => event.action === action && event.address === address);
    assert.equal(event?.result?.status, 'ok', `${action} needs its own successful result`);
    assert.ok(event.result.hashes.length > 0);
    for (const hash of event.result.hashes) {
      assert.ok(!paymentHashes.has(hash), 'Different payment actions must not reuse a transaction hash');
      paymentHashes.add(hash);
    }
    const poolTransactions = event.result.hashes.map(hash => transactions.get(hash)).filter(({ tx }) => {
      const envelope = TransactionBuilder.fromXDR(tx.envelopeXdr.toXDR('base64'), Networks.TESTNET);
      return envelope.source === address && envelope.operations.some(operation => {
        if ((operation.source ?? envelope.source) !== address) return false;
        if (operation.type !== 'invokeHostFunction' || operation.func.switch().name !== 'hostFunctionTypeInvokeContract') return false;
        const call = operation.func.invokeContract();
        return Address.fromScAddress(call.contractAddress()).toString() === evidence.pool && call.functionName().toString() === 'transact';
      });
    });
    assert.ok(poolTransactions.length > 0, `${action} must invoke transact on the pinned pool from its expected signer`);
    // An unrelated successful transfer must not supply another transaction's shield/unshield evidence.
    const poolTransfers = poolTransactions.flatMap(transaction => transaction.tokenEvents);
    if (action === 'shield') assert.ok(poolTransfers.some(transfer => transfer.from === evidence.sender && transfer.to === evidence.pool && BigInt(transfer.amount) >= 50_000_000n), 'Shield pool invocation must transfer real XLM to the pinned pool');
    if (action === 'send') assert.equal(event.result.hashes.flatMap(hash => transactions.get(hash).tokenEvents).length, 0, 'Private send must not substitute a public token transfer');
    if (action === 'unshield') assert.ok(poolTransfers.some(transfer => transfer.from === evidence.pool && transfer.to === evidence.recipient && transfer.amount === '10000000'), 'Unshield pool invocation must transfer exactly 1 XLM from the pool to the recipient');
  }
  assert.equal(evidence.afterSend.recipientPrivate, '20000000', 'Recipient must observe the private 2 XLM output');
  return { checkedAt: new Date().toISOString(), transactions: confirmations };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  assert.ok(process.argv[2], 'Pass the completed evidence.json path');
  const evidence = JSON.parse(await readFile(process.argv[2], 'utf8'));
  const config = JSON.parse(await readFile(new URL('./deployments.json', import.meta.url), 'utf8'));
  const result = await verifyChain(evidence, config);
  if (process.argv[3]) await writeFile(process.argv[3], `${JSON.stringify(result, null, 2)}\n`);
  console.log(JSON.stringify(result, null, 2));
}
