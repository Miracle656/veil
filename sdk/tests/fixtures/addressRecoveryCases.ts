export const ADDRESS_RECOVERY_CASES = [
  { name: 'valid registered signer', address: 'CA3D5KRYM6CB7OWQ6TWYRR3Z4T7GNZLKERYNZGGA5SOAOPIFY6YQGAXE', resolution: 'signers', authentication: 'registered', expected: 'accepted' },
  { name: 'malformed address', address: 'C123', resolution: 'signers', authentication: 'registered', expected: 'InvalidWalletAddressError' },
  { name: 'bad StrKey checksum', address: `C${'B'.repeat(55)}`, resolution: 'signers', authentication: 'registered', expected: 'InvalidWalletAddressError' },
  { name: 'undeployed wallet', address: 'CA3D5KRYM6CB7OWQ6TWYRR3Z4T7GNZLKERYNZGGA5SOAOPIFY6YQGAXE', resolution: 'not-found', authentication: 'registered', expected: 'WalletContractNotFoundError' },
  { name: 'unreachable network', address: 'CA3D5KRYM6CB7OWQ6TWYRR3Z4T7GNZLKERYNZGGA5SOAOPIFY6YQGAXE', resolution: 'network-error', authentication: 'registered', expected: 'WalletRecoveryNetworkError' },
  { name: 'passkey is not registered', address: 'CA3D5KRYM6CB7OWQ6TWYRR3Z4T7GNZLKERYNZGGA5SOAOPIFY6YQGAXE', resolution: 'signers', authentication: 'unregistered', expected: 'PasskeyNotRegisteredError' },
  { name: 'deployed non-wallet contract', address: 'CA3D5KRYM6CB7OWQ6TWYRR3Z4T7GNZLKERYNZGGA5SOAOPIFY6YQGAXE', resolution: 'empty', authentication: 'registered', expected: 'NotVeilWalletError' },
] as const;