import { redactSensitive } from '../boundary.js'

/**
 * Privacy guards for recurring top-ups:
 * - Phone numbers are personal data: store only what the plan needs, mask them
 *   in summaries, and keep them out of logs.
 * - NIN must never appear in a tool argument, a model prompt, or a log.
 */

const NIN_KEY_PATTERN = /(?:^|[_-])nin(?:$|[_-])|national[_-]?id(?:entity)?/i
const NIN_PROSE_PATTERN = /\bnin\b\s*[:=#-]?\s*\d{11}\b/i

/**
 * Validate and normalize a Nigerian mobile phone number to 11-digit local format
 * (`0XXXXXXXXXX`), or return null if invalid.
 */
export function normalizeNigerianPhone(raw: string): string | null {
  const digits = raw.replace(/[\s\-().+]/g, '')
  if (/^0[789][01]\d{8}$/.test(digits)) {
    return digits
  }
  if (/^234[789][01]\d{8}$/.test(digits)) {
    return `0${digits.slice(3)}`
  }
  return null
}

/**
 * Mask a phone number for display so only the last 4 digits are visible.
 */
export function maskPhoneNumber(phone: string): string {
  const digits = phone.replace(/\D/g, '')
  if (digits.length <= 4) return '****'
  return `${'*'.repeat(digits.length - 4)}${digits.slice(-4)}`
}

/**
 * Detect whether a payload contains a NIN field or NIN value.
 */
export function containsNin(value: unknown, seen = new Set<unknown>()): boolean {
  if (value === null || value === undefined) return false
  if (typeof value === 'string') {
    return NIN_PROSE_PATTERN.test(value)
  }
  if (typeof value !== 'object') return false
  if (seen.has(value)) return false
  seen.add(value)

  if (Array.isArray(value)) {
    return value.some((item) => containsNin(item, seen))
  }

  for (const [key, val] of Object.entries(value as Record<string, unknown>)) {
    if (NIN_KEY_PATTERN.test(key)) return true
    if (containsNin(val, seen)) return true
  }
  return false
}

/**
 * Reject any input that contains a NIN field or value.
 */
export function assertNoNin(value: unknown): void {
  if (containsNin(value)) {
    throw new Error(
      'NIN must never be sent to the assistant or stored in a recurring plan. Verify your NIN directly on the Verification screen.',
    )
  }
}

/**
 * Scrub secrets, URLs, phone numbers, and NIN references before writing logs.
 */
export function scrubLogMessage(message: string, knownPhones: readonly string[] = []): string {
  let out = redactSensitive(message)
  for (const phone of knownPhones) {
    if (!phone) continue
    const normalized = phone.replace(/\D/g, '')
    if (normalized.length >= 7) {
      out = out.split(phone).join('[phone redacted]')
      out = out.split(normalized).join('[phone redacted]')
      if (normalized.startsWith('0') && normalized.length === 11) {
        const intl = `234${normalized.slice(1)}`
        out = out.split(`+${intl}`).join('[phone redacted]')
        out = out.split(intl).join('[phone redacted]')
      }
    }
  }
  // Scrub any Nigerian mobile number formats
  out = out.replace(/(?<!\d)(?:\+?234|0)[789][01]\d{8}(?!\d)/g, '[phone redacted]')
  // Scrub any NIN references
  out = out.replace(/\bnin\b\s*[:=#-]?\s*\d{6,14}\b/gi, '[nin redacted]')
  return out
}
