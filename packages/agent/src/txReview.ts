import { Asset, TransactionBuilder, type Transaction } from '@stellar/stellar-sdk'

/**
 * Server-side transaction review, sharing the exact same operation allowlist and
 * fee-payer source check as `frontend/mobile/lib/agentMessages.ts` so neither
 * side is a single point of failure.
 */

export const ALLOWED_OPERATION_TYPES = new Set([
  'payment',
  'pathPaymentStrictSend',
  'pathPaymentStrictReceive',
  'changeTrust',
  'createAccount',
])

export interface ProposalConfirmation {
  destination: string
  amount: string
  asset: string
}

export interface ProposalReview {
  source: string
  fee: string
  memo: string | null
  operations: string[]
  confirmations: ProposalConfirmation[]
  hasUnknownOperation: boolean
}

type DecodedOperation = Transaction['operations'][number]

export function shortenAddress(address: string): string {
  return address.length <= 14 ? address : `${address.slice(0, 6)}…${address.slice(-6)}`
}

function describeAsset(asset: Asset): string {
  return asset.isNative() ? 'XLM' : asset.getCode()
}

function describeOperation(operation: DecodedOperation): {
  text: string
  known: boolean
  confirmation?: ProposalConfirmation
} {
  switch (operation.type) {
    case 'payment':
      return {
        text: `Send ${operation.amount} ${describeAsset(operation.asset)} to ${shortenAddress(operation.destination)}`,
        known: true,
        confirmation: {
          destination: operation.destination,
          amount: operation.amount,
          asset: describeAsset(operation.asset),
        },
      }
    case 'pathPaymentStrictSend':
      return {
        text: `Swap ${operation.sendAmount} ${describeAsset(operation.sendAsset)} for at least ${operation.destMin} ${describeAsset(operation.destAsset)} to ${shortenAddress(operation.destination)}`,
        known: true,
        confirmation: {
          destination: operation.destination,
          amount: `at least ${operation.destMin}`,
          asset: describeAsset(operation.destAsset),
        },
      }
    case 'pathPaymentStrictReceive':
      return {
        text: `Swap up to ${operation.sendMax} ${describeAsset(operation.sendAsset)} for ${operation.destAmount} ${describeAsset(operation.destAsset)} to ${shortenAddress(operation.destination)}`,
        known: true,
        confirmation: {
          destination: operation.destination,
          amount: operation.destAmount,
          asset: describeAsset(operation.destAsset),
        },
      }
    case 'changeTrust':
      return { text: `Add a trustline for ${operation.line.toString()}`, known: true }
    case 'createAccount':
      return {
        text: `Create account ${shortenAddress(operation.destination)} with ${operation.startingBalance} XLM`,
        known: true,
        confirmation: {
          destination: operation.destination,
          amount: operation.startingBalance,
          asset: 'XLM',
        },
      }
    case 'invokeHostFunction':
      return { text: 'Call a smart contract', known: false }
    default:
      return { text: `Unrecognised operation: ${operation.type}`, known: false }
  }
}

export function reviewProposedTransaction(
  xdr: string,
  networkPassphrase: string,
): ProposalReview {
  const parsed = TransactionBuilder.fromXDR(xdr, networkPassphrase)
  const tx: Transaction =
    'innerTransaction' in parsed ? (parsed.innerTransaction as Transaction) : parsed

  if (tx.operations.length === 0) {
    return {
      source: tx.source,
      fee: tx.fee,
      memo: tx.memo?.value ? String(tx.memo.value) : null,
      operations: [],
      confirmations: [],
      hasUnknownOperation: true,
    }
  }

  const described = tx.operations.map(describeOperation)
  const confirmations = described
    .map((operation) => operation.confirmation)
    .filter((confirmation): confirmation is ProposalConfirmation => confirmation !== undefined)

  return {
    source: tx.source,
    fee: tx.fee,
    memo: tx.memo?.value ? String(tx.memo.value) : null,
    operations: described.map((operation) => operation.text),
    confirmations,
    hasUnknownOperation: described.some(
      (operation, index) =>
        !operation.known || !ALLOWED_OPERATION_TYPES.has(tx.operations[index].type),
    ),
  }
}

export function isProposalForFeePayer(
  review: ProposalReview,
  feePayerAddress: string | null,
): boolean {
  return !!feePayerAddress && review.source === feePayerAddress
}

export function proposalRefusal(
  review: ProposalReview | null,
  feePayerAddress: string | null,
): string | null {
  if (!review) return 'This transaction could not be decoded, so it cannot be approved here.'
  if (!isProposalForFeePayer(review, feePayerAddress)) {
    return `This transaction is sourced from ${shortenAddress(review.source)}, which is not this wallet's fee payer. Nothing was signed.`
  }
  if (review.hasUnknownOperation) {
    return 'This transaction contains an operation this app cannot show you, so it will not be signed. Nothing was signed.'
  }
  return null
}
