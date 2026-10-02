export const storageKeys = {
  walletAddress: 'invisible_wallet_address',
  credentialId: 'invisible_wallet_key_id',
  publicKey: 'invisible_wallet_public_key',
  signerSecret: 'veil_signer_secret',
  signerPublicKey: 'veil_signer_public_key',
} as const

export function persistSession(walletAddress: string, signerSecret: string, signerPublicKey: string) {
  localStorage.setItem(storageKeys.walletAddress, walletAddress)
  localStorage.setItem(storageKeys.signerSecret, signerSecret)
  localStorage.setItem(storageKeys.signerPublicKey, signerPublicKey)
}

export function readWalletAddress() {
  return localStorage.getItem(storageKeys.walletAddress)
}

export function readSignerSecret() {
  return localStorage.getItem(storageKeys.signerSecret)
}

export function readSignerPublicKey() {
  return localStorage.getItem(storageKeys.signerPublicKey)
}

export function readCredentialId() {
  return localStorage.getItem(storageKeys.credentialId)
}
