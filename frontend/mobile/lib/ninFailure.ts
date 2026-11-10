/**
 * What a failed NIN check means, from the code the provider sends.
 *
 * They documented these on 2026-10-14, along with the fact that matters most:
 * **the check is the NIN alone.** The name on the customer record is never
 * compared, so name order, middle names and case make no difference. Both
 * verification screens had been telling people the opposite — guessing at a
 * name mismatch whenever an error arrived without a readable message — and
 * sent at least three testers off to correct a spelling nothing looked at.
 *
 * Shared by web and mobile so the two cannot drift into saying different things
 * about the same code.
 */

export type NinFailure = {
  /** Short, shown as the heading. */
  title: string
  /** What to do, or why there is nothing to do. */
  body: string
  /** True when retrying the same number cannot work. */
  terminal: boolean
}

/** Linq's documented KYC failure codes, 2026-10-14. */
export const NIN_FAILURES: Record<string, NinFailure> = {
  invalid_nin_format: {
    title: 'That NIN is not 11 digits',
    body: 'A NIN is exactly 11 digits with no spaces or letters. Check it against your slip and enter it again.',
    terminal: false,
  },
  nin_already_used: {
    title: 'This NIN is already verified elsewhere',
    body: 'A NIN can only ever verify one account, and this one is bound to a different reference — most likely from an earlier wallet. Retrying here cannot reach it; send the reference below to support and they can re-bind it.',
    terminal: true,
  },
  nin_verification_failed: {
    title: "That NIN didn't verify",
    body: 'The number was checked and came back unverified. Only the number is checked, so your name makes no difference — compare the 11 digits against your NIN slip and try again.',
    terminal: false,
  },
  kyc_provider_error: {
    title: 'The identity service is having trouble',
    body: 'This is their side, not your number. Nothing was used up — wait a minute and try the same NIN again.',
    terminal: false,
  },
  kyc_internal_error: {
    title: 'Something went wrong on their side',
    body: 'This is not your number and nothing was used up. Wait a minute and try the same NIN again.',
    terminal: false,
  },
}

/**
 * The failure for a code, or null when there is none to go on.
 *
 * Null deliberately means "we do not know" rather than a default guess. A
 * screen that guesses is how the name-mismatch advice came to be shown to
 * people whose names were never in question.
 */
export function ninFailureFor(code: string | undefined): NinFailure | null {
  if (!code) return null
  return NIN_FAILURES[code.trim().toLowerCase()] ?? null
}

/** Whether this code means the NIN is spent and no retry can reach it. */
export function isNinSpent(code: string | undefined): boolean {
  return ninFailureFor(code)?.terminal === true
}
