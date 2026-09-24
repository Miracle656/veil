if (typeof TextEncoder === 'undefined') {
  const { TextEncoder: TE, TextDecoder: TD } = require('util')
  global.TextEncoder = TE
  global.TextDecoder = TD
}

import { Keypair, xdr } from '@stellar/stellar-sdk'
import { checkPrivacyEnrollment, enrollPrivacyKey } from '../enrollment'
import { derivePrivacyPublicKeyFromSecret } from '../keys'

const PRIVACY_FLAG_VAR = 'NEXT_PUBLIC_PRIVACY_FEATURE_FLAG'

describe('privacy key enrollment (V136, #798)', () => {
  const kp = Keypair.random()
  const address = kp.publicKey()
  const secret = kp.secret()
  const expectedKey = derivePrivacyPublicKeyFromSecret(secret)

  const mockServer = {
    getAccount: jest.fn().mockResolvedValue({
      accountId: () => kp.publicKey(),
      sequenceNumber: () => '0',
      incrementSequenceNumber: () => {},
    }),
    simulateTransaction: jest.fn().mockResolvedValue({
      status: 'SUCCESS',
      cost: { cpuInsns: '0', memBytes: '0' },
      latestLedger: 100,
      events: [],
      minResourceFee: '0',
    }),
  }

  beforeEach(() => {
    process.env[PRIVACY_FLAG_VAR] = '1'
    if (typeof localStorage !== 'undefined') localStorage.clear()
    jest.clearAllMocks()
  })

  afterEach(() => {
    delete process.env[PRIVACY_FLAG_VAR]
    if (typeof localStorage !== 'undefined') localStorage.clear()
  })

  it('refuses to enrol when privacy feature flag is off', async () => {
    delete process.env[PRIVACY_FLAG_VAR]

    const result = await enrollPrivacyKey({
      address,
      signerSecret: secret,
      network: 'testnet',
      server: mockServer,
    })

    expect(result.success).toBe(false)
    expect(result.error).toMatch(/disabled/i)
    expect(result.alreadyEnrolled).toBe(false)

    const check = await checkPrivacyEnrollment({ address, network: 'testnet', server: mockServer })
    expect(check.enrolled).toBe(false)
  })

  it('refuses to enrol on mainnet (privacy is testnet-only)', async () => {
    process.env[PRIVACY_FLAG_VAR] = '1'

    const result = await enrollPrivacyKey({
      address,
      signerSecret: secret,
      network: 'mainnet',
      server: mockServer,
    })

    expect(result.success).toBe(false)
    expect(result.error).toMatch(/disabled/i)
  })

  it('enrols a fresh wallet successfully', async () => {
    const result = await enrollPrivacyKey({
      address,
      signerSecret: secret,
      network: 'testnet',
      server: mockServer,
    })

    expect(result.success).toBe(true)
    expect(result.alreadyEnrolled).toBe(false)
    expect(result.privacyPublicKey).toBe(expectedKey)

    const check = await checkPrivacyEnrollment({
      address,
      network: 'testnet',
      server: mockServer,
    })
    expect(check.enrolled).toBe(true)
    expect(check.privacyPublicKey).toBe(expectedKey)
  })

  it('second enrolment is a no-op (idempotent)', async () => {
    const first = await enrollPrivacyKey({
      address,
      signerSecret: secret,
      network: 'testnet',
      server: mockServer,
    })
    expect(first.success).toBe(true)
    expect(first.alreadyEnrolled).toBe(false)

    // Second run
    const second = await enrollPrivacyKey({
      address,
      signerSecret: secret,
      network: 'testnet',
      server: mockServer,
    })
    expect(second.success).toBe(true)
    expect(second.alreadyEnrolled).toBe(true)
    expect(second.txHash).toBeNull()
  })

  it('detects existing registration when wallet is restored on a new device (simulated on-chain)', async () => {
    // Empty local storage simulating a fresh device
    if (typeof localStorage !== 'undefined') localStorage.clear()

    const onChainMockServer = {
      ...mockServer,
      simulateTransaction: jest.fn().mockResolvedValue({
        status: 'SUCCESS',
        result: {
          retval: xdr.ScVal.scvBytes(Buffer.from(expectedKey, 'hex')),
        },
        cost: { cpuInsns: '0', memBytes: '0' },
        latestLedger: 100,
        events: [],
        minResourceFee: '0',
      }),
    }

    const status = await checkPrivacyEnrollment({
      address,
      expectedPublicKey: expectedKey,
      network: 'testnet',
      server: onChainMockServer,
    })

    expect(status.enrolled).toBe(true)
    expect(status.privacyPublicKey).toBe(expectedKey)
    expect(status.onChain).toBe(true)

    // And subsequent enroll call recognizes it as already enrolled without writing
    const enrol = await enrollPrivacyKey({
      address,
      signerSecret: secret,
      network: 'testnet',
      server: onChainMockServer,
    })
    expect(enrol.success).toBe(true)
    expect(enrol.alreadyEnrolled).toBe(true)
    expect(enrol.txHash).toBeNull()
  })
})
