/**
 * CJS wrapper for @noble/hashes/sha2.js (ESM-only).
 * Uses Node.js native crypto for SHA-256 and SHA-512.
 */
const crypto = require('crypto');

function sha256(msg) {
  const hash = crypto.createHash('sha256');
  hash.update(Buffer.from(msg));
  return new Uint8Array(hash.digest());
}

function sha512(msg) {
  const hash = crypto.createHash('sha512');
  hash.update(Buffer.from(msg));
  return new Uint8Array(hash.digest());
}

function create_sha256() {
  const h = crypto.createHash('sha256');
  return {
    update(msg) { h.update(Buffer.from(msg)); return this; },
    digest() { return new Uint8Array(h.digest()); },
    clone() {
      const copy = h.copy();
      return {
        update(msg) { copy.update(Buffer.from(msg)); return this; },
        digest() { return new Uint8Array(copy.digest()); },
      };
    },
  };
}

function create_sha512() {
  const h = crypto.createHash('sha512');
  return {
    update(msg) { h.update(Buffer.from(msg)); return this; },
    digest() { return new Uint8Array(h.digest()); },
    clone() {
      const copy = h.copy();
      return {
        update(msg) { copy.update(Buffer.from(msg)); return this; },
        digest() { return new Uint8Array(copy.digest()); },
      };
    },
  };
}

module.exports = { sha256, sha512, create: create_sha256, sha256: sha256, sha512: sha512 };
// Also export individual for ESM-style import { sha512 } from '@noble/hashes/sha2.js'
Object.defineProperty(module.exports, 'sha256', { enumerable: true, value: sha256 });
Object.defineProperty(module.exports, 'sha512', { enumerable: true, value: sha512 });
