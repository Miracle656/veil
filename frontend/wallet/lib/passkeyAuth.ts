/**
 * Prompt the user's registered passkey (Face ID / fingerprint / PIN) to
 * authorise a sensitive action. Throws if verification fails or is cancelled.
 */
export async function requirePasskey(): Promise<void> {
  const keyId = localStorage.getItem('invisible_wallet_key_id')
  if (!keyId) throw new Error('No passkey found. Please register the wallet first.')

  const credIdBin = atob(keyId.replace(/-/g, '+').replace(/_/g, '/'))
  const credId    = Uint8Array.from(credIdBin, c => c.charCodeAt(0))
  const challenge = crypto.getRandomValues(new Uint8Array(32))

  const assertion = await navigator.credentials.get({
    publicKey: {
      challenge,
      allowCredentials: [{ id: credId, type: 'public-key' }],
      userVerification: 'required',
      timeout: 60_000,
    },
  })

  if (!assertion) throw new Error('Passkey verification was cancelled.')
}

export async function registerNewPasskey(client: any) {
  const credential = await navigator.credentials.create({
    publicKey: {
      challenge: new Uint8Array(32),
      rp: { name: "Invisible Wallet", id: "localhost" },
      user: {
        id: new Uint8Array(16),
        name: "user@example.com",
        displayName: "User",
      },
      pubKeyCredParams: [{ type: "public-key", alg: -7 }],
      authenticatorSelection: {
        authenticatorAttachment: "platform",
        userVerification: "required",
      },
    },
  });

  if (!credential) throw new Error("Passkey creation failed");

  const cred = credential as PublicKeyCredential;

  const credentialId = new Uint8Array(cred.rawId);

  const publicKey = new Uint8Array(65);

  await client.add_signer(credentialId, publicKey);

  return credentialId;
}