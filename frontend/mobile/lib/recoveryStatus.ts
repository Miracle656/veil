import type { PrfOutcome } from './prfOutcome';

export type PrfRecoveryState =
  'unverified' | 'ready' | 'missing' | 'funded' | Exclude<PrfOutcome, 'ok'>;
export type RecoveryStatusInput = {
  walletAddress: string | null;
  signerSecret: string | null;
  prf: PrfRecoveryState;
  backupLastExportedAt: number | null;
  recoveryServerCount: number;
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
  const needsPrfCheck =
    input.prf === 'unverified' || input.prf === 'cancelled' || input.prf === 'failed';
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
                ? 'Could not check this passkey. Try again.'
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
