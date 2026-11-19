import type { FeePayerSource } from './feePayerSource';
import type { MoveRefusal } from './feePayerMove';
import type { PrfOutcome } from './prfOutcome';

export type PrfRecoveryState =
  | 'unverified'
  | 'ready'
  | 'missing'
  | 'funded'
  /** Recorded at creation: the passkey gave no PRF secret and a random fee payer was used. */
  | 'random'
  /** Recorded: the fee payer derives from the passkey's non-secret credential ID (pre-PRF scheme). */
  | 'legacy'
  /** A keypair-mode testnet wallet: there is no passkey to recover from. */
  | 'keypair'
  | MoveRefusal
  | Exclude<PrfOutcome, 'ok'>;

export const MOVE_REFUSAL_REASONS: readonly MoveRefusal[] = [
  'destination-reserve',
  'pool-shares',
  'open-offers',
  'frozen-asset',
  'sponsorship',
  'too-many-assets',
  'no-destination-key',
] as const;

export function isMoveRefusal(state: string): state is MoveRefusal {
  return (MOVE_REFUSAL_REASONS as readonly string[]).includes(state);
}

export function isFailedMove(state: PrfRecoveryState): boolean {
  return state === 'funded' || isMoveRefusal(state);
}

/**
 * Seed the PRF state from the record the create path writes (#1178, the same
 * record the fee-payer screen shows). This answers "is this wallet PRF-backed?"
 * without prompting the authenticator; only a wallet set up before the record
 * existed stays `unverified` and needs the one-prompt check.
 */
export function prfStateFromSource(source: FeePayerSource | null | undefined): PrfRecoveryState {
  switch (source) {
    case 'prf':
      return 'ready';
    case 'random':
      return 'random';
    case 'credential-id':
      return 'legacy';
    case 'keypair':
      return 'keypair';
    default:
      return 'unverified';
  }
}

