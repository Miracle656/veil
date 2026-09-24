export type PrfRecoveryState = 'unverified' | 'ready' | 'missing';
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
  const mechanisms: RecoveryMechanism[] = [
    {
      key: 'prf',
      label: 'Passkey recovery',
      ready: hasWallet && input.prf === 'ready',
      needsCheck: hasWallet && input.prf === 'unverified',
      action: input.prf === 'unverified' ? 'Check passkey' : 'Set up a PRF-enabled passkey',
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
