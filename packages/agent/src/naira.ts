/**
 * Naira rails helper module for the Veil AI agent.
 *
 * Implements read and prepare tools for Nigerian Naira (NGN) services:
 * - Read: list_naira_services, get_verification_status
 * - Prepare: prepare_airtime, prepare_bill, prepare_buy_naira
 *
 * CRITICAL BOUNDARIES & INVARIANTS:
 * 1. The agent never signs, touches key material, or submits transactions.
 * 2. Every prepared action lands on its screen for confirmation; none completes in chat.
 * 3. No NIN or identity document is ever passed to, stored by, logged by, or returned from the agent.
 *    Verification state is solely a boolean ({ verified: boolean }).
 * 4. Phone numbers are never guessed or inferred; they must be provided by the user.
 * 5. An unverified user receives a clear next step pointing to the verification screen, never a failed action.
 * 6. Service availability is verified before asking for an amount.
 */

export type NairaServiceId = 'airtime' | 'bills' | 'buy_naira'

export interface NairaServiceInfo {
  id: NairaServiceId
  name: string
  available: boolean
  minAmountNgn: number
  maxAmountNgn: number
  description: string
}

export interface NairaServicesConfig {
  airtimeAvailable?: boolean
  billsAvailable?: boolean
  buyNairaAvailable?: boolean
}

// In-memory availability configuration (defaults to true)
let servicesConfig: NairaServicesConfig = {
  airtimeAvailable: true,
  billsAvailable: true,
  buyNairaAvailable: true,
}

export function configureNairaServices(config: Partial<NairaServicesConfig>): void {
  servicesConfig = { ...servicesConfig, ...config }
}

export function resetNairaServicesConfig(): void {
  servicesConfig = {
    airtimeAvailable: true,
    billsAvailable: true,
    buyNairaAvailable: true,
  }
}

export const NAIRA_SERVICE_LIMITS = {
  airtime: { min: 50, max: 50_000 },
  bills: { min: 100, max: 500_000 },
  buy_naira: { min: 1_000, max: 5_000_000 },
} as const

export function getNairaServices(): NairaServiceInfo[] {
  return [
    {
      id: 'airtime',
      name: 'Airtime',
      available: servicesConfig.airtimeAvailable ?? true,
      minAmountNgn: NAIRA_SERVICE_LIMITS.airtime.min,
      maxAmountNgn: NAIRA_SERVICE_LIMITS.airtime.max,
      description: 'Mobile airtime top-up for MTN, Airtel, Glo, and 9mobile',
    },
    {
      id: 'bills',
      name: 'Bills',
      available: servicesConfig.billsAvailable ?? true,
      minAmountNgn: NAIRA_SERVICE_LIMITS.bills.min,
      maxAmountNgn: NAIRA_SERVICE_LIMITS.bills.max,
      description: 'Pay for electricity, TV, water, waste, and betting',
    },
    {
      id: 'buy_naira',
      name: 'Buy with Naira',
      available: servicesConfig.buyNairaAvailable ?? true,
      minAmountNgn: NAIRA_SERVICE_LIMITS.buy_naira.min,
      maxAmountNgn: NAIRA_SERVICE_LIMITS.buy_naira.max,
      description: 'Deposit NGN via bank transfer to receive USDC or XLM',
    },
  ]
}

export function isNairaServiceAvailable(serviceId: NairaServiceId): boolean {
  switch (serviceId) {
    case 'airtime':
      return servicesConfig.airtimeAvailable ?? true
    case 'bills':
      return servicesConfig.billsAvailable ?? true
    case 'buy_naira':
      return servicesConfig.buyNairaAvailable ?? true
    default:
      return false
  }
}

/**
 * Validates whether a phone number is a valid Nigerian MSISDN.
 * Format: +234..., 234..., or 0... followed by 10 digits starting with 7, 8, or 9.
 */
export function isValidNigerianPhone(phone: string): boolean {
  if (!phone || typeof phone !== 'string') return false
  const cleaned = phone.replace(/[\s\-()]/g, '')
  return /^(?:\+?234|0)[789][01]\d{8}$/.test(cleaned)
}

/**
 * Normalizes a Nigerian phone number to national format (080...).
 */
export function normalizeNigerianPhone(phone: string): string {
  const cleaned = phone.replace(/[\s\-()]/g, '')
  if (cleaned.startsWith('+234')) {
    return '0' + cleaned.slice(4)
  }
  if (cleaned.startsWith('234')) {
    return '0' + cleaned.slice(3)
  }
  return cleaned
}

/**
 * Verification provider hook for tests and integrations.
 * Strips all identity documents and sensitive fields before returning.
 */
let customVerificationResolver: ((address: string) => Promise<{ verified: boolean }>) | null = null

export function setCustomVerificationResolver(
  resolver: ((address: string) => Promise<{ verified: boolean }>) | null
): void {
  customVerificationResolver = resolver
}

/**
 * Sanitizes any input object to strictly `{ verified: boolean }`.
 * Guarantees that no NIN, BVN, document id, or personal identity data ever enters the agent.
 */
export function sanitizeVerification(data: unknown): { verified: boolean } {
  if (!data || typeof data !== 'object') {
    return { verified: false }
  }
  const verified = Boolean((data as Record<string, unknown>).verified)
  return { verified }
}

/**
 * Gets user verification status.
 * Strictly returns only `{ verified: boolean }`.
 */
export async function getVerificationStatus(
  walletAddress: string,
  feePayerAddress?: string,
): Promise<{ verified: boolean }> {
  const target = feePayerAddress ?? walletAddress
  if (customVerificationResolver) {
    const raw = await customVerificationResolver(target)
    return sanitizeVerification(raw)
  }
  // Default unverified unless configured
  return { verified: false }
}

/**
 * Removes 11-digit numbers (potential NINs) from any error message or string.
 */
export function sanitizeNINString(text: string): string {
  return text.replace(/\b\d{11}\b/g, '[REDACTED]')
}
