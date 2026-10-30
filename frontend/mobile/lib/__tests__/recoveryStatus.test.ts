import { describe, expect, it } from '@jest/globals';
import { deriveRecoveryStatus } from '../recoveryStatus';

const wallet = { walletAddress: 'C123', signerSecret: 'S123' };
describe('deriveRecoveryStatus', () => {
  it('does not claim coverage before PRF is checked', () => {
    const status = deriveRecoveryStatus({
      ...wallet,
      prf: 'unverified',
      backupLastExportedAt: null,
      recoveryServerCount: 0,
    });
    expect(status.overall).toBe('none');
    expect(status.mechanisms[0]).toMatchObject({ ready: false, needsCheck: true });
    expect(status.mechanisms[0].action).toBe('Check passkey');
  });
  it('keeps cancelled and failed checks retryable', () => {
    for (const prf of ['cancelled', 'failed'] as const) {
      const status = deriveRecoveryStatus({
        ...wallet,
        prf,
        backupLastExportedAt: null,
        recoveryServerCount: 0,
      });
      expect(status.mechanisms[0]).toMatchObject({
        ready: false,
        needsCheck: true,
        action: 'Check passkey',
      });
    }
  });
  it('does not retry an unsupported passkey and offers the backup repair path', () => {
    const status = deriveRecoveryStatus({
      ...wallet,
      prf: 'unsupported',
      backupLastExportedAt: null,
      recoveryServerCount: 0,
    });
    expect(status.mechanisms[0]).toMatchObject({
      ready: false,
      needsCheck: false,
      action: 'Create an encrypted backup',
    });
    expect(status.mechanisms[0].detail).toContain('does not support PRF');
  });
  it('reports partial cover when only a backup exists', () => {
    const status = deriveRecoveryStatus({
      ...wallet,
      prf: 'missing',
      backupLastExportedAt: 123,
      recoveryServerCount: 0,
    });
    expect(status.summary).toBe('1 of 3 recovery mechanisms ready');
    expect(status.overall).toBe('partial');
  });
  it('requires all independent mechanisms for full coverage', () => {
    const status = deriveRecoveryStatus({
      ...wallet,
      prf: 'ready',
      backupLastExportedAt: 123,
      recoveryServerCount: 2,
    });
    expect(status.overall).toBe('full');
    expect(status.readyCount).toBe(3);
  });
  it('never reports coverage without a wallet signer', () => {
    const status = deriveRecoveryStatus({
      walletAddress: null,
      signerSecret: null,
      prf: 'ready',
      backupLastExportedAt: 123,
      recoveryServerCount: 2,
    });
    expect(status.readyCount).toBe(0);
    expect(status.overall).toBe('none');
  });
});

describe('after the screen has given up on the passkey', () => {
  // The screen replaces the prompt with a panel headed "Checking again won't
  // help" once two checks in a row have failed. This row went on saying "Try
  // again" beside it, so one screen gave two opposite instructions about the
  // same button.
  const failedTwice = {
    walletAddress: 'CWALLET',
    signerSecret: 'SSECRET',
    prf: 'failed' as const,
    backupLastExportedAt: null,
    recoveryServerCount: 0,
    prfFailedChecks: 2,
  };

  it('stops inviting a check it no longer believes in', () => {
    const prf = deriveRecoveryStatus(failedTwice).mechanisms[0];

    expect(prf.needsCheck).toBe(false);
    expect(prf.detail).not.toContain('Try again');
    expect(prf.action).toBe('Create an encrypted backup');
  });

  it('points at the thing that does not depend on the passkey', () => {
    const prf = deriveRecoveryStatus(failedTwice).mechanisms[0];

    expect(prf.detail).toContain('encrypted backup');
  });

  it('still offers one retry after a single failure', () => {
    // One failure is not a verdict — a cancelled prompt or a flaky read gets
    // another go, which is the case the original wording was written for.
    const prf = deriveRecoveryStatus({ ...failedTwice, prfFailedChecks: 1 }).mechanisms[0];

    expect(prf.needsCheck).toBe(true);
    expect(prf.detail).toContain('Try again');
    expect(prf.action).toBe('Check passkey');
  });

  it('is unchanged when the caller does not count failures', () => {
    const { prfFailedChecks: _omitted, ...withoutCount } = failedTwice;
    const prf = deriveRecoveryStatus(withoutCount).mechanisms[0];

    expect(prf.needsCheck).toBe(true);
    expect(prf.detail).toContain('Try again');
  });
});
