import { signMessage, verifyMessage, SignedMessage } from '../signMessage';
import { WebAuthnSignature } from '../useInvisibleWallet';

// Produces a WebAuthn-style assertion where:
//   clientDataJSON = { type: 'webauthn.get', challenge: base64url(hash), origin }
//   signature     = ECDSA( authData || SHA-256(clientDataJSON) )
// This matches the real WebAuthn signing path in useInvisibleWallet.signAuthEntry().
async function generateSignedWebAuthnSig(hash: Uint8Array): Promise<{
    sig: WebAuthnSignature;
    credentialId: string;
    publicKeyBytes: Uint8Array;
}> {
    const kp = await crypto.subtle.generateKey(
        { name: 'ECDSA', namedCurve: 'P-256' },
        true,
        ['sign', 'verify']
    );

    const rawPub = await crypto.subtle.exportKey('raw', kp.publicKey);
    const publicKeyBytes = new Uint8Array(rawPub);

    // Build WebAuthn clientDataJSON with challenge = base64url(hash)
    const challengeB64 = btoa(String.fromCharCode(...hash))
        .replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '');
    const clientDataObj = { type: 'webauthn.get', challenge: challengeB64, origin: 'https://veil.xyz' };
    const clientDataJSON = new TextEncoder().encode(JSON.stringify(clientDataObj));

    // Minimal 37-byte authData (rpIdHash[32] + flags[1] + signCount[4])
    const authData = new Uint8Array(37).fill(1);

    // Sign over authData || SHA-256(clientDataJSON) — real WebAuthn signing path
    const clientDataHash = new Uint8Array(await crypto.subtle.digest('SHA-256', clientDataJSON));
    const verificationData = new Uint8Array(authData.length + clientDataHash.length);
    verificationData.set(authData, 0);
    verificationData.set(clientDataHash, authData.length);

    const sigBuf = await crypto.subtle.sign(
        { name: 'ECDSA', hash: { name: 'SHA-256' } },
        kp.privateKey,
        verificationData
    );

    const sig: WebAuthnSignature = {
        publicKey: publicKeyBytes,
        authData,
        clientDataJSON,
        signature: new Uint8Array(sigBuf),
    };

    return { sig, credentialId: 'test-credential-id', publicKeyBytes };
}

function computeDomainHash(message: Uint8Array): Promise<Uint8Array> {
    const domainBytes = new TextEncoder().encode('VEIL_SIGNED_MESSAGE_V1\n');
    const payload = new Uint8Array(domainBytes.length + message.length);
    payload.set(domainBytes, 0);
    payload.set(message, domainBytes.length);
    return crypto.subtle.digest('SHA-256', payload).then(b => new Uint8Array(b));
}

describe('signMessage()', () => {
    it('sign → verify success (full round-trip)', async () => {
        const message = new TextEncoder().encode('hello veil');
        const hash = await computeDomainHash(message);
        const { sig, credentialId } = await generateSignedWebAuthnSig(hash);

        const signed = await signMessage(message, jest.fn().mockResolvedValue(sig), credentialId);

        expect(signed.version).toBe(1);
        expect(signed.domain).toBe('VEIL_SIGNED_MESSAGE_V1');
        expect(signed.credentialId).toBe(credentialId);
        expect(signed.messageHash).toHaveLength(64);

        expect(await verifyMessage(message, signed)).toBe(true);
    });

    it('modified message → verify returns false', async () => {
        const message = new TextEncoder().encode('hello veil');
        const hash = await computeDomainHash(message);
        const { sig, credentialId } = await generateSignedWebAuthnSig(hash);
        const signed = await signMessage(message, jest.fn().mockResolvedValue(sig), credentialId);

        expect(await verifyMessage(new TextEncoder().encode('hello veil tampered'), signed)).toBe(false);
    });

    it('modified signature → verify returns false', async () => {
        const message = new TextEncoder().encode('hello veil');
        const hash = await computeDomainHash(message);
        const { sig, credentialId } = await generateSignedWebAuthnSig(hash);
        const signed = await signMessage(message, jest.fn().mockResolvedValue(sig), credentialId);

        const sigHex = signed.signature;
        const mutated = sigHex.slice(0, -2) + (sigHex.slice(-2) === 'ff' ? '00' : 'ff');
        const tampered: SignedMessage = { ...signed, signature: mutated };

        expect(await verifyMessage(message, tampered)).toBe(false);
    });

    it('credentialId check — expectedCredentialId mismatch returns false', async () => {
        const message = new TextEncoder().encode('hello veil');
        const hash = await computeDomainHash(message);
        const { sig, credentialId } = await generateSignedWebAuthnSig(hash);
        const signed = await signMessage(message, jest.fn().mockResolvedValue(sig), credentialId);

        // Without expectedCredentialId: passes (field is informational)
        expect(await verifyMessage(message, signed)).toBe(true);
        // Wrong expectedCredentialId: fails
        expect(await verifyMessage(message, signed, 'wrong-credential-id')).toBe(false);
        // Correct expectedCredentialId: passes
        expect(await verifyMessage(message, signed, credentialId)).toBe(true);
    });

    it('domain separation — signing "hello" and "VEIL_SIGNED_MESSAGE_V1\\nhello" produce different hashes', async () => {
        const domainBytes = new TextEncoder().encode('VEIL_SIGNED_MESSAGE_V1\n');
        const computeHash = async (msg: Uint8Array): Promise<string> => {
            const p = new Uint8Array(domainBytes.length + msg.length);
            p.set(domainBytes, 0);
            p.set(msg, domainBytes.length);
            return Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', p)))
                .map(b => b.toString(16).padStart(2, '0')).join('');
        };
        const h1 = await computeHash(new TextEncoder().encode('hello'));
        const h2 = await computeHash(new TextEncoder().encode('VEIL_SIGNED_MESSAGE_V1\nhello'));
        expect(h1).not.toBe(h2);
    });

    it('signAuthEntry returns null → throws', async () => {
        const message = new TextEncoder().encode('hi');
        await expect(
            signMessage(message, jest.fn().mockResolvedValue(null), 'cred-id')
        ).rejects.toThrow('signAuthEntry returned null');
    });

    it('webauthn.create type in clientDataJSON → verify returns false', async () => {
        const message = new TextEncoder().encode('hello veil');
        const hash = await computeDomainHash(message);
        const { sig, credentialId } = await generateSignedWebAuthnSig(hash);

        // Tamper with the clientDataJSON to use type: 'webauthn.create' (registration ceremony)
        const originalCDJ = JSON.parse(new TextDecoder().decode(sig.clientDataJSON));
        const tamperedCDJ = new TextEncoder().encode(
            JSON.stringify({ ...originalCDJ, type: 'webauthn.create' })
        );
        const tamperedSig = { ...sig, clientDataJSON: tamperedCDJ };

        const signed = await signMessage(message, jest.fn().mockResolvedValue(tamperedSig), credentialId);
        expect(await verifyMessage(message, signed)).toBe(false);
    });
});
