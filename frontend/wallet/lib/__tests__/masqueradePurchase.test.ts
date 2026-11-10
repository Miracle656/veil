/**
 * @jest-environment node
 */

import { masqueradeErrorMessage } from '../masqueradePurchase'

const COLLECTION = 'CDUS5S3AENE5QREEHCIEHGKMP6LMBDELUYB35ZSFYETXETN2674MXQHK'
const USDC_SAC = 'CCW67TSZV3SSS2HXMBQ5JFGCKJNXKZM7UQUWUZPUTHXSTZLEO7SJMI75'
const A_WALLET = 'CA7BWBV2L67YVIZWJKLYT3RRCTFCZPN6L5SXYQ4YELWP56E34JFNOEP4'

describe('masqueradeErrorMessage', () => {
  it('reads the collection’s own codes', () => {
    expect(
      masqueradeErrorMessage(new Error(`host error: Error(Contract, #4) in ${COLLECTION}`), COLLECTION),
    ).toMatch(/already bought that figure/)

    expect(
      masqueradeErrorMessage(new Error(`host error: Error(Contract, #5) in ${COLLECTION}`), COLLECTION),
    ).toMatch(/need a Veil name/)

    expect(
      masqueradeErrorMessage(new Error(`host error: Error(Contract, #3) in ${COLLECTION}`), COLLECTION),
    ).toMatch(/numbered 1 to 20/)
  })

  it('refuses to read a code that came from another contract', () => {
    // The whole point. A `buy` runs code in three contracts and they all number
    // their errors from 1. The USDC SAC's #4 is not AlreadySold, and telling a
    // buyer "somebody already bought that figure" when the real problem is
    // their balance sends them away from the thing they can fix.
    expect(
      masqueradeErrorMessage(new Error(`host error: Error(Contract, #4) in ${USDC_SAC}`), COLLECTION),
    ).toBeNull()

    expect(
      masqueradeErrorMessage(new Error(`host error: Error(Contract, #5) in ${A_WALLET}`), COLLECTION),
    ).toBeNull()
  })

  it('reads the code when the collection is one of several contracts named', () => {
    // A failure frame often lists the whole call stack. The collection being in
    // it is what makes the code ours.
    const err = new Error(
      `invokeHostFunction: Error(Contract, #4), contracts: ${A_WALLET}, ${COLLECTION}`,
    )
    expect(masqueradeErrorMessage(err, COLLECTION)).toMatch(/already bought/)
  })

  it('returns null rather than guess when there is no code', () => {
    expect(masqueradeErrorMessage(new Error('Transaction timed out'), COLLECTION)).toBeNull()
    expect(masqueradeErrorMessage(new Error('Simulation failed: ???'), COLLECTION)).toBeNull()
    expect(masqueradeErrorMessage(null, COLLECTION)).toBeNull()
  })

  it('returns null for a code the collection does not define', () => {
    // #10 is the SAC's BalanceError and #13 its TrustlineMissingError. Neither
    // means anything here, and inventing a meaning is how the names page once
    // told buyers a free name was taken.
    expect(
      masqueradeErrorMessage(new Error(`Error(Contract, #10) in ${COLLECTION}`), COLLECTION),
    ).toBeNull()
    expect(
      masqueradeErrorMessage(new Error(`Error(Contract, #13) in ${COLLECTION}`), COLLECTION),
    ).toBeNull()
  })

  it('still reads a code when no contract is named at all', () => {
    // Some frames carry only the code. Refusing every one of those would leave
    // the common failures unexplained; the risk is accepted knowingly here and
    // not in the case above, where there is positive evidence of another
    // contract.
    expect(masqueradeErrorMessage(new Error('Error(Contract, #5)'), COLLECTION)).toMatch(
      /need a Veil name/,
    )
  })
})

