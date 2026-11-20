import { Keypair, StrKey } from '@stellar/stellar-sdk';

import {
  baseAddress,
  isFederatedAddress,
  isMuxedContractAddress,
  isValidDestination,
  isValidStellarAddress,
} from '../address';

// Real keys, so the checksum path is genuinely exercised rather than a
// prefix-and-length lookalike.
const ACCOUNT = Keypair.random().publicKey();
const CONTRACT = StrKey.encodeContract(Buffer.alloc(32, 7));
const MUXED = StrKey.encodeMed25519PublicKey(Buffer.alloc(40, 3));
const MUXED_CONTRACT = StrKey.encodeMuxedContract(
  Buffer.concat([StrKey.decodeContract(CONTRACT), Buffer.from('0000000000000005', 'hex')]),
);

describe('isValidStellarAddress', () => {
  it('accepts G, M, C and W addresses', () => {
    expect(isValidStellarAddress(ACCOUNT)).toBe(true);
    expect(isValidStellarAddress(MUXED)).toBe(true);
    expect(isValidStellarAddress(CONTRACT)).toBe(true);
    expect(isValidStellarAddress(MUXED_CONTRACT)).toBe(true);
  });

  it('identifies a muxed contract and derives its base C address without slicing', () => {
    expect(isMuxedContractAddress(MUXED_CONTRACT)).toBe(true);
    expect(isMuxedContractAddress(CONTRACT)).toBe(false);
    expect(baseAddress(MUXED_CONTRACT)).toBe(CONTRACT);
    expect(baseAddress(CONTRACT)).toBe(CONTRACT);
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
