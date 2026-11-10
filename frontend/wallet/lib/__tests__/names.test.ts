/**
 * Veil Names, client side.
 *
 * Two things are pinned here above all others.
 *
 * The first is that this file agrees with wraith's `src/names/pricing.ts` and
 * `src/names/term.ts`. The two cannot import from each other — different
 * repositories — so the numbers are duplicated, and a divergence quotes a
 * total nobody charges.
 *
 * The second is that a name is never called available unless something
 * actually said so. The registry does not exist yet, and a page that tells
 * somebody their name is free when nothing can grant it to them takes money
 * for nothing.
 */
import {
  MAX_NAME_LENGTH,
  MAX_TERM_YEARS,
  MIN_NAME_LENGTH,
  MIN_TERM_YEARS,
  REGISTRATION_YEAR_MS,
  SUFFIX,
  clampTerm,
  describeAvailability,
  expiryDate,
  isReserved,
  lookupAvailability,
  normalizeName,
  priceTable,
  pricePerYear,
  totalUsdc,
  validateName,
} from '../names'

describe('parity with wraith', () => {
  // If one of these fails, wraith changed and this file did not (or the other
  // way round). Fix both, never just this assertion.
  it('matches the authoritative length and term bounds', () => {
    expect(MIN_NAME_LENGTH).toBe(3)
    expect(MAX_NAME_LENGTH).toBe(20)
    expect(MIN_TERM_YEARS).toBe(1)
    expect(MAX_TERM_YEARS).toBe(5)
  })

  it('matches the authoritative price bands', () => {
    for (let n = 1; n <= 5; n++) expect(pricePerYear(n)).toBe(3)
    for (let n = 6; n <= 10; n++) expect(pricePerYear(n)).toBe(5)
    for (let n = 11; n <= MAX_NAME_LENGTH; n++) expect(pricePerYear(n)).toBe(2)
  })

  it('keeps the middle band dearest, which is deliberate', () => {
    // Demand pricing, not scarcity pricing. If a change makes this descend,
    // the product decision was reversed and somebody should say so out loud.
    expect(pricePerYear(7)).toBeGreaterThan(pricePerYear(3))
    expect(pricePerYear(7)).toBeGreaterThan(pricePerYear(14))
  })

  it('uses a flat 365-day year', () => {
    expect(REGISTRATION_YEAR_MS).toBe(365 * 24 * 60 * 60 * 1000)
  })
})

describe('validation', () => {
  it('treats an empty field as nothing to complain about', () => {
    expect(validateName('')).toBeNull()
    expect(validateName('   ')).toBeNull()
  })

  it('names the specific problem so the field can say it', () => {
    expect(validateName('ab')).toBe('short')
    expect(validateName('a'.repeat(MAX_NAME_LENGTH + 1))).toBe('long')
    expect(validateName('ja-ck')).toBe('invalid')
    expect(validateName('ja ck')).toBe('invalid')
    expect(validateName('_jack')).toBe('separator')
    expect(validateName('jack_')).toBe('separator')
    expect(validateName('ja__ck')).toBe('separator')
  })

  it('accepts a well-formed name', () => {
    expect(validateName('ada')).toBeNull()
    expect(validateName('jack_ng')).toBeNull()
    expect(validateName('a'.repeat(MAX_NAME_LENGTH))).toBeNull()
  })

  it('refuses a Cyrillic homoglyph rather than folding it', () => {
    // "jаck" with U+0430 reads as "jack". A name resolves to a payment
    // destination, so a lookalike is a redirect and not a typo.
    expect(validateName('jаck')).toBe('invalid')
  })

  it('folds case, because case is not part of a name', () => {
    expect(normalizeName('AdeBayo')).toBe('adebayo')
    expect(normalizeName('  ADA  ')).toBe('ada')
  })
})

describe('reserved names', () => {
  it('refuses names that could pose as Veil or its team', () => {
    for (const n of ['veil', 'support', 'admin', 'security', 'payments']) {
      expect(isReserved(n)).toBe(true)
    }
  })

  it('refuses them padded with underscores', () => {
    expect(isReserved('s_u_p_p_o_r_t')).toBe(true)
    expect(isReserved('ve_il')).toBe(true)
  })

  it('allows an ordinary name that merely contains a reserved word', () => {
    expect(isReserved('teamjack')).toBe(false)
    expect(isReserved('adebayo')).toBe(false)
  })
})

