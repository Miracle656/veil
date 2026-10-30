import type { PrfOutcome } from './prfOutcome';

export type PrfRecoveryState =
  'unverified' | 'ready' | 'missing' | 'funded' | Exclude<PrfOutcome, 'ok'>;
export type RecoveryStatusInput = {
  walletAddress: string | null;
  signerSecret: string | null;
  prf: PrfRecoveryState;
  backupLastExportedAt: number | null;
  recoveryServerCount: number;
  /**
   * Consecutive failed passkey checks this session.
   *
   * The screen already stops asking after two — it replaces the prompt with
   * a panel saying checking again will not help. This row did not know that
   * and kept saying "Try again" beside it, so the same screen gave two
   * opposite instructions about the same button.
   */
  prfFailedChecks?: number;
};
export type RecoveryMechanism = {
  key: 'prf' | 'backup' | 'servers';
  label: string;
  ready: boolean;
  needsCheck?: boolean;
  action: string;
  detail?: string;
};
export type RecoveryStatus = {
  mechanisms: RecoveryMechanism[];
  readyCount: number;
  overall: 'none' | 'partial' | 'full';
  summary: string;
};

/** Derive the honest recovery summary without prompting the authenticator. */
export function deriveRecoveryStatus(input: RecoveryStatusInput): RecoveryStatus {
  const hasWallet = !!input.walletAddress && !!input.signerSecret;
  // Two failures in a row is the screen's own threshold for giving up on the
  // passkey, so past it this stops offering a check it does not believe in.
  const exhausted = (input.prfFailedChecks ?? 0) >= 2;
  const needsPrfCheck =
    !exhausted &&
    (input.prf === 'unverified' || input.prf === 'cancelled' || input.prf === 'failed');
  const mechanisms: RecoveryMechanism[] = [
    {
      key: 'prf',
      label: 'Passkey recovery',
      ready: hasWallet && input.prf === 'ready',
      needsCheck: hasWallet && needsPrfCheck,
      action: needsPrfCheck ? 'Check passkey' : 'Create an encrypted backup',
      detail: !hasWallet
        ? 'Set up a wallet to check its recovery options.'
        : input.prf === 'ready'
          ? 'Ready'
          : input.prf === 'unverified'
            ? 'Not checked yet'
            : input.prf === 'cancelled'
              ? 'Check cancelled. You can try again.'
              : input.prf === 'failed'
                ? exhausted
                  ? 'This passkey did not give a recovery secret. Create an encrypted backup instead.'
                  : 'Could not check this passkey. Try again.'
                : input.prf === 'funded'
                  ? 'The fee-payer has funds and was not changed. Create an encrypted backup for recovery.'
                  : input.prf === 'unsupported'
                    ? 'This passkey manager does not support PRF. Create an encrypted backup instead.'
                    : 'Passkey recovery is unavailable. Create an encrypted backup instead.',
    },
    {
      key: 'backup',
      label: 'Encrypted backup',
      ready: hasWallet && input.backupLastExportedAt !== null,
      action: 'Create a backup',
    },
    {
      key: 'servers',
      label: 'Recovery servers',
      ready: hasWallet && input.recoveryServerCount > 0,
      action: 'Configure recovery servers',
    },
  ];
  const readyCount = mechanisms.filter((mechanism) => mechanism.ready).length;
  const overall = readyCount === mechanisms.length ? 'full' : readyCount > 0 ? 'partial' : 'none';
  return {
    mechanisms,
    readyCount,
    overall,
    summary: `${readyCount} of ${mechanisms.length} recovery mechanisms ready`,
  };
}
