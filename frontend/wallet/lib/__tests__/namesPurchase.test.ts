/**
 * @jest-environment node
 */

import {
  MAINNET_NAMES_CONTRACT_ID,
  TESTNET_NAMES_CONTRACT_ID,
  namesContractIdFor,
} from '../namesContractId'
import {
  NAME_ERROR_MESSAGES,
  formatUsdc,
  interpretOpenNameFailure,
  nameErrorMessage,
} from '../namesPurchase'

describe('namesContractIdFor', () => {
  const saved = { ...process.env }
  afterEach(() => {
    process.env = { ...saved }
  })

  function clear() {
    delete process.env.NEXT_PUBLIC_NAMES_CONTRACT_ID
    delete process.env.NEXT_PUBLIC_NAMES_CONTRACT_ID_MAINNET
    delete process.env.NEXT_PUBLIC_NAMES_CONTRACT_ID_TESTNET
  }

  it('resolves mainnet from the baked-in default, so a fresh clone works', () => {
    clear()
    expect(namesContractIdFor('mainnet')).toBe(MAINNET_NAMES_CONTRACT_ID)
  })

  it('has the deployed address, in full', () => {
    // Never a shortened id: a truncated contract address that looks right is
    // how funds reach somewhere nobody intended.
    expect(MAINNET_NAMES_CONTRACT_ID).toBe(
      'CA7BWBV2L67YVIZWJKLYT3RRCTFCZPN6L5SXYQ4YELWP56E34JFNOEP4',
    )
    expect(MAINNET_NAMES_CONTRACT_ID).toMatch(/^C[A-Z2-7]{55}$/)
  })

  it('has no testnet default, because that deployment is a rehearsal', () => {
    clear()
    expect(TESTNET_NAMES_CONTRACT_ID).toBeNull()
    expect(namesContractIdFor('testnet')).toBeNull()
  })

  it('lets a per-network variable win over the default', () => {
    clear()
    process.env.NEXT_PUBLIC_NAMES_CONTRACT_ID_MAINNET = 'COVERRIDE'
    expect(namesContractIdFor('mainnet')).toBe('COVERRIDE')
  })

  it('lets the shared variable supply a testnet address', () => {
    clear()
    process.env.NEXT_PUBLIC_NAMES_CONTRACT_ID = 'CSHARED'
    expect(namesContractIdFor('testnet')).toBe('CSHARED')
  })

  it('prefers the per-network variable over the shared one', () => {
    clear()
    process.env.NEXT_PUBLIC_NAMES_CONTRACT_ID = 'CSHARED'
    process.env.NEXT_PUBLIC_NAMES_CONTRACT_ID_MAINNET = 'CSPECIFIC'
    expect(namesContractIdFor('mainnet')).toBe('CSPECIFIC')
  })

  it('treats a blank variable as unset rather than as an address', () => {
    clear()
    process.env.NEXT_PUBLIC_NAMES_CONTRACT_ID_TESTNET = '   '
    expect(namesContractIdFor('testnet')).toBeNull()
  })
})

describe('formatUsdc', () => {
  it('renders whole amounts without a decimal point', () => {
    expect(formatUsdc(50_000_000n)).toBe('5')
    expect(formatUsdc(30_000_000n)).toBe('3')
    expect(formatUsdc(150_000_000n)).toBe('15')
  })

  it('renders zero', () => {
    expect(formatUsdc(0n)).toBe('0')
  })

  it('trims trailing zeros but keeps significant decimals', () => {
    expect(formatUsdc(50_500_000n)).toBe('5.05')
    expect(formatUsdc(1n)).toBe('0.0000001')
  })

  it('does not lose precision on large amounts', () => {
    // Number() would start rounding here; the maths is all BigInt.
    expect(formatUsdc(123_456_789_012_345_678n)).toBe('12345678901.2345678')
  })
})

