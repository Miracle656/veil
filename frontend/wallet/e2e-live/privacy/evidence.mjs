import assert from 'node:assert/strict';

export function transactionHashes(events) {
  return [...new Set(events.flatMap(event => [
    ...(event.result?.hashes || []),
    ...(event.action === 'signed-transaction' ? [event.hash] : []),
  ]))].map(hash => {
    assert.match(hash, /^[a-f0-9]{64}$/, 'Evidence must contain full transaction hashes');
    return hash;
  });
}

export function stroops(amount) {
  assert.match(amount, /^\d+\.\d{7}$/, 'Horizon XLM balances must have seven decimal places');
  return BigInt(amount.replace('.', ''));
}
