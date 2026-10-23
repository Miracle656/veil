import { describe, expect, it } from '@jest/globals';
import { deriveRecoveryStatus, prfStateFromSource } from '../recoveryStatus';

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

  // #1178 — the recorded fee-payer source answers "is this wallet PRF-backed?"
  // without prompting, and each answer speaks in consequences.

  it('answers PRF-backed from the creation record without a prompt', () => {
    const status = deriveRecoveryStatus({
      ...wallet,
      prf: prfStateFromSource('prf'),
      backupLastExportedAt: null,
      recoveryServerCount: 0,
    });
    expect(status.mechanisms[0]).toMatchObject({ ready: true, needsCheck: false });
    expect(status.mechanisms[0].detail).toContain('passkey alone restores this wallet');
  });

  it('says what a recorded random fee payer means and offers the in-place repair', () => {
    const status = deriveRecoveryStatus({
      ...wallet,
      prf: prfStateFromSource('random'),
      backupLastExportedAt: null,
      recoveryServerCount: 0,
    });
    expect(status.mechanisms[0]).toMatchObject({
      ready: false,
      needsCheck: true,
      action: 'Repair with passkey',
    });
    // Consequences, not mechanism: what fails, what keeps working, the way out.
    expect(status.mechanisms[0].detail).toContain('cannot restore it on another device');
    expect(status.mechanisms[0].detail).toContain('keeps working');
    expect(status.mechanisms[0].detail).toContain('while the fee payer is still unfunded');
  });

  it('counts a legacy credential-id wallet as recoverable, with the caution spelled out', () => {
    const status = deriveRecoveryStatus({
      ...wallet,
      prf: prfStateFromSource('credential-id'),
      backupLastExportedAt: null,
      recoveryServerCount: 0,
    });
    expect(status.mechanisms[0]).toMatchObject({ ready: true, needsCheck: false });
    expect(status.mechanisms[0].detail).toContain('credential ID');
    expect(status.mechanisms[0].detail).toContain('fee money');
  });

  it('gives a keypair-mode wallet no passkey path and points at the backup', () => {
    const status = deriveRecoveryStatus({
      ...wallet,
      prf: prfStateFromSource('keypair'),
      backupLastExportedAt: null,
      recoveryServerCount: 0,
    });
    expect(status.mechanisms[0]).toMatchObject({
      ready: false,
      needsCheck: false,
      action: 'Create an encrypted backup',
    });
    expect(status.mechanisms[0].detail).toContain('no passkey to recover from');
  });

  it('explains a funded, unrepairable fee payer in consequences', () => {
    const status = deriveRecoveryStatus({
      ...wallet,
      prf: 'funded',
      backupLastExportedAt: null,
      recoveryServerCount: 0,
    });
    expect(status.mechanisms[0]).toMatchObject({
      ready: false,
      needsCheck: false,
      action: 'Create an encrypted backup',
    });
    expect(status.mechanisms[0].detail).toContain('cannot be repaired in place');
  });

  it('leaves an unrecorded wallet on the one-prompt check', () => {
    for (const source of ['unknown', null, undefined] as const) {
      expect(prfStateFromSource(source)).toBe('unverified');
    }
    expect(prfStateFromSource('prf')).toBe('ready');
    expect(prfStateFromSource('random')).toBe('random');
    expect(prfStateFromSource('credential-id')).toBe('legacy');
    expect(prfStateFromSource('keypair')).toBe('keypair');
  });
});