describe('nameErrorMessage', () => {
  it('turns a contract error code into something a buyer can act on', () => {
    const msg = nameErrorMessage(new Error('HostError: ... Error(Contract, #9) ... diagnostics'))
    expect(msg).toBe(NAME_ERROR_MESSAGES[9])
    expect(msg).toContain('already holds that name')
  })

  it('distinguishes reserved from taken, because only one can ever change', () => {
    expect(nameErrorMessage(new Error('Error(Contract, #7)'))).toContain('reserved')
    expect(nameErrorMessage(new Error('Error(Contract, #9)'))).toContain('already holds')
  })

  it('explains the recovery window rather than saying "taken"', () => {
    const msg = nameErrorMessage(new Error('Error(Contract, #10)'))
    expect(msg).toContain('90-day recovery window')
    expect(msg).toContain('previous holder')
  })

  it('returns null for an error carrying no contract code', () => {
    // The caller shows its own message rather than inventing a meaning.
    expect(nameErrorMessage(new Error('Network request failed'))).toBeNull()
    expect(nameErrorMessage(new Error('WebAuthn signing was cancelled'))).toBeNull()
  })

  it('returns null for an unmapped contract code instead of guessing', () => {
    expect(nameErrorMessage(new Error('Error(Contract, #999)'))).toBeNull()
  })

  it('survives a non-Error being thrown', () => {
    expect(nameErrorMessage('Error(Contract, #7)')).toContain('reserved')
    expect(nameErrorMessage(null)).toBeNull()
    expect(nameErrorMessage(undefined)).toBeNull()
  })

  it('covers every code the contract can panic with on a purchase path', () => {
    // Mirrors the Error enum in contracts/veil-names/src/lib.rs. NotAdmin (12)
    // is deliberately absent: require_auth fails before it can be emitted, so
    // mapping it would be dead copy.
    for (const code of [3, 4, 5, 6, 7, 8, 9, 10, 13]) {
      expect(NAME_ERROR_MESSAGES[code]).toBeTruthy()
    }
  })
})

describe('interpretOpenNameFailure', () => {
  // These run only for a name `state()` has already reported as Open, which is
  // what makes the SAC codes unambiguous.

  it('reads the codes veil-names raises before the transfer', () => {
    expect(interpretOpenNameFailure('3')).toBe('invalid') // too short
    expect(interpretOpenNameFailure('4')).toBe('invalid') // too long
    expect(interpretOpenNameFailure('5')).toBe('invalid') // charset
    expect(interpretOpenNameFailure('6')).toBe('invalid') // separator
    expect(interpretOpenNameFailure('8')).toBe('invalid') // term
    expect(interpretOpenNameFailure('7')).toBe('reserved')
  })

  // The bug this exists for: `register` calls the USDC SAC, and the two
  // contracts number their errors independently. Reading a code without
  // knowing which contract raised it told somebody a name nobody has ever
  // owned had "lapsed recently", and that only its previous holder could take
  // it back.
  it('never reports a SAC failure as a veil-names state', () => {
    // SAC BalanceError is 10; veil-names InRecovery is also 10.
    expect(interpretOpenNameFailure('10')).toBe('insufficient_funds')
    expect(interpretOpenNameFailure('10')).not.toBe('in_recovery')

    // SAC TrustlineMissingError is 13; veil-names TermTooLong is also 13.
    expect(interpretOpenNameFailure('13')).toBe('insufficient_funds')

    // veil-names NameTaken is 9, impossible once state() says Open.
    expect(interpretOpenNameFailure('9')).toBe('insufficient_funds')
    expect(interpretOpenNameFailure('9')).not.toBe('taken')
  })

  it('treats an unreadable failure as the buyer being unable to pay', () => {
    // Open means nothing in veil-names can still refuse, so the transfer is
    // the only step left that can fail.
    expect(interpretOpenNameFailure(undefined)).toBe('insufficient_funds')
    expect(interpretOpenNameFailure('999')).toBe('insufficient_funds')
  })
})