export type RecoveryStatusInput = {
  walletAddress: string | null;
  signerSecret: string | null;
  prf: PrfRecoveryState;
  backupLastExportedAt: number | null;
  recoveryServerCount: number;
  /**
   * Consecutive failed passkey checks this session.
   *
   * The screen already stops asking after two — it replaces the prompt with a
   * panel saying checking again will not help. This row did not know that and
   * kept saying "Try again" beside it, so the same screen gave two opposite
   * instructions about the same button.
   */
  prfFailedChecks?: number;
  /** Shortfall in XLM when the move was refused for destination-reserve. */
  moveShortfallXlm?: number;
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

/**
 * What the PRF row says, in consequences rather than mechanism (#1178): what
 * still works, what does not, and what to do about it. Never any key material.
 */
function prfDetail(
  hasWallet: boolean,
  prf: PrfRecoveryState,
  exhausted = false,
  shortfallXlm?: number,
): string {
  if (!hasWallet) return 'Set up a wallet to check its recovery options.';
  // Past the screen's own retry threshold, pointing at the passkey again is
  // advice it has already stopped believing. Point at the backup instead.
  if (exhausted && (prf === 'failed' || prf === 'cancelled' || prf === 'unverified')) {
    return 'This passkey did not give a recovery secret. Create an encrypted backup instead.';
  }
  switch (prf) {
    case 'ready':
      return 'Your passkey alone restores this wallet on any PRF-capable device — no backup file needed for that path.';
    case 'unverified':
      return 'Not checked yet. One passkey prompt answers whether this wallet can be restored from the passkey alone.';
    case 'cancelled':
      return 'Check cancelled. You can try again.';
    case 'failed':
      return 'Could not check this passkey. Try again.';
    case 'random':
      // This used to promise a repair "only while the fee payer is still
      // unfunded". The repair now moves the balance across, so a funded
      // account is the case it exists for, not the case it refuses.
      return 'Your passkey gave no recovery secret when this wallet was set up, so your spending account lives only on this phone and its money would be lost with it. Check again: if your passkey gives a secret now, Veil moves everything in that account to one your passkey can restore.';
    case 'legacy':
      return 'This wallet predates passkey recovery secrets: it can be restored from the passkey, but through a derivation anyone who learns the (non-secret) credential ID can rebuild. Keep only fee money on the fee payer.';
    case 'keypair':
      return 'A keypair-mode testnet wallet has no passkey to recover from. An encrypted backup is its only recovery path.';
    case 'destination-reserve': {
      const amount = shortfallXlm && shortfallXlm > 0 ? shortfallXlm : 1;
      return `Veil could not move your spending account to one your passkey can restore, so nothing was changed and your money is where it was. Your spending account needs about ${amount} more XLM before it can be moved. Send it to your spending address, then press the check again.`;
    }
    case 'pool-shares':
      return 'Veil could not move your spending account to one your passkey can restore, so nothing was changed and your money is where it was. It holds liquidity pool shares, which cannot be moved automatically. Withdraw your pool shares, then press the check again.';
    case 'open-offers':
      return 'Veil could not move your spending account to one your passkey can restore, so nothing was changed and your money is where it was. It has open trading offers that lock its balance. Cancel your open offers, then press the check again.';
    case 'frozen-asset':
      return 'Veil could not move your spending account to one your passkey can restore, so nothing was changed and your money is where it was. An asset issuer has frozen one of its trustlines, so it cannot be transferred. Contact the asset issuer or save your spending key.';
    case 'sponsorship':
      return 'Veil could not move your spending account to one your passkey can restore, so nothing was changed and your money is where it was. It is involved in account or entry sponsorship. Remove any active sponsorships, then press the check again.';
    case 'too-many-assets':
      return 'Veil could not move your spending account to one your passkey can restore, so nothing was changed and your money is where it was. It holds more assets than can be moved in a single transaction. Consolidate or send some assets to another account, then press the check again.';
    case 'no-destination-key':
      return 'Veil could not move your spending account to one your passkey can restore, so nothing was changed and your money is where it was. The destination account key was not available to establish required trustlines. Save your spending key to protect your funds.';
    case 'funded':
      return 'Veil could not move your spending account to one your passkey can restore, so nothing was changed and your money is where it was. It still lives only on this phone. Save its key from the warning on the home screen or settings. An encrypted backup does not include that key.';
    case 'unsupported':
      return 'This passkey manager does not support PRF, so the passkey alone can never restore this wallet on another device. Everything on this device keeps working. Create an encrypted backup instead.';
    default:
      return 'Passkey recovery is unavailable. Create an encrypted backup instead.';
  }
}

/** Derive the honest recovery summary without prompting the authenticator. */
export function deriveRecoveryStatus(input: RecoveryStatusInput): RecoveryStatus {
  const hasWallet = !!input.walletAddress && !!input.signerSecret;
  // Two failures in a row is the screen's own threshold for giving up on the
  // passkey, so past it this stops offering a check it does not believe in.
  const exhausted = (input.prfFailedChecks ?? 0) >= 2;
  const needsPrfCheck =
    !exhausted &&
    (input.prf === 'unverified' ||
    input.prf === 'cancelled' ||
    input.prf === 'failed' ||
    // A recorded random fee payer is repairable in place while unfunded, and
    // the repair *is* the check (retryRecoveryBinding) — offer it.
    input.prf === 'random');
  const mechanisms: RecoveryMechanism[] = [
    {
      key: 'prf',
      label: 'Passkey recovery',
      // 'legacy' recovers from the passkey too — weakly, which the detail says.
      ready: hasWallet && (input.prf === 'ready' || input.prf === 'legacy'),
      needsCheck: hasWallet && needsPrfCheck,
      action:
        input.prf === 'random'
          ? 'Repair with passkey'
          : isFailedMove(input.prf)
            ? 'Save spending key'
            : needsPrfCheck
              ? 'Check passkey'
              : 'Create an encrypted backup',
      detail: prfDetail(hasWallet, input.prf, exhausted, input.moveShortfallXlm),
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
