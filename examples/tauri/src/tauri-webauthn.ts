import { invoke } from '@tauri-apps/api/core'
import { authenticate, checkStatus } from '@tauri-apps/plugin-biometric'
import { webAuthnProvider, type WebAuthnProvider } from '../../../sdk/src/webauthn.js'

const BASE64URL = {
  encode(bytes: Uint8Array) {
    let str = ''
    for (const byte of bytes) {
      str += String.fromCharCode(byte)
    }
    return btoa(str).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
  },
  decode(input: string) {
    const padded = input + '='.repeat((4 - (input.length % 4)) % 4)
    const binary = atob(padded.replace(/-/g, '+').replace(/_/g, '/'))
    const bytes = new Uint8Array(binary.length)
    for (let i = 0; i < binary.length; i++) {
      bytes[i] = binary.charCodeAt(i)
    }
    return bytes
  },
}

function mapBiometricError(error: unknown): string {
  if (error instanceof Error) {
    const lower = error.message.toLowerCase()
    if (lower.includes('usercancel') || lower.includes('user cancel') || lower.includes('cancelled')) {
      return 'Biometric authentication was cancelled by the user.'
    }
    if (lower.includes('not enrolled') || lower.includes('no enrolled') || lower.includes('biometrynotenrolled')) {
      return 'No biometric credentials are enrolled on this device.'
    }
    if (lower.includes('notsupported') || lower.includes('not available') || lower.includes('biometrynotavailable')) {
      return 'Biometric authentication is not available on this device.'
    }
  }
  return error instanceof Error ? error.message : String(error)
}

async function ensureBiometricAvailable() {
  const status = await checkStatus()
  if (!status.isAvailable) {
    throw new Error(status.error || 'Biometric authentication is unavailable on this device.')
  }
  return status
}

async function authenticateUser(reason: string) {
  await ensureBiometricAvailable()
  try {
    await authenticate(reason)
  } catch (err) {
    throw new Error(mapBiometricError(err))
  }
}

export async function patchWebAuthnProvider() {
  if (typeof window === 'undefined' || !(window as any).__TAURI__) {
    return
  }

  const origin = import.meta.env.VITE_ORIGIN || window.location.origin || 'https://localhost'

  const tauriProvider: WebAuthnProvider = {
    async create(options: Parameters<WebAuthnProvider['create']>[0]) {
      const { challenge, rpId, rpName, userId, userName } = options
      await authenticateUser('Register your Veil passkey')
      const response = await invoke('register_passkey', {
        rpId,
        rpName,
        userId: BASE64URL.encode(new Uint8Array(userId)),
        userName,
        challenge: BASE64URL.encode(new Uint8Array(challenge)),
      }) as { credentialId: string; publicKeyBytes: string }

      return {
        credentialId: response.credentialId,
        publicKeyBytes: BASE64URL.decode(response.publicKeyBytes),
      }
    },

    async authenticate(options: Parameters<WebAuthnProvider['authenticate']>[0]) {
      const { challenge, credentialId, rpId } = options
      await authenticateUser('Unlock your Veil passkey')
      const response = await invoke('sign_with_passkey', {
        credentialId,
        challenge: BASE64URL.encode(new Uint8Array(challenge)),
        rpId,
        origin,
      }) as {
        authData: string
        clientDataJSON: string
        signature: string
      }

      return {
        authData: BASE64URL.decode(response.authData),
        clientDataJSON: BASE64URL.decode(response.clientDataJSON),
        signature: BASE64URL.decode(response.signature),
      }
    },
  }

  webAuthnProvider.create = tauriProvider.create
  webAuthnProvider.authenticate = tauriProvider.authenticate
}
