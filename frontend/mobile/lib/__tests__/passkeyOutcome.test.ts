/**
 * #1183 — the classifier behind every spend screen's passkey handling.
 *
 * Cancellation, an authenticator refusal and a genuine failure must not be
 * interchangeable: the first is a decision, the second has a specific next
 * step, and only the third is an error.
 */

import {
  CREDENTIAL_ORPHANED_MESSAGE,
  PASSKEY_CANCELLED_MESSAGE,
  PASSKEY_UNSUPPORTED_MESSAGE,
  PasskeyCeremonyError,
  classifyPasskeyError,
  isPasskeyCancellation,
  passkeyFailureMessage,
  toPasskeyCeremonyError,
} from '../passkeyOutcome';

describe('isPasskeyCancellation', () => {
  it.each([
    new Error('NotAllowedError: the request was denied'),
    { message: 'The operation was cancelled by the user' },
    { error: 'UserCancelled' },
    // A timeout is a cancellation only when the ceremony says so by NAME.
    new DOMException('The operation either timed out or was not allowed.', 'NotAllowedError'),
    new Error('AbortError: the sheet was dismissed'),
  ])('treats a dismissal or the ceremony own timeout as cancellation: %p', (error) => {
    expect(isPasskeyCancellation(error)).toBe(true);
    expect(classifyPasskeyError(error)).toBe('cancelled');
  });

  it('does not treat a refusal as a cancellation', () => {
    expect(isPasskeyCancellation(new Error('This device does not support passkeys'))).toBe(false);
  });

  /**
   * Money safety: a submission that times out is not a decline. The screen used
   * to return to the form with no error, after the transaction may already have
   * been sent, because the text contained "timeout".
   */
  it.each([
    new Error('timeout of 30000ms exceeded'),
    new Error('request timed out'),
    new Error('Horizon request timed out after 30s'),
  ])('never reads a non-ceremony timeout as a cancellation: %p', (error) => {
    expect(isPasskeyCancellation(error)).toBe(false);
    expect(classifyPasskeyError(error)).toBe('failed');
  });

  it('classifies an axios timeout as a failure and says nothing was sent', () => {
    const error = new Error('timeout of 30000ms exceeded');
    expect(isPasskeyCancellation(error)).toBe(false);
    expect(classifyPasskeyError(error)).toBe('failed');
    expect(passkeyFailureMessage(error)).toMatch(/timeout of 30000ms exceeded/);
    expect(passkeyFailureMessage(error)).toMatch(/Nothing was sent/);
  });

  it('keeps a NotAllowedError raised by the passkey call as a cancellation', () => {
    const error = new DOMException(
      'The operation either timed out or was not allowed. See: https://www.w3.org/TR/webauthn-2/',
      'NotAllowedError',
    );
    expect(isPasskeyCancellation(error)).toBe(true);
    expect(classifyPasskeyError(error)).toBe('cancelled');
  });
});

describe('toPasskeyCeremonyError', () => {
  it('keeps cancellation calm and carries the outcome', () => {
    const error = toPasskeyCeremonyError(new Error('NotAllowedError'));
    expect(error.outcome).toBe('cancelled');
    expect(error.message).toBe(PASSKEY_CANCELLED_MESSAGE);
    expect(passkeyFailureMessage(error)).toBeNull();
  });

  it('explains an unsupported authenticator and offers a different device', () => {
    const error = toPasskeyCeremonyError(new Error('This browser does not support passkeys'));
    expect(error.outcome).toBe('refused');
    expect(error.message).toBe(PASSKEY_UNSUPPORTED_MESSAGE);
    expect(error.message).toMatch(/different device/i);
  });

  it('names an orphaned credential instead of blaming the user', () => {
    const error = toPasskeyCeremonyError(
      new Error('No credentials found for relying party app.useveilapp.xyz'),
    );
    expect(error.outcome).toBe('refused');
    expect(error.message).toBe(CREDENTIAL_ORPHANED_MESSAGE);
    expect(error.message).toMatch(/earlier Veil domain/i);
  });

  it('preserves a genuinely failed ceremony and says nothing was sent', () => {
    const error = toPasskeyCeremonyError(new Error('The signing request was interrupted'));
    expect(error.outcome).toBe('failed');
    expect(error.message).toMatch(/interrupted/);
    expect(error.message).toMatch(/Nothing was sent/);
  });

  it('does not rewrap an error that already carries its outcome', () => {
    const original = new PasskeyCeremonyError('refused', 'Try a different device.');
    expect(toPasskeyCeremonyError(original)).toBe(original);
  });
});
