import { Networks } from '@stellar/stellar-sdk';

import { assertEncodable, assertRoundTrips, simulationErrorMessage } from '../simulationError';

/** A real, well-formed mainnet envelope. */
const VALID_XDR =
  'AAAAAgAAAABXFTQOYaUlYJCKn4kJNsTYwPgKgqr2YhXwc6/G8NO0AAPQkAD1MQAAAAEAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=';

describe('assertEncodable', () => {
  it('rejects an envelope the device never produced', () => {
    expect(() => assertEncodable('', 'Swap')).toThrow(/did not encode on this device/);
    expect(() => assertEncodable('', 'Swap')).toThrow(/empty/);
  });

  it('names the flow, so the message says where it came from', () => {
    expect(() => assertEncodable('AAAA', 'Smart-wallet transaction')).toThrow(
      /^Smart-wallet transaction:/,
    );
  });

  it('says the failure was local rather than the network refusing it', () => {
    expect(() => assertEncodable('AAAA', 'Swap')).toThrow(/before the network, not on it/);
  });
});

describe('assertRoundTrips', () => {
  it('rejects a plausible-length string that is not a transaction', () => {
    // The case a length check cannot see: right size, undecodable bytes — what a
    // broken base64 polyfill produces, and what the RPC blames itself for.
    const plausible = 'A'.repeat(400);
    expect(() => assertRoundTrips(plausible, Networks.PUBLIC, 'Swap')).toThrow(
      /cannot read back|does not survive a round trip/,
    );
  });

  it('blames the device, not the network', () => {
    expect(() => assertRoundTrips('B'.repeat(400), Networks.PUBLIC, 'Swap')).toThrow(
      /Base64 encoding is (broken|unreliable) in this build/,
    );
  });

  it('still catches an empty envelope', () => {
    expect(() => assertRoundTrips('', Networks.PUBLIC, 'Swap')).toThrow(/did not encode/);
  });
});

describe('simulationErrorMessage', () => {
  const base = {
    error: 'Could not unmarshal transaction',
    flow: 'Smart-wallet transaction',
    network: 'mainnet',
    xdrLength: 348,
  };

  it('carries the flow, network, host and envelope size', () => {
    const message = simulationErrorMessage({
      ...base,
      rpcUrl: 'https://example.stellar-mainnet.quiknode.pro/abc123secret/',
    });

    expect(message).toContain('Smart-wallet transaction');
    expect(message).toContain('Could not unmarshal transaction');
    expect(message).toContain('mainnet');
    expect(message).toContain('example.stellar-mainnet.quiknode.pro');
    expect(message).toContain('348');
  });

  it('does not leak the API token in the RPC path', () => {
    const message = simulationErrorMessage({
      ...base,
      rpcUrl: 'https://example.quiknode.pro/abc123secret/',
    });
    expect(message).not.toContain('abc123secret');
  });

  it('says so plainly when no RPC is configured', () => {
    expect(simulationErrorMessage({ ...base, rpcUrl: '' })).toContain('no RPC URL configured');
  });
});
