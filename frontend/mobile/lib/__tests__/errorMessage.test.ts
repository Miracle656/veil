import { errorMessage } from '../errorMessage';
import { isUserRejection } from '../walletConnectHelpers';

describe('errorMessage', () => {
  it('never returns [object Object] for a plain object', () => {
    // The regression this file exists for: react-native-passkeys rejects with
    // an object, and String({}) is the text a user actually saw on the
    // create-wallet screen after cancelling the passkey prompt.
    const thrown = { error: 'UserCancelled' };

    expect(String(thrown)).toBe('[object Object]');
    expect(errorMessage(thrown)).not.toContain('[object Object]');
    expect(errorMessage(thrown)).toBe('UserCancelled');
  });

  it('prefers an Error message', () => {
    expect(errorMessage(new Error('boom'))).toBe('boom');
  });

  it('takes a string as-is', () => {
    expect(errorMessage('plain failure')).toBe('plain failure');
  });

  it('reads message before other keys', () => {
    expect(errorMessage({ message: 'the message', code: 'E_CODE' })).toBe('the message');
  });

  it('unwraps a nested error object', () => {
    expect(errorMessage({ error: { message: 'inner detail' } })).toBe('inner detail');
  });

  it('falls back to a code when there is no prose', () => {
    expect(errorMessage({ code: 'E_NO_CREDENTIALS' })).toBe('E_NO_CREDENTIALS');
  });

  it('shows the fields rather than [object Object] for an unrecognised shape', () => {
    const out = errorMessage({ status: 418, teapot: true });
    expect(out).not.toContain('[object Object]');
    expect(out).toContain('418');
  });

  it('survives a cyclic object', () => {
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;

    expect(() => errorMessage(cyclic)).not.toThrow();
    expect(errorMessage(cyclic)).not.toContain('[object Object]');
  });

  it('gives a usable sentence for null and undefined', () => {
    expect(errorMessage(null)).toMatch(/went wrong/i);
    expect(errorMessage(undefined)).toMatch(/went wrong/i);
  });
});

describe('isUserRejection with object-shaped rejections', () => {
  it('detects a cancellation delivered as a plain object', () => {
    // Before errorMessage, this stringified to "[object Object]", matched no
    // cancellation marker, and a deliberate cancel was reported as an error.
    expect(isUserRejection({ message: 'The operation was cancelled by the user' })).toBe(true);
    expect(isUserRejection({ error: 'NotAllowedError' })).toBe(true);
    expect(isUserRejection({ code: 'USER_REJECTED' })).toBe(true);
  });

  it('still detects the Error and string forms', () => {
    expect(isUserRejection(new Error('NotAllowedError'))).toBe(true);
    expect(isUserRejection('USER_REJECTED')).toBe(true);
  });

  it('does not mistake an unrelated failure for a cancellation', () => {
    expect(isUserRejection(new Error('network request failed'))).toBe(false);
    expect(isUserRejection({ message: 'insufficient balance' })).toBe(false);
  });
});
