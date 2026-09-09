/**
 * CJS wrapper for @noble/ed25519 (ESM-only).
 * Uses Node.js native Ed25519 support (available since Node 16).
 */
const crypto = require('crypto');

// Ed25519 PKCS8 DER prefix (30 2e 02 01 00 30 05 06 03 2b 65 70 04 22 04 20)
const ED25519_PKCS8_PREFIX = Buffer.from('302e020100300506032b657004220420', 'hex');
// Ed25519 SPKI DER prefix: 30 2a 30 05 06 03 2b 65 70 03 21 00
// The tail must be 03 21 00 -- BIT STRING, 33 bytes, 0 unused bits. The PKCS8
// tail (04 22 04, OCTET STRING/34) produces DER that createPublicKey rejects,
// and the catch in verify() would swallow that throw and return false for
// every signature -- valid ones included. See __tests__/ed25519-shim.test.ts,
// which pins the shim against Node's own Ed25519 implementation.
const ED25519_SPKI_PREFIX = Buffer.from('302a300506032b6570032100', 'hex');

function getPublicKey(privateKey) {
  const privKeyObj = crypto.createPrivateKey({
    key: Buffer.concat([ED25519_PKCS8_PREFIX, Buffer.from(privateKey)]),
    format: 'der',
    type: 'pkcs8',
  });
  const pubKeyObj = crypto.createPublicKey(privKeyObj);
  const spki = pubKeyObj.export({ type: 'spki', format: 'der' });
  // SPKI Ed25519 public key: last 32 bytes of the DER
  return new Uint8Array(spki.subarray(spki.length - 32));
}

function sign(message, privateKey) {
  const privKeyObj = crypto.createPrivateKey({
    key: Buffer.concat([ED25519_PKCS8_PREFIX, Buffer.from(privateKey)]),
    format: 'der',
    type: 'pkcs8',
  });
  const sig = crypto.sign(null, Buffer.from(message), privKeyObj);
  return new Uint8Array(sig);
}

function verify(signature, message, publicKey) {
  try {
    const pubKeyObj = crypto.createPublicKey({
      key: Buffer.concat([ED25519_SPKI_PREFIX, Buffer.from(publicKey)]),
      format: 'der',
      type: 'spki',
    });
    return crypto.verify(null, Buffer.from(message), pubKeyObj, Buffer.from(signature));
  } catch {
    return false;
  }
}

module.exports = {
  getPublicKey,
  getPublicKeyAsync: async (...args) => getPublicKey(...args),
  sign,
  verify,
  hashes: {},
};
