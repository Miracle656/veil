/**
 * API Surface Snapshot Test
 * 
 * This test captures the public API surface of the SDK to prevent accidental
 * breaking changes. When exports are added, renamed, or removed, this test
 * will fail and show a diff in the snapshot.
 */

import * as sdk from '../index';
import * as vanillaSdk from '../vanilla';

describe('SDK API Surface', () => {
  it('should match the snapshot for main SDK exports', () => {
    const apiSurface = Object.keys(sdk).sort().map(key => {
      const value = sdk[key as keyof typeof sdk];
      const type = typeof value;
      
      let signature = `${key}: ${type}`;
      
      // For functions, capture arity (number of parameters)
      if (type === 'function') {
        signature = `${key}: function(arity: ${value.length})`;
      }
      
      return signature;
    });

    expect(apiSurface).toMatchSnapshot();
  });

  it('should match the snapshot for vanilla SDK exports', () => {
    const apiSurface = Object.keys(vanillaSdk).sort().map(key => {
      const value = vanillaSdk[key as keyof typeof vanillaSdk];
      const type = typeof value;
      
      let signature = `${key}: ${type}`;
      
      // For functions, capture arity
      if (type === 'function') {
        signature = `${key}: function(arity: ${value.length})`;
      }
      
      // For classes, capture constructor arity
      if (type === 'function' && value.prototype && value.prototype.constructor) {
        signature = `${key}: class(constructor arity: ${value.length})`;
      }
      
      return signature;
    });

    expect(apiSurface).toMatchSnapshot();
  });

  it('should export expected core functions from main SDK', () => {
    // Verify critical exports exist
    expect(sdk).toHaveProperty('useInvisibleWallet');
    expect(typeof sdk.useInvisibleWallet).toBe('function');
  });

  it('should export expected core items from vanilla SDK', () => {
    // Verify critical exports exist
    expect(vanillaSdk).toHaveProperty('InvisibleWallet');
    expect(vanillaSdk).toHaveProperty('createInvisibleWallet');
    expect(typeof vanillaSdk.createInvisibleWallet).toBe('function');
  });

  it('should export utility functions', () => {
    expect(sdk).toHaveProperty('bufferToHex');
    expect(sdk).toHaveProperty('hexToUint8Array');
    expect(sdk).toHaveProperty('computeWalletAddress');
    expect(typeof sdk.bufferToHex).toBe('function');
    expect(typeof sdk.hexToUint8Array).toBe('function');
    expect(typeof sdk.computeWalletAddress).toBe('function');
  });
});
