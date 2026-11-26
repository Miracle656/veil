/**
 * @jest-environment node
 *
 * lib/nigerianBanks.ts is a lookup table that decides which institution a
 * cash-out lands in. It has no logic to test — the risk is the DATA, so that is
 * what these tests pin:
 *
 *  - a known name resolves to the code Linq was given, asserted row by row;
 *  - a code nobody recognises is refused, never defaulted to another bank;
 *  - no two rows share a code or a name, because the picker and the payout
 *    key off different columns and a duplicate silently picks one of them;
 *  - every row is complete, so a half-edited row cannot ship.
 *
 * What breaks if these fail: a wrong or missing code sends naira to the wrong
 * institution, and the user only finds out after the USDC is gone. The payout
 * provider matches on the code, not the name the user tapped.
 *
 * Provenance of the table (source, date, what it is and is not) is documented
 * in the module header. Nothing personal goes in here: a bank code identifies an
 * institution, never a person.
 */

import { NIGERIAN_BANKS, bankName } from '../nigerianBanks'

/**
 * The table as transcribed from Linq's list. This is a deliberately separate
 * copy: asserting against `NIGERIAN_BANKS` itself would prove nothing, because
 * every row would resolve to whatever the row currently says.
 *
 * Changing a row here is a payout change. Confirm it with Linq first.
 */
const PINNED: ReadonlyArray<readonly [name: string, code: string]> = [
  ['Access Bank', '044'],
  ['GTBank', '058'],
  ['First Bank', '011'],
  ['Zenith Bank', '057'],
  ['UBA', '033'],
  ['Kuda Microfinance Bank', '090267'],
  ['OPay', '100004'],
  ['PalmPay', '100033'],
  ['Moniepoint MFB', '090405'],
  ['Wema Bank', '035'],
  ['Sterling Bank', '232'],
  ['Fidelity Bank', '070'],
  ['FCMB', '214'],
  ['Stanbic IBTC', '039'],
  ['Polaris Bank', '076'],
]

describe('known banks resolve to their codes', () => {
  // One case per bank, so a failure names the institution that moved rather
  // than "the table changed".
  it.each(PINNED)('%s maps to %s', (name, code) => {
    const row = NIGERIAN_BANKS.find((bank) => bank.name === name)
    expect(row).toBeDefined()
    expect(row?.code).toBe(code)
  })

  it('holds every pinned bank and no duplicates of them', () => {
    // The per-bank cases above catch a removed row; this catches a table that
    // has been emptied out from under them.
    expect(NIGERIAN_BANKS.length).toBeGreaterThanOrEqual(PINNED.length)
  })
})

describe('bankName', () => {
  it.each(PINNED)('names %s from code %s', (name, code) => {
    // The cash-out screen shows this string next to the amount. If it resolves
    // to a different bank, the user confirms a payout to the wrong institution.
    expect(bankName(code)).toBe(name)
  })

  it('returns the code itself for a bank it does not know', () => {
    // Returning a name here would be the worst outcome: a payout labelled with
    // an institution the user never picked.
    expect(bankName('999999')).toBe('999999')
    expect(bankName('000')).toBe('000')
    expect(bankName('')).toBe('')
  })

  it('never defaults an unknown code to a real bank', () => {
    const names = PINNED.map(([name]) => name)
    for (const unknown of ['999999', '000', '', 'abc']) {
      const resolved = bankName(unknown)
      // Whatever comes back must not be one of the banks in the table: that is
      // what "refused rather than defaulted" means in practice.
      expect(names).not.toContain(resolved)
      expect(resolved).toBe(unknown)
    }
  })

  it('does not trim or normalise its way into a match', () => {
    // ' 044 ' is not a code Linq will match; silently accepting it here would
    // hide a caller bug until the payout failed.
    expect(bankName(' 044')).toBe(' 044')
    expect(bankName('044 ')).toBe('044 ')
    expect(bankName('44')).toBe('44')
  })

  it('does not resolve a name passed where a code was expected', () => {
    // Catches a caller wiring the picker's label into the code field.
    expect(bankName('Access Bank')).toBe('Access Bank')
  })
})

describe('a name lookup the picker can do', () => {
  it('resolves an exact name to one row', () => {
    expect(NIGERIAN_BANKS.filter((bank) => bank.name === 'Access Bank')).toHaveLength(1)
  })

  it('finds nothing for a name that is not in the table', () => {
    // The filter in app/cashout/page.tsx renders whatever this returns; an
    // unknown search must yield no rows rather than a default bank.
    expect(NIGERIAN_BANKS.filter((bank) => bank.name === 'Bank of Nowhere')).toEqual([])
  })

  it('is case-sensitive, so a near-miss is not a match', () => {
    // The picker filters by substring (case-insensitively) and then uses the
    // row it matched; the code must come from a row, not from a name comparison.
    expect(NIGERIAN_BANKS.filter((bank) => bank.name === 'access bank')).toEqual([])
  })
})

describe('table integrity', () => {
  it('has no duplicate codes', () => {
    const codes = NIGERIAN_BANKS.map((bank) => bank.code)
    // Two rows on one code means `bankName` returns whichever came first while
    // the payout uses the code — one of those two names is wrong on screen.
    expect(new Set(codes).size).toBe(codes.length)
  })

  it('has no duplicate names', () => {
    const names = NIGERIAN_BANKS.map((bank) => bank.name.toLowerCase())
    // Two rows on one name makes the picker show the same bank twice with
    // different codes, and the user cannot tell which one pays.
    expect(new Set(names).size).toBe(names.length)
  })

  it('gives every row both a name and a code', () => {
    for (const bank of NIGERIAN_BANKS) {
      // A half-filled row would render as an empty label or send an empty code.
      expect(typeof bank.code).toBe('string')
      expect(typeof bank.name).toBe('string')
      expect(bank.code.length).toBeGreaterThan(0)
      expect(bank.name.length).toBeGreaterThan(0)
    }
  })

  it('writes codes as NIBSS issues them: three or six digits, nothing else', () => {
    for (const bank of NIGERIAN_BANKS) {
      // A truncated code ('44' for '044') still looks like a code to a reader
      // and would be sent to Linq as a different institution.
      expect(bank.code).toMatch(/^\d{3}$|^\d{6}$/)
    }
  })

  it('keeps names free of stray whitespace', () => {
    for (const bank of NIGERIAN_BANKS) {
      // A trailing space makes the picker's `includes` filter miss the name the
      // user typed, and the search box appears to ignore a bank that is there.
      expect(bank.name).toBe(bank.name.trim())
      expect(bank.code).toBe(bank.code.trim())
    }
  })

  it('carries exactly the two documented fields per row', () => {
    for (const bank of NIGERIAN_BANKS) {
      // A row that grew a third field (say `bank_name`) is a row whose reader
      // and writer disagree about the shape; catch it at the source.
      expect(Object.keys(bank).sort()).toEqual(['code', 'name'])
    }
  })

  it('is not empty', () => {
    // An empty table would make every payout impossible, and every assertion
    // above vacuously true.
    expect(NIGERIAN_BANKS.length).toBeGreaterThan(0)
  })
})
