import { prfFromAssertion, prfFromError } from '../prfOutcome';

describe('prfFromAssertion', () => {
  it('accepts a 32-byte output', () => {
    const out = new Uint8Array(32).fill(1);
    expect(prfFromAssertion(true, out)).toEqual({ output: out, outcome: 'ok' });
  });

  it('calls an answer without PRF what it is: an unsupported password manager', () => {
    // The user completed the prompt; retrying would ask again for the same nothing.
    expect(prfFromAssertion(true, null).outcome).toBe('unsupported');
    expect(prfFromAssertion(true, new Uint8Array(8)).outcome).toBe('unsupported');
  });

  it('treats no assertion at all as a closed prompt', () => {
    expect(prfFromAssertion(false, null).outcome).toBe('cancelled');
  });
});

describe('prfFromError', () => {
  it('recognises the user closing the prompt', () => {
    expect(prfFromError(new Error('The operation was cancelled by the user')).outcome).toBe('cancelled');
  });

  it('keeps the reason for anything else', () => {
    const result = prfFromError(new Error('Credential Manager unavailable'));
    expect(result.outcome).toBe('failed');
    expect(result.detail).toContain('Credential Manager unavailable');
  });
});
