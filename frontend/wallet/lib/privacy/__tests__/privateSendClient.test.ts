/**
 * Tests for the #716 private-send client surface (`lib/privacy/client.ts`).
 *
 * These tests assert the integration contract, not chain behaviour: that the
 * client builds the SDK from `getSppConfig()`, that `privateSend` returns the
 * transaction hash `PoolExecuteResult` reports (never `String(result)`), that
 * a non-`ok` execution rejects, and that `recipientLookup` maps the SDK's
 * registry answer onto `RecipientRegistration`. The SDK module is mocked —
 * nothing here touches testnet.
 */

// jsdom omits TextEncoder, which stellar-sdk needs at module load.
import { TextEncoder, TextDecoder } from 'util'
Object.assign(globalThis, { TextEncoder, TextDecoder })

jest.mock(
  'stellar-private-payments',
  () => {
    const pool = {
      balance: jest.fn(),
      deposit: jest.fn(),
      transfer: jest.fn(),
      withdraw: jest.fn(),
    }
    const account = {
      pool: jest.fn(async () => pool),
    }
    const client = {
      sync: jest.fn(),
      recipientLookup: jest.fn(),
      stopBackgroundSync: jest.fn(),
      account: jest.fn(async () => account),
    }
    return {
      Storage: { open: jest.fn(async () => ({})) },
      Client: { new: jest.fn(async () => client) },
      __pool: pool,
      __account: account,
      __client: client,
    }
  },
  { virtual: true },
)

jest.mock('@/lib/feePayer', () => ({
  ensureFeePayer: jest.fn(async () => ({
    publicKey: () => 'GB2VYTFZEVWKPTOEVT64NT7O3KCJAF7FXH4VCTUZDEN5M7QLBVBHNSPM',
    sign: (bytes: Buffer) => Buffer.from(bytes),
  })),
}))

import { StrKey } from '@stellar/stellar-sdk'
import { getPrivacyClient } from '../client'
import { getSppConfig } from '../config'

const sdk = jest.requireMock('stellar-private-payments') as {
  Storage: { open: jest.Mock }
  Client: { new: jest.Mock }
  __pool: {
    balance: jest.Mock
    deposit: jest.Mock
    transfer: jest.Mock
    withdraw: jest.Mock
  }
  __account: { pool: jest.Mock }
  __client: {
    sync: jest.Mock
    recipientLookup: jest.Mock
    stopBackgroundSync: jest.Mock
    account: jest.Mock
  }
}

const REAL_POOL_ID = 'CBEDPYMAEPQ6JR7WKWXRM6CFHHJLKA5RHPRRLSD4UZXZRGNMBXOT2GOT'
const SENDER = 'GB2VYTFZEVWKPTOEVT64NT7O3KCJAF7FXH4VCTUZDEN5M7QLBVBHNSPM'

describe('privacy client — private send integration (V137)', () => {
  beforeEach(() => {
    jest.clearAllMocks()
  })

  it('builds the SDK from the pinned testnet config (config.ts, not literals)', async () => {
    sdk.__pool.balance.mockResolvedValue(1_000_000n)
    const client = await getPrivacyClient()
    await client.privateBalance()

    const contractConfig = sdk.Client.new.mock.calls[0][0].contractConfig
    expect(contractConfig.public_key_registry).toBe(
      'CC6EJCBEULJGHNQQROKLXD6M6IKFW6LN7IHTVUEFQQWZDDLCMNPWXIH4',
    )
    expect(contractConfig.pools[0].poolContractId).toBe(REAL_POOL_ID)
    expect(StrKey.isValidContract(contractConfig.pools[0].poolContractId)).toBe(true)
  })

  it('privateSend returns the transaction hash the SDK reports', async () => {
    const hash = 'a'.repeat(64)
    sdk.__pool.transfer.mockResolvedValue({ status: 'ok', hashes: [hash], code: undefined, message: undefined })
    const client = await getPrivacyClient()

    await expect(client.privateSend(SENDER, 25_000_000n)).resolves.toBe(hash)
    expect(sdk.__pool.transfer.mock.calls[0][0]).toBe(SENDER)
    expect(sdk.__pool.transfer.mock.calls[0][1]).toBe(25_000_000n)
  })

  it('privateSend rejects when the pool execution is not ok', async () => {
    sdk.__pool.transfer.mockResolvedValue({ status: 'failed', hashes: [], code: 1, message: 'rejected' })
    const client = await getPrivacyClient()

    await expect(client.privateSend(SENDER, 1n)).rejects.toThrow('rejected')
  })

  it('recipientLookup maps a registry entry onto registered=true', async () => {
    sdk.__client.recipientLookup.mockResolvedValue({
      entry: { address: 'G…', noteKey: '0xnote', encryptionKey: '0xenc', ledger: 4831700 },
      networkTipLedger: 4831800,
      registryFullySynced: true,
      registryLastFullyIndexedLedger: 4831800,
    })
    const client = await getPrivacyClient()

    await expect(client.recipientLookup(SENDER)).resolves.toEqual({
      registered: true,
      noteKey: '0xnote',
      encryptionKey: '0xenc',
      ledger: 4831700,
      registryFullySynced: true,
    })
  })

  it('recipientLookup maps a missing entry onto registered=false', async () => {
    sdk.__client.recipientLookup.mockResolvedValue({
      entry: undefined,
      networkTipLedger: 4831800,
      registryFullySynced: false,
      registryLastFullyIndexedLedger: 4831700,
    })
    const client = await getPrivacyClient()

    await expect(client.recipientLookup(SENDER)).resolves.toEqual({
      registered: false,
      noteKey: undefined,
      encryptionKey: undefined,
      ledger: undefined,
      registryFullySynced: false,
    })
  })

  it('privateSend targets the pinned pool contract', async () => {
    expect(getSppConfig()?.pools[0].id).toBe(REAL_POOL_ID)
  })
})
