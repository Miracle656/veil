/**
 * A software passkey: a real P-256 key that produces real WebAuthn assertions.
 *
 * The contract verifies these with `secp256r1_verify`, so nothing here is a
 * stand-in — only the authenticator hardware is replaced. What the wallet's
 * `__check_auth` requires of an assertion, and where it is satisfied below:
 *
 *   1. clientDataJSON is a `webauthn.get` ceremony          → `clientDataJSON`
 *   2. its challenge is base64url(signature_payload)        → `clientDataJSON`
 *   3. authenticatorData carries UP and UV (0x01 | 0x04)    → `authenticatorData`
 *   4. the signature covers SHA256(authData ‖ SHA256(cdj)), → `sign`
 *      low-S normalised (the host traps on a high-S value)
 *   5. rpIdHash in authenticatorData = SHA256(stored rpId)  → `authenticatorData`
 *   6. clientDataJSON origin = the stored origin            → `clientDataJSON`
 */
import { createHash, generateKeyPairSync, sign, type KeyObject } from 'node:crypto';
import type { WebAuthnSignature } from '../src/core';

/** Order of the P-256 group, for low-S normalisation. */
const P256_ORDER = 0xffffffff00000000ffffffffffffffffbce6faada7179e84f3b9cac2fc632551n;

export class SoftPasskey {
  readonly publicKey: Uint8Array;
  private readonly privateKey: KeyObject;

  constructor(
    readonly rpId: string,
    readonly origin: string,
  ) {
    const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' });
    const jwk = publicKey.export({ format: 'jwk' });
    // Uncompressed SEC1 point: 0x04 ‖ x ‖ y — the 65 bytes the wallet registers.
    this.publicKey = Buffer.concat([
      Buffer.from([0x04]),
      Buffer.from(jwk.x!, 'base64url'),
      Buffer.from(jwk.y!, 'base64url'),
    ]);
    this.privateKey = privateKey;
  }

  /** The assertion the browser would return for `payloadHash`, as the SDK consumes it. */
  async assert(payloadHash: Uint8Array): Promise<WebAuthnSignature> {
    const authData = this.authenticatorData();
    const clientDataJSON = Buffer.from(
      JSON.stringify({
        type: 'webauthn.get',
        challenge: Buffer.from(payloadHash).toString('base64url'),
        origin: this.origin,
        crossOrigin: false,
      }),
    );

    const signedData = Buffer.concat([
      authData,
      createHash('sha256').update(clientDataJSON).digest(),
    ]);
    // `sign` hashes with SHA-256 itself, which is the ES256 the contract checks.
    const raw = sign('sha256', signedData, { key: this.privateKey, dsaEncoding: 'ieee-p1363' });

    return {
      publicKey: new Uint8Array(this.publicKey),
      authData: new Uint8Array(authData),
      clientDataJSON: new Uint8Array(clientDataJSON),
      signature: new Uint8Array(lowS(raw)),
    };
  }

  /** rpIdHash[32] ‖ flags[1] ‖ signCount[4], with User Present and User Verified set. */
  private authenticatorData(): Buffer {
    const out = Buffer.alloc(37);
    createHash('sha256').update(this.rpId).digest().copy(out, 0);
    out[32] = 0x05;
    return out;
  }
}

/** r ‖ s with s folded into the lower half of the group. */
function lowS(raw: Buffer): Buffer {
  const r = raw.subarray(0, 32);
  let s = BigInt(`0x${raw.subarray(32).toString('hex')}`);
  if (s > P256_ORDER / 2n) s = P256_ORDER - s;
  return Buffer.concat([r, Buffer.from(s.toString(16).padStart(64, '0'), 'hex')]);
}
