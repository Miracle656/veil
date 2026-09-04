import { test, expect } from '@playwright/test';

test.describe('SDK WebAuthn happy-path across browsers', () => {
  test.beforeEach(async ({ page }) => {
    // Inject high-fidelity WebAuthn mock into the browser context
    await page.addInitScript(() => {
      if (typeof navigator.credentials === 'undefined') {
        Object.defineProperty(navigator, 'credentials', {
          value: {},
          writable: true,
          configurable: true
        });
      }

      let keyPair: CryptoKeyPair | null = null;
      async function getKeyPair() {
        if (!keyPair) {
          keyPair = await window.crypto.subtle.generateKey(
            {
              name: 'ECDSA',
              namedCurve: 'P-256',
            },
            true,
            ['sign', 'verify']
          );
        }
        return keyPair;
      }

      // Mock navigator.credentials.create
      // @ts-ignore
      navigator.credentials.create = async (options) => {
        const kp = await getKeyPair();
        const spki = await window.crypto.subtle.exportKey('spki', kp.publicKey);
        const rawId = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]);

        return {
          id: 'mock-credential-id',
          rawId: rawId.buffer,
          type: 'public-key',
          response: {
            clientDataJSON: new TextEncoder().encode(
              JSON.stringify({
                type: 'webauthn.create',
                challenge: 'mock-challenge',
                origin: window.location.origin,
              })
            ).buffer,
            attestationObject: new Uint8Array([]).buffer,
            getPublicKey: () => spki,
          },
        };
      };

      // Mock navigator.credentials.get
      // @ts-ignore
      navigator.credentials.get = async (options) => {
        const kp = await getKeyPair();
        const challenge = options.publicKey.challenge;

        // Minimal authenticatorData (37 bytes): rpIdHash (32B) + flags (1B) + signCount (4B)
        const authData = new Uint8Array(37);
        authData[32] = 0x05; // User Present (0x01) | User Verified (0x04)

        const clientDataJSONStr = JSON.stringify({
          type: 'webauthn.get',
          challenge: btoa(String.fromCharCode(...new Uint8Array(challenge)))
            .replace(/\+/g, '-')
            .replace(/\//g, '_')
            .replace(/=/g, ''),
          origin: window.location.origin,
        });
        const clientDataJSON = new TextEncoder().encode(clientDataJSONStr);

        // Compute message hash: SHA-256(authData || SHA-256(clientDataJSON))
        const clientDataHash = await window.crypto.subtle.digest('SHA-256', clientDataJSON);
        const message = new Uint8Array(authData.length + 32);
        message.set(authData, 0);
        message.set(new Uint8Array(clientDataHash), authData.length);

        const msgHash = await window.crypto.subtle.digest('SHA-256', message);

        const rawSig = await window.crypto.subtle.sign(
          {
            name: 'ECDSA',
            hash: { name: 'SHA-256' },
          },
          kp.privateKey,
          msgHash
        );

        // Convert raw 64-byte signature to DER format
        const rawSigBytes = new Uint8Array(rawSig);
        const r = rawSigBytes.slice(0, 32);
        const s = rawSigBytes.slice(32, 64);

        let rDer = r;
        if (r[0] & 0x80) {
          rDer = new Uint8Array([0, ...r]);
        }
        let sDer = s;
        if (s[0] & 0x80) {
          sDer = new Uint8Array([0, ...s]);
        }

        const rLen = rDer.length;
        const sLen = sDer.length;
        const totalLen = 2 + rLen + 2 + sLen;

        const der = new Uint8Array(2 + totalLen);
        der[0] = 0x30;
        der[1] = totalLen;
        der[2] = 0x02;
        der[3] = rLen;
        der.set(rDer, 4);
        der[4 + rLen] = 0x02;
        der[4 + rLen + 1] = sLen;
        der.set(sDer, 4 + rLen + 2);

        return {
          id: 'mock-credential-id',
          rawId: new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]).buffer,
          type: 'public-key',
          response: {
            clientDataJSON: clientDataJSON.buffer,
            authenticatorData: authData.buffer,
            signature: der.buffer,
          },
        };
      };
    });
  });

  test('runs happy-path registration and signing', async ({ page }) => {
    await page.goto('/');

    // Execute the happy-path flow using the InvisibleWallet SDK in the browser
    const result = await page.evaluate(async () => {
      // @ts-ignore
      const wallet = new window.InvisibleWallet({
        factoryAddress: 'CAUK4MWO3TTFM6PLURSH2GPK3AB747SZGABKTCVLKCU7W2MGKHKP35GA',
        rpcUrl: 'https://soroban-testnet.stellar.org',
      });

      // 1. Register
      const regResult = await wallet.register('testuser');

      // 2. Sign a 32-byte payload
      const payload = new Uint8Array(32);
      payload.fill(7);
      const sigResult = await wallet.signAuthEntry(payload);

      return {
        address: wallet.address,
        regResult,
        sigResult: sigResult ? {
          publicKey: Array.from(sigResult.publicKey),
          authData: Array.from(sigResult.authData),
          clientDataJSON: Array.from(sigResult.clientDataJSON),
          signature: Array.from(sigResult.signature),
        } : null,
      };
    });

    expect(result.address).toBeDefined();
    expect(result.address?.startsWith('C')).toBeTruthy();
    expect(result.regResult.walletAddress).toBe(result.address);
    expect(result.sigResult).not.toBeNull();
    expect(result.sigResult?.publicKey).toBeDefined();
    expect(result.sigResult?.signature.length).toBe(64);
  });
});
