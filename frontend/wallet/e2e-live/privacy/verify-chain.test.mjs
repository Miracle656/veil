import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { Account, Address, Keypair, Networks, Operation, StrKey, TransactionBuilder, nativeToScVal, rpc, xdr } from '@stellar/stellar-sdk';
import { verifyChain } from './verify-chain.mjs';

const config = JSON.parse(await readFile(new URL('./deployments.json', import.meta.url), 'utf8'));
const pool = config.pools[0].poolContractId;
const token = config.pools[0].tokenContractId;

function fixture({ sendSource } = {}) {
  const sender = Keypair.random();
  const recipient = Keypair.random();
  const responses = new Map();
  let sequence = 1;
  function transfer(from, to, amount) {
    return new xdr.ContractEvent({
      ext: new xdr.ExtensionPoint(0), contractId: StrKey.decodeContract(token),
      type: xdr.ContractEventType.contract(),
      body: new xdr.ContractEventBody(0, new xdr.ContractEventV0({
        topics: [nativeToScVal('transfer', { type: 'symbol' }), new Address(from).toScVal(), new Address(to).toScVal()],
        data: nativeToScVal(BigInt(amount), { type: 'i128' }),
      })),
    });
  }
  function transaction(signer, operation, events = []) {
    const envelope = new TransactionBuilder(new Account(signer.publicKey(), String(sequence++)), {
      fee: '100', networkPassphrase: Networks.TESTNET,
    }).addOperation(operation).setTimeout(0).build();
    envelope.sign(signer);
    const hash = envelope.hash().toString('hex');
    // Offline RPC fixtures exercise the real envelope decoder and native-token event decoder.
    responses.set(hash, {
      status: 'SUCCESS', ledger: sequence, createdAt: '1', envelopeXdr: envelope.toEnvelope(),
      resultMetaXdr: { switch: () => 3, v3: () => ({ sorobanMeta: () => ({ events: () => events }) }) },
    });
    return hash;
  }
  function invocation(source) {
    return Operation.invokeContractFunction({ contract: pool, function: 'transact', args: [], ...(source ? { source } : {}) });
  }
  const shield = transaction(sender, invocation(), [transfer(sender.publicKey(), pool, '51000000')]);
  const send = transaction(sender, invocation(sendSource === 'sender' ? sender.publicKey() : sendSource));
  const unshield = transaction(recipient, invocation(), [transfer(pool, recipient.publicKey(), '10000000')]);
  const evidence = {
    status: 'completed', network: 'testnet', rpcUrl: 'https://soroban-testnet.stellar.org/', pool,
    sender: sender.publicKey(), recipient: recipient.publicKey(), afterSend: { recipientPrivate: '20000000' },
    events: [['shield', sender, shield], ['send', sender, send], ['unshield', recipient, unshield]]
      .map(([action, signer, hash]) => ({ action, address: signer.publicKey(), result: { status: 'ok', hashes: [hash] } })),
  };
  return { evidence, responses, sender, transfer, transaction, shield, send, unshield };
}

function stubRpc(t, responses) {
  t.mock.method(rpc.Server.prototype, 'getTransaction', async hash => {
    assert.ok(responses.has(hash), 'Offline verifier tests must not make a network request');
    return responses.get(hash);
  });
}

test('verifier accepts distinct pool payments with transfers on their own transaction', async t => {
  const { evidence, responses } = fixture();
  stubRpc(t, responses);
  // A genuine shield/send/unshield shape must survive the negative-case hardening.
  assert.equal((await verifyChain(evidence, config)).transactions.length, 3);
});

test('verifier accepts an explicit operation source equal to its expected signer', async t => {
  const { evidence, responses } = fixture({ sendSource: 'sender' });
  stubRpc(t, responses);
  // An explicit source is valid when it does not change who invokes the pool.
  await verifyChain(evidence, config);
});

test('verifier rejects an unrelated public transfer used as shield evidence', async t => {
  const f = fixture();
  const meta = f.responses.get(f.shield).resultMetaXdr;
  meta.v3 = () => ({ sorobanMeta: () => ({ events: () => [] }) });
  const topup = f.transaction(f.sender, Operation.invokeContractFunction({
    contract: token, function: 'transfer',
    args: [new Address(f.sender.publicKey()).toScVal(), new Address(pool).toScVal(), nativeToScVal(51_000_000n, { type: 'i128' })],
  }), [f.transfer(f.sender.publicKey(), pool, '51000000')]);
  f.evidence.events[0].result.hashes.push(topup);
  stubRpc(t, f.responses);
  // A pool call and a separate public top-up must not combine into a fictitious shield.
  await assert.rejects(verifyChain(f.evidence, config), /Shield pool invocation must transfer/);
});

test('verifier rejects transaction hashes reused by different payment actions', async t => {
  const f = fixture();
  f.evidence.events[0].result.hashes.push(f.send);
  stubRpc(t, f.responses);
  // One successful pool transaction cannot stand in for both shield and private send.
  await assert.rejects(verifyChain(f.evidence, config), /Different payment actions must not reuse/);
});

test('verifier rejects a pool operation sourced by a different account', async t => {
  const other = Keypair.random().publicKey();
  const { evidence, responses, send } = fixture({ sendSource: other });
  const decoded = TransactionBuilder.fromXDR(responses.get(send).envelopeXdr.toXDR('base64'), Networks.TESTNET);
  assert.equal(decoded.source, evidence.sender);
  assert.equal(decoded.operations[0].source, other);
  stubRpc(t, responses);
  // Paying the envelope fee is not evidence that its overridden operation source invoked the pool.
  await assert.rejects(verifyChain(evidence, config), /send must invoke transact.*expected signer/);
});
