import { Keypair, StrKey } from '@stellar/stellar-sdk';

import { isFederatedAddress, isValidDestination, isValidStellarAddress } from '../address';

// Real keys, so the checksum path is genuinely exercised rather than a
// prefix-and-length lookalike.
const ACCOUNT = Keypair.random().publicKey();
const CONTRACT = StrKey.encodeContract(Buffer.alloc(32, 7));
const MUXED = StrKey.encodeMed25519PublicKey(Buffer.alloc(40, 3));

describe('isValidStellarAddress', () => {
  it('accepts G, M and C addresses', () => {
    expect(isValidStellarAddress(ACCOUNT)).toBe(true);
    expect(isValidStellarAddress(MUXED)).toBe(true);
    expect(isValidStellarAddress(CONTRACT)).toBe(true);
  });

  it('rejects an address whose checksum is wrong', () => {
    // Flip the final character — right prefix, right length, bad checksum.
    const corrupted = ACCOUNT.slice(0, -1) + (ACCOUNT.endsWith('A') ? 'B' : 'A');
    expect(corrupted).toHaveLength(56);
    expect(isValidStellarAddress(corrupted)).toBe(false);
  });

  it('rejects secrets and junk', () => {
    expect(isValidStellarAddress(Keypair.random().secret())).toBe(false);
    expect(isValidStellarAddress('')).toBe(false);
    expect(isValidStellarAddress('GABC')).toBe(false);
  });
});

describe('isFederatedAddress', () => {
  it('accepts name*domain', () => {
    expect(isFederatedAddress('alice*veil.xyz')).toBe(true);
    expect(isFederatedAddress('a.b-c*sub.example.co.uk')).toBe(true);
  });

  it('requires exactly one separator and both halves', () => {
    expect(isFederatedAddress('alice')).toBe(false);
    expect(isFederatedAddress('*veil.xyz')).toBe(false);
    expect(isFederatedAddress('alice*')).toBe(false);
    expect(isFederatedAddress('a*b*c')).toBe(false);
  });

  it('requires a hostname-shaped domain with a TLD', () => {
    expect(isFederatedAddress('alice*localhost')).toBe(false);
    expect(isFederatedAddress('alice*veil.')).toBe(false);
    expect(isFederatedAddress('alice*-veil.xyz')).toBe(false);
  });
});

describe('isValidDestination', () => {
  it('accepts either form, ignoring surrounding whitespace', () => {
    expect(isValidDestination(`  ${ACCOUNT}  `)).toBe(true);
    expect(isValidDestination(' alice*veil.xyz ')).toBe(true);
  });

  it('rejects empty and malformed input', () => {
    expect(isValidDestination('')).toBe(false);
    expect(isValidDestination('   ')).toBe(false);
    expect(isValidDestination('not-an-address')).toBe(false);
  });
});
