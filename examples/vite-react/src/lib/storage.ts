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
  sessionStorage.setItem(storageKeys.walletAddress, walletAddress)
  sessionStorage.setItem(storageKeys.signerSecret, signerSecret)
}

export function readWalletAddress() {
  return sessionStorage.getItem(storageKeys.walletAddress) ?? localStorage.getItem(storageKeys.walletAddress)
}

export function readSignerSecret() {
  return sessionStorage.getItem(storageKeys.signerSecret) ?? localStorage.getItem(storageKeys.signerSecret)
}

export function readSignerPublicKey() {
  return localStorage.getItem(storageKeys.signerPublicKey)
}

export function readCredentialId() {
  return localStorage.getItem(storageKeys.credentialId)
}

export function readPublicKey() {
  return localStorage.getItem(storageKeys.publicKey)
}
