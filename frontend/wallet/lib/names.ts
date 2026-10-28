/**
 * Veil Names, client side: what a name is, what it costs, and what we can
 * honestly say about whether it is free.
 *
 * The rules here are a deliberate mirror of wraith's `src/names/pricing.ts`
 * and `src/names/term.ts`, which are authoritative. They are duplicated rather
 * than imported because the two live in different repositories and the field
 * has to price and reject a name as the user types, with no round trip. Same
 * arrangement as `lib/assets.ts` and its mobile twin — and the same hazard, so
 * a divergence is a bug rather than drift: the server is the one that takes
 * money, and a client that prices a name differently will quote a total nobody
 * charges. If you change a number here, change it in wraith in the same breath.
 *
 * A name resolves over SEP-2 federation to an address somebody sends funds to,
 * so the charset rules are a money control rather than a formatting
 * preference: two strings a human reads as the same name must never be two
 * names.
 */

/** What every Veil name ends with. */
export const SUFFIX = '*useveilapp.xyz'

/** Mirrors wraith `MIN_SELLABLE_LENGTH` / `MAX_NAME_LENGTH`. */
export const MIN_NAME_LENGTH = 3
export const MAX_NAME_LENGTH = 20

/** Mirrors wraith `MIN_TERM_YEARS` / `MAX_TERM_YEARS`. */
export const MIN_TERM_YEARS = 1
export const MAX_TERM_YEARS = 5

/**
 * Price per year in USDC, by length band. Mirrors wraith `NAME_PRICE_BANDS`.
 *
 * Not monotonic, and that is on purpose: the dearest band is the middle one,
 * because real first names are six to ten characters and that is where the
 * demand is. Do not "fix" it into a descending curve.
 */
const PRICE_BANDS: readonly { readonly maxLength: number; readonly priceUsdc: number }[] = [
  { maxLength: 5, priceUsdc: 3 },
  { maxLength: 10, priceUsdc: 5 },
]
const LONG_NAME_PRICE_USDC = 2

/** Mirrors wraith `RESERVED_NAMES`. */
const RESERVED = new Set([
  'veil', 'veilapp', 'useveilapp', 'admin', 'administrator', 'support', 'help',
  'helpdesk', 'info', 'team', 'staff', 'official', 'security', 'billing',
  'payments', 'payment', 'wallet', 'deposit', 'withdraw', 'refund', 'verify',
  'verification', 'kyc', 'root', 'system', 'noreply', 'no_reply', 'postmaster',
  'abuse', 'legal', 'privacy', 'api', 'www', 'mail', 'name', 'names', 'drips',
  'stellar', 'soroban', 'sdf', 'moderator', 'mod',
])

/** Why a typed name cannot be claimed, in the words shown under the field. */
export const VALIDATION_MESSAGES = {
  short: `Names need at least ${MIN_NAME_LENGTH} characters.`,
  long: `Names can be up to ${MAX_NAME_LENGTH} characters.`,
  invalid: 'Use lowercase letters, numbers and underscores only.',
  separator: 'Underscores cannot start or end a name, or sit next to each other.',
} as const

export type ValidationProblem = keyof typeof VALIDATION_MESSAGES

/**
 * What we are able to say about a name right now.
 *
 * `unknown` is the one that matters and the one a mock would not have. The
 * registry does not exist yet, so when the lookup cannot be made this is what
 * comes back — never `available`. Telling somebody a name is free when nothing
 * can grant it to them is how a person ends up paying for nothing.
 */
export type Availability = 'checking' | 'available' | 'taken' | 'yours' | 'reserved' | 'unknown'

/** Fold a typed name to its canonical form. Case is not part of a name. */
export function normalizeName(input: string): string {
  return input.trim().toLowerCase()
}

/** True if the name is one nobody may hold, ignoring underscores. */
export function isReserved(name: string): boolean {
  return RESERVED.has(name) || RESERVED.has(name.replace(/_/g, ''))
}

/**
 * The problem with a typed name, or null if the shape is fine.
 *
 * Shape only — it says nothing about whether the name is already taken, which
 * needs the registry. An empty field is not a problem, it is an empty field.
 */
