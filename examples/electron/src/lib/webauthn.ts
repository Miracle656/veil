import { Keypair } from '@stellar/stellar-sdk'

const salt = new TextEncoder().encode('veil:feepayer:salt:v1')
const info = new TextEncoder().encode('veil:feepayer:ed25519:v1')

export function base64urlToBytes(value: string) {
  const normalized = value.replace(/-/g, '+').replace(/_/g, '/')
  const binary = atob(normalized)
  const bytes = new Uint8Array(binary.length)
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index)
  }
  return bytes
}

export function bytesToHex(bytes: Uint8Array) {
  return Array.from(bytes, byte => byte.toString(16).padStart(2, '0')).join('')
}

export async function deriveFeePayerKeypair(credentialIdBase64url: string) {
  const credentialId = base64urlToBytes(credentialIdBase64url)
  const keyMaterial = await crypto.subtle.importKey('raw', credentialId, 'HKDF', false, ['deriveBits'])
  const derived = await crypto.subtle.deriveBits({ name: 'HKDF', hash: 'SHA-256', salt, info }, keyMaterial, 256)
  return Keypair.fromRawEd25519Seed(new Uint8Array(derived) as unknown as any)
}

export async function requirePasskeyAssertion(credentialIdBase64url: string, challenge: Uint8Array) {
  const assertion = await navigator.credentials.get({
    publicKey: {
      challenge: challenge as unknown as any,
      allowCredentials: [{ id: base64urlToBytes(credentialIdBase64url), type: 'public-key' }],
      userVerification: 'required',
    },
  } as any)

  if (!assertion) {
    throw new Error('Passkey verification was cancelled.')
  }

  return assertion
}