describe('totals and terms', () => {
  it('multiplies the annual rate by the term', () => {
    expect(totalUsdc(7, 3)).toBe(15)
    expect(totalUsdc(3, 1)).toBe(3)
    expect(totalUsdc(14, 5)).toBe(10)
  })

  it('clamps a term into what can actually be bought', () => {
    expect(clampTerm(0)).toBe(MIN_TERM_YEARS)
    expect(clampTerm(99)).toBe(MAX_TERM_YEARS)
    expect(clampTerm(2.4)).toBe(2)
    expect(clampTerm(NaN)).toBe(MIN_TERM_YEARS)
  })

  it('dates the expiry a whole number of 365-day years out', () => {
    const now = 1_800_000_000_000
    expect(expiryDate(2, now).getTime()).toBe(now + 2 * REGISTRATION_YEAR_MS)
  })

  it('builds the pricing table from the bands rather than retyped numbers', () => {
    const rows = priceTable()
    expect(rows).toHaveLength(3)
    expect(rows.map((r) => r.perYearUsdc)).toEqual([3, 5, 2])
    for (const row of rows) {
      expect(row.perYearUsdc).toBe(pricePerYear(row.example.length))
    }
  })
})

describe('availability — never guess', () => {
  const ok = (body: unknown) =>
    jest.fn().mockResolvedValue({ ok: true, status: 200, json: async () => body } as unknown as Response)

  it('reports unknown when no indexer is configured', async () => {
    const fetchImpl = jest.fn()
    await expect(lookupAvailability('ada', { wraithUrl: '', fetchImpl })).resolves.toBe('unknown')
    expect(fetchImpl).not.toHaveBeenCalled()
  })

  it('reports unknown — not available — when the route does not exist yet', async () => {
    // This is the live case today: the registry is not deployed, so the
    // endpoint 404s. Reading that as "nobody has it" would put a Claim button
    // in front of a name nothing can grant.
    const fetchImpl = jest
      .fn()
      .mockResolvedValue({ ok: false, status: 404, json: async () => ({}) } as unknown as Response)
    await expect(
      lookupAvailability('ada', { wraithUrl: 'https://w.example', fetchImpl }),
    ).resolves.toBe('unknown')
  })

  it('reports unknown when the network fails', async () => {
    const fetchImpl = jest.fn().mockRejectedValue(new Error('offline'))
    await expect(
      lookupAvailability('ada', { wraithUrl: 'https://w.example', fetchImpl }),
    ).resolves.toBe('unknown')
  })

  it('reports unknown on a 200 whose body it does not understand', async () => {
    await expect(
      lookupAvailability('ada', { wraithUrl: 'https://w.example', fetchImpl: ok({ status: 'maybe' }) }),
    ).resolves.toBe('unknown')
    await expect(
      lookupAvailability('ada', { wraithUrl: 'https://w.example', fetchImpl: ok({}) }),
    ).resolves.toBe('unknown')
  })

  it('passes through the four states the registry can actually report', async () => {
    for (const status of ['available', 'taken', 'yours', 'reserved'] as const) {
      await expect(
        lookupAvailability('ada', { wraithUrl: 'https://w.example', fetchImpl: ok({ status }) }),
      ).resolves.toBe(status)
    }
  })

  it('url-encodes the name it looks up', async () => {
    const fetchImpl = ok({ status: 'available' })
    await lookupAvailability('jack_ng', { wraithUrl: 'https://w.example/', fetchImpl })
    expect(fetchImpl).toHaveBeenCalledWith('https://w.example/names/jack_ng')
  })
})

describe('what the result card says', () => {
  it('only ever offers to claim an available name', () => {
    const states = ['checking', 'available', 'taken', 'yours', 'reserved', 'unknown'] as const
    for (const state of states) {
      const { claimable } = describeAvailability(state, 'ada')
      expect(claimable).toBe(state === 'available')
    }
  })

  it('says plainly that the registry is not running, rather than being vague', () => {
    const { pill, meta } = describeAvailability('unknown', 'ada')
    expect(pill).toBe('Not live yet')
    expect(meta).toMatch(/not running yet/)
  })

  it('calls out a short name, which costs the least', () => {
    expect(describeAvailability('available', 'ada').meta).toMatch(/short name/)
    expect(describeAvailability('available', 'adebayo').meta).not.toMatch(/short name/)
  })

  it('names every Veil name with the same suffix', () => {
    expect(SUFFIX).toBe('*useveilapp.xyz')
  })
})