export function validateName(input: string): ValidationProblem | null {
  const name = normalizeName(input)
  if (name.length === 0) return null
  if (name.length < MIN_NAME_LENGTH) return 'short'
  if (name.length > MAX_NAME_LENGTH) return 'long'
  if (!/^[a-z0-9_]+$/.test(name)) return 'invalid'
  if (name.startsWith('_') || name.endsWith('_') || name.includes('__')) return 'separator'
  return null
}

/** Price per year in USDC for a name of this length. */
export function pricePerYear(length: number): number {
  for (const band of PRICE_BANDS) {
    if (length <= band.maxLength) return band.priceUsdc
  }
  return LONG_NAME_PRICE_USDC
}

/** What a whole registration comes to, in USDC. */
export function totalUsdc(length: number, years: number): number {
  return pricePerYear(length) * years
}

/** Clamp a term to the range that can actually be bought. */
export function clampTerm(years: number): number {
  if (!Number.isFinite(years)) return MIN_TERM_YEARS
  return Math.min(MAX_TERM_YEARS, Math.max(MIN_TERM_YEARS, Math.round(years)))
}

/** The rows of the pricing table, built from the bands rather than retyped. */
export function priceTable(): { label: string; example: string; perYearUsdc: number }[] {
  return [
    { label: '3 to 5 characters', example: 'ada', perYearUsdc: pricePerYear(3) },
    { label: '6 to 10 characters', example: 'adebayo', perYearUsdc: pricePerYear(7) },
    { label: '11 to 20 characters', example: 'adebayoakinola', perYearUsdc: pricePerYear(14) },
  ]
}

/**
 * A flat 365-day year, matching wraith's `REGISTRATION_YEAR_MS`.
 *
 * Not a calendar year: the contract, the server and this file must all compute
 * one expiry, and "a year from 29 February" has no single answer.
 */
export const REGISTRATION_YEAR_MS = 365 * 24 * 60 * 60 * 1000

/** The date a term bought now would run until. */
export function expiryDate(years: number, nowMs: number = Date.now()): Date {
  return new Date(nowMs + years * REGISTRATION_YEAR_MS)
}

/** Ask wraith whether a name is free. */
export async function lookupAvailability(
  name: string,
  options: { wraithUrl?: string; fetchImpl?: typeof fetch } = {},
): Promise<Availability> {
  const base = (options.wraithUrl ?? process.env.NEXT_PUBLIC_WRAITH_URL ?? '').replace(/\/+$/, '')
  if (!base) return 'unknown'

  const doFetch = options.fetchImpl ?? fetch
  try {
    const res = await doFetch(`${base}/names/${encodeURIComponent(name)}`)
    // The registry is not deployed yet, so this route does not exist. A 404
    // here is "we cannot tell", NOT "nobody has it" — the distinction is the
    // difference between an honest page and one that sells a name it has no
    // way to deliver.
    if (!res.ok) return 'unknown'
    const body = (await res.json()) as { status?: string }
    switch (body.status) {
      case 'available':
      case 'taken':
      case 'yours':
      case 'reserved':
        return body.status
      default:
        return 'unknown'
    }
  } catch {
    return 'unknown'
  }
}

/** Everything the result card needs, derived in one place. */
export function describeAvailability(
  state: Availability,
  name: string,
): { pill: string; meta: string; claimable: boolean } {
  switch (state) {
    case 'checking':
      return { pill: 'Checking', meta: 'Checking availability…', claimable: false }
    case 'available':
      return {
        pill: 'Available',
        meta:
          name.length <= 5
            ? `${name.length} characters · short name`
            : `${name.length} characters`,
        claimable: true,
      }
    case 'taken':
      return { pill: 'Taken', meta: 'Belongs to another Veil wallet', claimable: false }
    case 'yours':
      return { pill: 'Yours', meta: 'Registered to your wallet', claimable: false }
    case 'reserved':
      return {
        pill: 'Reserved',
        meta: 'Reserved so nobody can pose as Veil or its team',
        claimable: false,
      }
    case 'unknown':
      return {
        pill: 'Not live yet',
        meta: 'The name registry is not running yet, so this cannot be checked or claimed.',
        claimable: false,
      }
  }
}
