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

export function hexToBytes(value: string) {
  const bytes = new Uint8Array(value.length / 2)
  for (let index = 0; index < value.length; index += 2) {
    bytes[index / 2] = Number.parseInt(value.slice(index, index + 2), 16)
  }
  return bytes
}

export function bytesToBase64url(bytes: Uint8Array) {
  let binary = ''
  for (const byte of bytes) {
    binary += String.fromCharCode(byte)
  }
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '')
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
      // cast challenge to any to avoid DOM/Buffer type mismatches in TS for this example
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
