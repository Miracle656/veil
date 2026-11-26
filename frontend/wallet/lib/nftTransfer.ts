import { getTokenBoundName, type NFTItem } from './nfts'
export { getTokenBoundName } from './nfts'

/**
 * Thrown when attempting to execute or sign a transfer for a token that
 * carries a federation name without explicit confirmation of the consequence.
 */
export class UnconfirmedNameTransferError extends Error {
  constructor(public readonly name: string) {
    super(`Cannot transfer token carrying name "${name}" without explicit confirmation of the transfer consequence.`)
    this.name = 'UnconfirmedNameTransferError'
  }
}

export interface NameTransferWarningCopy {
  title: string
  consequence: string
  acknowledgmentLabel: string
}

/**
 * Returns the exact copy for a name-carrying token transfer warning.
 * Always names the specific name being transferred, never generic "your name".
 * Free of dark patterns, countdowns, or misleading language.
 */
export function getNameTransferWarningCopy(name: string): NameTransferWarningCopy {
  const trimmed = name.trim()
  return {
    title: `Transferring ${trimmed}`,
    consequence: `The name "${trimmed}" goes with this token. Anyone who has saved this name will pay the new holder from now on.`,
    acknowledgmentLabel: `I understand "${trimmed}" will belong to the new holder`,
  }
}

/**
 * Returns true if this token carries a federation name and requires
 * the transfer consequence confirmation.
 */
export function shouldShowNameTransferWarning(token: NFTItem): boolean {
  return Boolean(getTokenBoundName(token))
}

/**
 * Verifies that the transfer confirmation requirement is satisfied.
 * For tokens carrying a name, warningConfirmed MUST be true, otherwise throws.
 * For tokens carrying no name, warningConfirmed is not required.
 */
export function assertTransferCanProceed(token: NFTItem, warningConfirmed: boolean): void {
  const boundName = getTokenBoundName(token)
  if (boundName && !warningConfirmed) {
    throw new UnconfirmedNameTransferError(boundName)
  }
}

export interface ValidateNFTTransferResult {
  valid: boolean
  error?: string
  boundName: string | null
  requiresConfirmation: boolean
}

/**
 * Validates a pending NFT transfer before submission or signature.
 * Enforces recipient address formatting and name-consequence confirmation.
 */
export function validateNFTTransfer(
  token: NFTItem,
  recipientAddress: string,
  warningConfirmed: boolean,
): ValidateNFTTransferResult {
  const target = (recipientAddress || '').trim()
  if (!target) {
    return {
      valid: false,
      error: 'Recipient address is required.',
      boundName: getTokenBoundName(token),
      requiresConfirmation: shouldShowNameTransferWarning(token),
    }
  }

  // Basic Stellar address format validation (G... or C...)
  const isStellarAddress = /^[GC][A-Z0-9]{55}$/.test(target)
  const isFederation = target.includes('*')
  if (!isStellarAddress && !isFederation) {
    return {
      valid: false,
      error: 'Invalid recipient address or federation format.',
      boundName: getTokenBoundName(token),
      requiresConfirmation: shouldShowNameTransferWarning(token),
    }
  }

  const boundName = getTokenBoundName(token)
  if (boundName && !warningConfirmed) {
    return {
      valid: false,
      error: `Transfer warning for name "${boundName}" must be confirmed before signing.`,
      boundName,
      requiresConfirmation: true,
    }
  }

  return {
    valid: true,
    boundName,
    requiresConfirmation: Boolean(boundName),
  }
}
