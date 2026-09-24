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
