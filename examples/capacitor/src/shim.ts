import { BiometricAuth } from '@capgo/capacitor-native-biometric';

function bufToHex(buf: Uint8Array): string {
  return Array.from(buf, b => b.toString(16).padStart(2, '0')).join('');
}

function hexToBuf(hex: string): Uint8Array {
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < hex.length; i += 2) {
    bytes[i / 2] = parseInt(hex.slice(i, i + 2), 16);
  }
  return bytes;
}

export async function setupCapacitorShim() {
  if (typeof window === 'undefined') return;

  // Detect Capacitor
  const isCapacitor = (window as any).Capacitor !== undefined;
  if (!isCapacitor) return;

  // Intercept credentials.create
  (navigator as any).credentials.create = async (options: any) => {
    const pubKeyCred = options.publicKey;
    if (!pubKeyCred) return null;

    let verified = false;
    try {
      const isAvailable = await BiometricAuth.isAvailable();
      if (isAvailable.has) {
        const authResult = await BiometricAuth.verify({
          reason: 'Register biometric passkey for Veil Wallet',
        });
        verified = authResult.verified;
      } else {
        verified = confirm('Register biometric credentials on this device?');
      }
    } catch {
      verified = confirm('Register biometric credentials on this device?');
    }

    if (!verified) {
      throw new Error('Biometric authentication failed');
    }

    const keyPair = await crypto.subtle.generateKey(
      { name: 'ECDSA', namedCurve: 'P-256' },
      true,
      ['sign', 'verify']
    );

    const spki = await crypto.subtle.exportKey('spki', keyPair.publicKey);
    const pkcs8 = await crypto.subtle.exportKey('pkcs8', keyPair.privateKey);

    const credentialId = 'cap_' + bufToHex(crypto.getRandomValues(new Uint8Array(16)));
    localStorage.setItem(`cap_priv_${credentialId}`, bufToHex(new Uint8Array(pkcs8)));

    const clientDataJSON = new TextEncoder().encode(JSON.stringify({
      type: 'webauthn.create',
      challenge: btoa(String.fromCharCode(...new Uint8Array(pubKeyCred.challenge)))
        .replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, ''),
      origin: window.location.origin,
    }));

    return {
      id: credentialId,
      rawId: new TextEncoder().encode(credentialId),
      response: {
        getPublicKey: () => spki,
        clientDataJSON,
        attestationObject: new Uint8Array(0),
      },
    };
  };

  // Intercept credentials.get
  (navigator as any).credentials.get = async (options: any) => {
    const pubKeyCred = options.publicKey;
    if (!pubKeyCred) return null;

    const allowCredentials = pubKeyCred.allowCredentials || [];
    const cred = allowCredentials[0];
    if (!cred) throw new Error('No credential specified');

    const credentialId = typeof cred.id === 'string' ? cred.id : new TextDecoder().decode(new Uint8Array(cred.id));

    let verified = false;
    try {
      const isAvailable = await BiometricAuth.isAvailable();
      if (isAvailable.has) {
        const authResult = await BiometricAuth.verify({
          reason: 'Unlock Veil Wallet',
        });
        verified = authResult.verified;
      } else {
        verified = confirm('Authenticate with biometrics?');
      }
    } catch {
      verified = confirm('Authenticate with biometrics?');
    }

    if (!verified) {
      throw new Error('Biometric authentication failed');
    }

    const pkcs8Hex = localStorage.getItem(`cap_priv_${credentialId}`);
    if (!pkcs8Hex) throw new Error('Credential not found');

    const privateKey = await crypto.subtle.importKey(
      'pkcs8',
      hexToBuf(pkcs8Hex),
      { name: 'ECDSA', namedCurve: 'P-256' },
      false,
      ['sign']
    );

    const challengeBytes = new Uint8Array(pubKeyCred.challenge);
    const signatureRaw = await crypto.subtle.sign(
      { name: 'ECDSA', hash: { name: 'SHA-256' } },
      privateKey,
      challengeBytes
    );

    const signatureDer = rawToDerSignature(new Uint8Array(signatureRaw));
    const authData = new Uint8Array(37);
    const clientDataJSON = new TextEncoder().encode(JSON.stringify({
      type: 'webauthn.get',
      challenge: btoa(String.fromCharCode(...challengeBytes))
        .replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, ''),
      origin: window.location.origin,
    }));

    return {
      id: credentialId,
      rawId: new TextEncoder().encode(credentialId),
      response: {
        authenticatorData: authData,
        clientDataJSON,
        signature: signatureDer,
      },
    };
  };
}

function rawToDerSignature(rawSig: Uint8Array): Uint8Array {
  const r = rawSig.slice(0, 32);
  const s = rawSig.slice(32, 64);
  const cleanInt = (bytes: Uint8Array) => {
    let start = 0;
    while (start < bytes.length && bytes[start] === 0) start++;
    if (start === bytes.length) return new Uint8Array([0]);
    if (bytes[start] >= 0x80) {
      const res = new Uint8Array(bytes.length - start + 1);
      res.set(bytes.slice(start), 1);
      return res;
    }
    return bytes.slice(start);
  };
  const rDer = cleanInt(r);
  const sDer = cleanInt(s);
  const der = new Uint8Array(2 + rDer.length + 2 + sDer.length + 2);
  der[0] = 0x30;
  der[1] = 2 + rDer.length + 2 + sDer.length;
  der[2] = 0x02;
  der[3] = rDer.length;
  der.set(rDer, 4);
  const sOffset = 4 + rDer.length;
  der[sOffset] = 0x02;
  der[sOffset + 1] = sDer.length;
  der.set(sDer, sOffset + 2);
  return der;
}
