/**
 * Property-Based Tests for Stellar Address Parser
 * 
 * Uses fast-check to generate valid and invalid Stellar addresses (G... and C... strkeys)
 * and verify that the parser correctly validates and round-trips them.
 */

import * as fc from 'fast-check';
import { StrKey } from '@stellar/stellar-sdk';

describe('Stellar Address Parser - Property-Based Tests', () => {
  describe('Valid G... (account) addresses', () => {
    it('should round-trip 1000 valid G addresses', () => {
      fc.assert(
        fc.property(
          // Generate 32 random bytes for a valid public key
          fc.uint8Array({ minLength: 32, maxLength: 32 }),
          (publicKeyBytes) => {
            // Encode as a Stellar account address (G...)
            const encoded = StrKey.encodeEd25519PublicKey(Buffer.from(publicKeyBytes));
            
            // Verify it starts with G
            expect(encoded[0]).toBe('G');
            
            // Verify it's valid
            expect(StrKey.isValidEd25519PublicKey(encoded)).toBe(true);
            
            // Verify round-trip
            const decoded = StrKey.decodeEd25519PublicKey(encoded);
            expect(Buffer.from(decoded)).toEqual(Buffer.from(publicKeyBytes));
          }
        ),
        { numRuns: 1000 }
      );
    });
  });

  describe('Valid C... (contract) addresses', () => {
    it('should round-trip 1000 valid C addresses', () => {
      fc.assert(
        fc.property(
          // Generate 32 random bytes for a valid contract hash
          fc.uint8Array({ minLength: 32, maxLength: 32 }),
          (contractHashBytes) => {
            // Encode as a Stellar contract address (C...)
            const encoded = StrKey.encodeContract(Buffer.from(contractHashBytes));
            
            // Verify it starts with C
            expect(encoded[0]).toBe('C');
            
            // Verify it's valid
            expect(StrKey.isValidContract(encoded)).toBe(true);
            
            // Verify round-trip
            const decoded = StrKey.decodeContract(encoded);
            expect(Buffer.from(decoded)).toEqual(Buffer.from(contractHashBytes));
          }
        ),
        { numRuns: 1000 }
      );
    });
  });

  describe('Invalid addresses - corrupted checksums', () => {
    it('should reject 1000 addresses with corrupted checksums', () => {
      fc.assert(
        fc.property(
          fc.uint8Array({ minLength: 32, maxLength: 32 }),
          fc.integer({ min: 0, max: 55 }), // Position to corrupt
          (publicKeyBytes, corruptPosition) => {
            // Generate a valid address
            const validAddress = StrKey.encodeEd25519PublicKey(Buffer.from(publicKeyBytes));
            
            // Corrupt a character (flip a bit in the base32 encoding)
            const chars = validAddress.split('');
            const originalChar = chars[corruptPosition];
            
            // Replace with a different valid base32 character
            const base32Chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
            const newChar = base32Chars[(base32Chars.indexOf(originalChar) + 1) % base32Chars.length];
            chars[corruptPosition] = newChar;
            const corruptedAddress = chars.join('');
            
            // Skip if we accidentally didn't change anything
            if (corruptedAddress === validAddress) return true;
            
            // Verify the corrupted address is rejected
            expect(StrKey.isValidEd25519PublicKey(corruptedAddress)).toBe(false);
          }
        ),
        { numRuns: 1000 }
      );
    });
  });

  describe('Invalid addresses - wrong length', () => {
    it('should reject addresses that are too short', () => {
      fc.assert(
        fc.property(
          fc.uint8Array({ minLength: 1, maxLength: 31 }), // Too short
          (shortBytes) => {
            // Attempt to encode will fail or produce invalid address
            try {
              const encoded = StrKey.encodeEd25519PublicKey(Buffer.from(shortBytes));
              // If encoding somehow succeeds, validation should fail
              expect(StrKey.isValidEd25519PublicKey(encoded)).toBe(false);
            } catch (error) {
              // Expected to throw for invalid length
              expect(error).toBeDefined();
            }
          }
        ),
        { numRuns: 1000 }
      );
    });

    it('should reject addresses that are too long', () => {
      fc.assert(
        fc.property(
          fc.uint8Array({ minLength: 33, maxLength: 64 }), // Too long
          (longBytes) => {
            // Attempt to encode will fail or produce invalid address
            try {
              const encoded = StrKey.encodeEd25519PublicKey(Buffer.from(longBytes));
              // If encoding somehow succeeds, validation should fail
              expect(StrKey.isValidEd25519PublicKey(encoded)).toBe(false);
            } catch (error) {
              // Expected to throw for invalid length
              expect(error).toBeDefined();
            }
          }
        ),
        { numRuns: 1000 }
      );
    });
  });

  describe('Invalid addresses - wrong prefix', () => {
    it('should reject addresses with wrong prefix', () => {
      fc.assert(
        fc.property(
          fc.uint8Array({ minLength: 32, maxLength: 32 }),
          (publicKeyBytes) => {
            // Generate a valid G address
            const validGAddress = StrKey.encodeEd25519PublicKey(Buffer.from(publicKeyBytes));
            
            // Try to validate it as a contract address (should fail)
            expect(StrKey.isValidContract(validGAddress)).toBe(false);
            
            // Generate a valid C address
            const validCAddress = StrKey.encodeContract(Buffer.from(publicKeyBytes));
            
            // Try to validate it as an account address (should fail)
            expect(StrKey.isValidEd25519PublicKey(validCAddress)).toBe(false);
          }
        ),
        { numRuns: 1000 }
      );
    });
  });

  describe('Invalid addresses - invalid base32 characters', () => {
    it('should reject addresses with invalid characters', () => {
      fc.assert(
        fc.property(
          fc.uint8Array({ minLength: 32, maxLength: 32 }),
          fc.integer({ min: 1, max: 55 }), // Position to corrupt (skip first char to keep prefix)
          (publicKeyBytes, position) => {
            // Generate a valid address
            const validAddress = StrKey.encodeEd25519PublicKey(Buffer.from(publicKeyBytes));
            
            // Insert an invalid base32 character (0, 1, 8, 9 are not in base32 alphabet)
            const chars = validAddress.split('');
            chars[position] = ['0', '1', '8', '9', '!', '@', '#'][position % 7];
            const invalidAddress = chars.join('');
            
            // Verify the address is rejected
            expect(StrKey.isValidEd25519PublicKey(invalidAddress)).toBe(false);
          }
        ),
        { numRuns: 1000 }
      );
    });
  });

  describe('Edge cases', () => {
    it('should handle empty strings', () => {
      expect(StrKey.isValidEd25519PublicKey('')).toBe(false);
      expect(StrKey.isValidContract('')).toBe(false);
    });

    it('should handle null/undefined gracefully', () => {
      expect(() => StrKey.isValidEd25519PublicKey(null as any)).not.toThrow();
      expect(() => StrKey.isValidEd25519PublicKey(undefined as any)).not.toThrow();
    });

    it('should handle very long strings', () => {
      const veryLongString = 'G' + 'A'.repeat(1000);
      expect(StrKey.isValidEd25519PublicKey(veryLongString)).toBe(false);
    });
  });
});
