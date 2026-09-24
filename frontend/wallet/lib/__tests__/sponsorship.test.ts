import {
  ACCOUNT_BASE_RESERVE_XLM,
  SPONSORSHIP_BALANCE_CEILING_XLM,
  TRUSTLINE_RESERVE_XLM,
  decideSponsorship,
  isSponsorableAsset,
  planSponsorship,
  type AccountSnapshot,
} from '../sponsorship'

const account = (over: Partial<AccountSnapshot> = {}): AccountSnapshot => ({
  exists: true,
  nativeBalance: 0,
  trustedAssets: [],
  ...over,
})

describe('decideSponsorship', () => {
  it('sponsors a funded-but-broke account, which is the case that motivates this', () => {
    // A user handed USDC by a friend, holding no XLM: without sponsorship the
    // payment bounces and they cannot fix it, because fixing it costs the XLM
    // they do not have.
    const decision = decideSponsorship('USDC', account({ nativeBalance: 0 }))

    expect(decision.sponsor).toBe(true)
  })

  it('sponsors an account that does not exist yet, creating it in the same transaction', () => {
    const decision = decideSponsorship('USDC', account({ exists: false }))

    expect(decision).toEqual({ sponsor: true, reason: 'account-missing' })
  })

  it('refuses an asset outside the allowlist', () => {
    // The server re-runs this before signing, so the allowlist is what stops a
    // caller sponsoring a trustline to an arbitrary issuer at our expense.
    const decision = decideSponsorship('SCAMCOIN', account())

    expect(decision.sponsor).toBe(false)
    if (!decision.sponsor) expect(decision.reason).toBe('asset-not-sponsorable')
  })

  it('is case-insensitive about the asset code', () => {
    expect(decideSponsorship('usdc', account()).sponsor).toBe(true)
    expect(isSponsorableAsset('UsDc')).toBe(true)
  })

  it('refuses when the trustline already exists', () => {
    // Paying twice for the same trustline is pure waste, and re-submitting a
    // ChangeTrust that is already in place would fail anyway.
    const decision = decideSponsorship('USDC', account({ trustedAssets: ['USDC'] }))

    expect(decision.sponsor).toBe(false)
    if (!decision.sponsor) expect(decision.reason).toBe('already-trusted')
  })

  it('refuses a user who can afford it themselves', () => {
    const decision = decideSponsorship(
      'USDC',
      account({ nativeBalance: SPONSORSHIP_BALANCE_CEILING_XLM + 1 }),
    )

    expect(decision.sponsor).toBe(false)
    if (!decision.sponsor) expect(decision.reason).toBe('can-afford-it')
  })

  it('still sponsors an account holding dust — enough for the reserve, not the fee', () => {
    // The ceiling sits above the bare reserve on purpose. An account with
    // exactly 0.5 XLM can nominally pay the reserve and then has nothing left,
    // which is not a working wallet.
    expect(decideSponsorship('USDC', account({ nativeBalance: TRUSTLINE_RESERVE_XLM })).sponsor)
      .toBe(true)
  })

  it('explains itself whenever it declines, so the UI never has to invent a message', () => {
    const declines = [
      decideSponsorship('SCAMCOIN', account()),
      decideSponsorship('USDC', account({ trustedAssets: ['USDC'] })),
      decideSponsorship('USDC', account({ nativeBalance: 100 })),
    ]

    for (const decision of declines) {
      expect(decision.sponsor).toBe(false)
      if (!decision.sponsor) {
        expect(decision.message.length).toBeGreaterThan(0)
        expect(decision.message).not.toContain('undefined')
      }
    }
  })
})

describe('planSponsorship', () => {
  it('brackets the trustline between begin and end sponsoring', () => {
    const plan = planSponsorship(account())

    expect(plan.operations).toEqual([
      'beginSponsoringFutureReserves',
      'changeTrust',
      'endSponsoringFutureReserves',
    ])
  })

  it('ends with endSponsoringFutureReserves, which the protocol requires', () => {
    // Anything after the bracket closes is paid for by the user — the exact
    // thing being avoided — and an unterminated bracket is invalid outright.
    for (const exists of [true, false]) {
      const plan = planSponsorship(account({ exists }))
      expect(plan.operations.at(-1)).toBe('endSponsoringFutureReserves')
      expect(plan.operations.at(0)).toBe('beginSponsoringFutureReserves')
    }
  })

  it('creates the account first when it does not exist', () => {
    const plan = planSponsorship(account({ exists: false }))

    expect(plan.createAccount).toBe(true)
    expect(plan.operations.indexOf('createAccount')).toBeLessThan(
      plan.operations.indexOf('changeTrust'),
    )
  })

  it('prices the trustline reserve alone for an existing account', () => {
    expect(planSponsorship(account()).reserveCostXlm).toBe(TRUSTLINE_RESERVE_XLM)
  })

  it('adds the account base reserve when it also has to create the account', () => {
    // What the sponsor actually locks per user — the number that decides how
    // far a given float stretches.
    expect(planSponsorship(account({ exists: false })).reserveCostXlm).toBe(
      TRUSTLINE_RESERVE_XLM + ACCOUNT_BASE_RESERVE_XLM,
    )
  })
})
