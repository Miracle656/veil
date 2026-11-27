import { TextEncoder, TextDecoder } from 'util'
Object.assign(globalThis, { TextEncoder, TextDecoder })

import { Account, Horizon, Keypair, Networks, TransactionBuilder } from '@stellar/stellar-sdk'

import { USDC_MAINNET_ISSUER, USDC_TESTNET_ISSUER } from '../assets'
import {
  ALREADY_CLAIMED_WEB_MESSAGE,
  EXPIRED_AND_RECLAIMED_WEB_MESSAGE,
  WEB_HISTORY_CHECK_FAILED_MESSAGE,
  claimWebLink,
  inspectWebClaimLink,
  parseClaimLinkNetwork,
  parseClaimSecretFromHash,
  resolveWebClaimAssetVerification,
  retryWebReserveRelease,
  sanitizeInboundClaimNote,
} from '../claimLink'
import { peekFeePayerKeypair } from '../feePayer'
import { inclusionFee } from '../fees'
import { getNetwork, getNetworkName, isNetworkAvailable } from '../network'

jest.mock('../feePayer', () => ({
  peekFeePayerKeypair: jest.fn(),
}))
jest.mock('../fees', () => ({
  inclusionFee: jest.fn(() => '100'),
}))
jest.mock('../network', () => ({
  getNetwork: jest.fn(() => ({
    name: 'testnet',
    displayName: 'Stellar Testnet',
    horizonUrl: 'https://horizon-testnet.stellar.org',
    networkPassphrase: Networks.TESTNET,
  })),
  getNetworkName: jest.fn(() => 'testnet'),
  isNetworkAvailable: jest.fn(() => true),
}))

const mockPeekFeePayer = peekFeePayerKeypair as jest.MockedFunction<typeof peekFeePayerKeypair>
const mockInclusionFee = inclusionFee as jest.MockedFunction<typeof inclusionFee>
const mockGetNetwork = getNetwork as jest.MockedFunction<typeof getNetwork>
const mockGetNetworkName = getNetworkName as jest.MockedFunction<typeof getNetworkName>
const mockIsNetworkAvailable = isNetworkAvailable as jest.MockedFunction<typeof isNetworkAvailable>

const SENDER = Keypair.random()
const EPHEMERAL = Keypair.random()
const FEE_PAYER = Keypair.random()
const FAKE_ISSUER = Keypair.random().publicKey()
const BALANCE_ID = '00000000' + 'ab'.repeat(32)
const NOW_UNIX = 1_760_200_000

function make404() {
  return Object.assign(new Error('Not Found'), {
    name: 'NotFoundError',
    response: { status: 404 },
  })
}

describe('parseClaimSecretFromHash, parseClaimLinkNetwork, and sanitizeInboundClaimNote', () => {
  it('reads #s= from URL fragments without touching query strings', () => {
    expect(parseClaimSecretFromHash(`#s=${encodeURIComponent(EPHEMERAL.secret())}`)).toBe(
      EPHEMERAL.secret(),
    )
    expect(parseClaimSecretFromHash('')).toBeNull()
    expect(parseClaimSecretFromHash('#other=1')).toBeNull()
  })

  it('parses network names strictly', () => {
    expect(parseClaimLinkNetwork('mainnet')).toBe('mainnet')
    expect(parseClaimLinkNetwork('TESTNET')).toBe('testnet')
    expect(parseClaimLinkNetwork('futurenet')).toBeNull()
    expect(parseClaimLinkNetwork(null)).toBeNull()
  })

  it('accepts safe plain-text notes and drops URLs or markup', () => {
    expect(sanitizeInboundClaimNote('For groceries')).toBe('For groceries')
    expect(sanitizeInboundClaimNote('https://evil.example')).toBeNull()
    expect(sanitizeInboundClaimNote('<b>Verify</b>')).toBeNull()
    expect(sanitizeInboundClaimNote('a'.repeat(81))).toBeNull()
  })
})

describe('resolveWebClaimAssetVerification — issuer registry check', () => {
  it('marks native XLM and canonical network USDC as verified, and rejects impostor USDC issuers', () => {
    expect(resolveWebClaimAssetVerification('XLM', null, 'mainnet').isVerifiedAsset).toBe(true)
    expect(
      resolveWebClaimAssetVerification('USDC', USDC_MAINNET_ISSUER, 'mainnet'),
    ).toEqual({
      isVerifiedAsset: true,
      verifiedAssetName: 'USD Coin',
      verifiedIssuerName: 'Circle',
    })
    expect(
      resolveWebClaimAssetVerification('USDC', USDC_TESTNET_ISSUER, 'testnet').isVerifiedAsset,
    ).toBe(true)
    // Testnet USDC issuer on mainnet is NOT verified mainnet USDC.
    expect(
      resolveWebClaimAssetVerification('USDC', USDC_TESTNET_ISSUER, 'mainnet').isVerifiedAsset,
    ).toBe(false)
    // Arbitrary issuer calling itself USDC is unverified.
    expect(resolveWebClaimAssetVerification('USDC', FAKE_ISSUER, 'mainnet')).toEqual({
      isVerifiedAsset: false,
      verifiedAssetName: null,
      verifiedIssuerName: null,
    })
  })
})

describe('inspectWebClaimLink and claimWebLink — single-tx claims, retry sweep, and history-verified states', () => {
  beforeEach(() => {
    jest.clearAllMocks()
    mockInclusionFee.mockReturnValue('100')
    mockGetNetworkName.mockReturnValue('testnet')
    mockIsNetworkAvailable.mockReturnValue(true)
    mockGetNetwork.mockReturnValue({
      name: 'testnet',
      displayName: 'Stellar Testnet',
      horizonUrl: 'https://horizon-testnet.stellar.org',
      networkPassphrase: Networks.TESTNET,
    } as ReturnType<typeof getNetwork>)
    mockPeekFeePayer.mockReturnValue(FEE_PAYER)
  })

  afterEach(() => {
    jest.restoreAllMocks()
  })

  it('distinguishes network_mismatch, not_found, status_unknown, and history-confirmed claimed/reclaimed', async () => {
    // 1. Mainnet link opened on testnet -> network_mismatch, NOT claimed.
    const mismatch = await inspectWebClaimLink(BALANCE_ID, {
      linkNetwork: 'mainnet',
      nowUnix: NOW_UNIX,
    })
    expect(mismatch.status).toBe('network_mismatch')
    if (mismatch.status === 'network_mismatch') {
      expect(mismatch.message).toMatch(/Stellar Mainnet.*Stellar Testnet/)
    }

    // 2. Mistyped ID (404 on balance, no claim op in history) -> not_found, NOT claimed.
    jest.spyOn(Horizon.Server.prototype, 'claimableBalances').mockReturnValue({
      claimableBalance: () => ({
        call: async () => {
          throw make404()
        },
      }),
    } as unknown as ReturnType<Horizon.Server['claimableBalances']>)
    jest.spyOn(Horizon.Server.prototype, 'operations').mockReturnValueOnce({
      forClaimableBalance: () => ({
        order: () => ({
          limit: () => ({
            call: async () => ({ records: [] }),
          }),
        }),
      }),
    } as unknown as ReturnType<Horizon.Server['operations']>)

    const notFound = await inspectWebClaimLink(BALANCE_ID, { nowUnix: NOW_UNIX })
    expect(notFound.status).toBe('not_found')

    // 3. History lookup fails -> status_unknown ("could not be checked").
    jest.spyOn(Horizon.Server.prototype, 'operations').mockReturnValueOnce({
      forClaimableBalance: () => ({
        order: () => ({
          limit: () => ({
            call: async () => {
              throw new Error('502 Bad Gateway')
            },
          }),
        }),
      }),
    } as unknown as ReturnType<Horizon.Server['operations']>)

    const unknown = await inspectWebClaimLink(BALANCE_ID, { nowUnix: NOW_UNIX })
    expect(unknown).toEqual({
      status: 'status_unknown',
      balanceId: BALANCE_ID,
      message: WEB_HISTORY_CHECK_FAILED_MESSAGE,
    })

    // 4. Claim op in history by recipient -> consumed (already claimed).
    jest.spyOn(Horizon.Server.prototype, 'operations').mockReturnValueOnce({
      forClaimableBalance: () => ({
        order: () => ({
          limit: () => ({
            call: async () => ({
              records: [
                { type: 'claim_claimable_balance', claimant: FEE_PAYER.publicKey() },
                { type: 'create_claimable_balance', source_account: SENDER.publicKey() },
              ],
            }),
          }),
        }),
      }),
    } as unknown as ReturnType<Horizon.Server['operations']>)

    const claimed = await inspectWebClaimLink(BALANCE_ID, { nowUnix: NOW_UNIX })
    expect(claimed).toEqual({
      status: 'consumed',
      balanceId: BALANCE_ID,
      reclaimedBySender: false,
      message: ALREADY_CLAIMED_WEB_MESSAGE,
    })

    // 5. Claim op in history by sponsor -> consumed (reclaimed by sender).
    jest.spyOn(Horizon.Server.prototype, 'operations').mockReturnValueOnce({
      forClaimableBalance: () => ({
        order: () => ({
          limit: () => ({
            call: async () => ({
              records: [
                { type: 'claim_claimable_balance', claimant: SENDER.publicKey() },
                { type: 'create_claimable_balance', source_account: SENDER.publicKey() },
              ],
            }),
          }),
        }),
      }),
    } as unknown as ReturnType<Horizon.Server['operations']>)

    const reclaimed = await inspectWebClaimLink(BALANCE_ID, { nowUnix: NOW_UNIX })
    expect(reclaimed).toEqual({
      status: 'consumed',
      balanceId: BALANCE_ID,
      reclaimedBySender: true,
      message: EXPIRED_AND_RECLAIMED_WEB_MESSAGE,
    })
  })

  it('claims and delivers native XLM atomically in Tx 1 via sponsored 0-XLM account (avoiding op_seq_num_too_far) and merges on next ledger', async () => {
    jest.spyOn(Horizon.Server.prototype, 'claimableBalances').mockReturnValueOnce({
      claimableBalance: () => ({
        call: async () => ({
          id: BALANCE_ID,
          asset: 'native',
          amount: '10.0000000',
          sponsor: SENDER.publicKey(),
          claimants: [{ destination: EPHEMERAL.publicKey(), predicate: { unconditional: true } }],
        }),
      }),
    } as unknown as ReturnType<Horizon.Server['claimableBalances']>)

    jest.spyOn(Horizon.Server.prototype, 'loadAccount').mockImplementation(async (pub: string) => {
      if (pub === EPHEMERAL.publicKey()) throw make404()
      const payerAcct = new Account(FEE_PAYER.publicKey(), '700') as unknown as Horizon.AccountResponse
      ;(payerAcct as unknown as { balances: unknown[]; subentry_count: number }).balances = [
        { asset_type: 'native', balance: '25.0000000', selling_liabilities: '0.0000000' },
      ]
      ;(payerAcct as unknown as { subentry_count: number }).subentry_count = 0
      return payerAcct
    })

    const submittedXdrs: string[] = []
    jest.spyOn(Horizon.Server.prototype, 'submitTransaction').mockImplementation(async (tx) => {
      submittedXdrs.push(tx.toXDR())
      return {
        hash: `tx_xlm_${submittedXdrs.length}`,
      } as unknown as Horizon.HorizonApi.SubmitTransactionResponse
    })

    const res = await claimWebLink({
      balanceId: BALANCE_ID,
      ephemeralSecret: EPHEMERAL.secret(),
      linkNetwork: 'testnet',
    })

    expect(submittedXdrs).toHaveLength(2)
    const parsedClaim = TransactionBuilder.fromXDR(submittedXdrs[0], Networks.TESTNET)
    expect(parsedClaim.operations.map((o) => o.type)).toEqual([
      'beginSponsoringFutureReserves',
      'createAccount',
      'endSponsoringFutureReserves',
      'claimClaimableBalance',
      'payment',
    ])
    const parsedMerge = TransactionBuilder.fromXDR(submittedXdrs[1], Networks.TESTNET)
    expect(parsedMerge.operations.map((o) => o.type)).toEqual(['accountMerge'])
    expect(res).toEqual({
      status: 'claimed',
      txHash: 'tx_xlm_1',
      mergeTxHash: 'tx_xlm_2',
      reserveReleased: true,
      reserveReleaseTxHash: 'tx_xlm_2',
      amount: '10.0000000',
      assetCode: 'XLM',
      assetIssuer: null,
      destination: FEE_PAYER.publicKey(),
    })
  })

  it('sponsors a 0-XLM one-time account INSIDE the issued-asset claim+payment tx (zero 1.5 XLM bait-link window, zero op_seq_num_too_far) and merges on next ledger', async () => {
    jest.spyOn(Horizon.Server.prototype, 'claimableBalances').mockReturnValueOnce({
      claimableBalance: () => ({
        call: async () => ({
          id: BALANCE_ID,
          asset: `USDC:${USDC_TESTNET_ISSUER}`,
          amount: '50.0000000',
          sponsor: SENDER.publicKey(),
          claimants: [{ destination: EPHEMERAL.publicKey(), predicate: { unconditional: true } }],
        }),
      }),
    } as unknown as ReturnType<Horizon.Server['claimableBalances']>)

    jest.spyOn(Horizon.Server.prototype, 'loadAccount').mockImplementation(async (pub: string) => {
      if (pub === EPHEMERAL.publicKey()) throw make404()
      const payerAcct = new Account(FEE_PAYER.publicKey(), '800') as unknown as Horizon.AccountResponse
      ;(payerAcct as unknown as { balances: unknown[]; subentry_count: number }).balances = [
        { asset_type: 'native', balance: '25.0000000', selling_liabilities: '0.0000000' },
      ]
      ;(payerAcct as unknown as { subentry_count: number }).subentry_count = 0
      return payerAcct
    })

    const submittedXdrs: string[] = []
    jest.spyOn(Horizon.Server.prototype, 'submitTransaction').mockImplementation(async (tx) => {
      submittedXdrs.push(tx.toXDR())
      return {
        hash: `tx_usdc_${submittedXdrs.length}`,
      } as unknown as Horizon.HorizonApi.SubmitTransactionResponse
    })

    const res = await claimWebLink({
      balanceId: BALANCE_ID,
      ephemeralSecret: EPHEMERAL.secret(),
      linkNetwork: 'testnet',
    })

    expect(submittedXdrs).toHaveLength(2)
    const parsedClaim = TransactionBuilder.fromXDR(submittedXdrs[0], Networks.TESTNET)
    expect(parsedClaim.operations.map((o) => o.type)).toEqual([
      'changeTrust',
      'beginSponsoringFutureReserves',
      'createAccount',
      'changeTrust',
      'endSponsoringFutureReserves',
      'claimClaimableBalance',
      'payment',
      'changeTrust',
    ])
    const parsedMerge = TransactionBuilder.fromXDR(submittedXdrs[1], Networks.TESTNET)
    expect(parsedMerge.operations.map((o) => o.type)).toEqual(['accountMerge'])
    expect(res).toEqual({
      status: 'claimed',
      txHash: 'tx_usdc_1',
      mergeTxHash: 'tx_usdc_2',
      reserveReleased: true,
      reserveReleaseTxHash: 'tx_usdc_2',
      amount: '50.0000000',
      assetCode: 'USDC',
      assetIssuer: USDC_TESTNET_ISSUER,
      destination: FEE_PAYER.publicKey(),
    })
  })

  it('detects a funded one-time account when the balance is already gone and finishes sweeping on retry', async () => {
    jest.spyOn(Horizon.Server.prototype, 'claimableBalances').mockReturnValue({
      claimableBalance: () => ({
        call: async () => {
          throw make404()
        },
      }),
    } as unknown as ReturnType<Horizon.Server['claimableBalances']>)

    jest.spyOn(Horizon.Server.prototype, 'operations').mockReturnValue({
      forClaimableBalance: () => ({
        order: () => ({
          limit: () => ({
            call: async () => ({
              records: [
                { type: 'claim_claimable_balance', claimant: EPHEMERAL.publicKey() },
                { type: 'create_claimable_balance', source_account: SENDER.publicKey() },
              ],
            }),
          }),
        }),
      }),
    } as unknown as ReturnType<Horizon.Server['operations']>)

    jest.spyOn(Horizon.Server.prototype, 'loadAccount').mockImplementation(async (pub: string) => {
      if (pub === EPHEMERAL.publicKey()) {
        const ephAcct = new Account(EPHEMERAL.publicKey(), '12') as unknown as Horizon.AccountResponse
        ;(ephAcct as unknown as { balances: unknown[]; subentry_count: number }).balances = [
          { asset_type: 'native', balance: '11.0000000', selling_liabilities: '0.0000000' },
        ]
        ;(ephAcct as unknown as { subentry_count: number }).subentry_count = 0
        return ephAcct
      }
      const payerAcct = new Account(FEE_PAYER.publicKey(), '900') as unknown as Horizon.AccountResponse
      ;(payerAcct as unknown as { balances: unknown[]; subentry_count: number }).balances = [
        { asset_type: 'native', balance: '5.0000000', selling_liabilities: '0.0000000' },
      ]
      ;(payerAcct as unknown as { subentry_count: number }).subentry_count = 0
      return payerAcct
    })

    let sweepXdr = ''
    jest.spyOn(Horizon.Server.prototype, 'submitTransaction').mockImplementationOnce(async (tx) => {
      sweepXdr = tx.toXDR()
      return { hash: 'tx_retry_sweep' } as unknown as Horizon.HorizonApi.SubmitTransactionResponse
    })

    const res = await claimWebLink({
      balanceId: BALANCE_ID,
      ephemeralSecret: EPHEMERAL.secret(),
      linkNetwork: 'testnet',
    })

    const parsed = TransactionBuilder.fromXDR(sweepXdr, Networks.TESTNET)
    expect(parsed.operations.map((o) => o.type)).toEqual(['accountMerge'])
    expect(res).toEqual({
      status: 'claimed',
      txHash: 'tx_retry_sweep',
      mergeTxHash: 'tx_retry_sweep',
      reserveReleased: true,
      reserveReleaseTxHash: 'tx_retry_sweep',
      amount: '11.0000000',
      assetCode: 'XLM',
      assetIssuer: null,
      destination: FEE_PAYER.publicKey(),
    })
  })

  it('surfaces Tx 2 reserve-release failure instead of hiding it and completes release via retryWebReserveRelease', async () => {
    jest.spyOn(Horizon.Server.prototype, 'claimableBalances').mockReturnValueOnce({
      claimableBalance: () => ({
        call: async () => ({
          id: BALANCE_ID,
          asset: 'native',
          amount: '15.0000000',
          sponsor: SENDER.publicKey(),
          claimants: [{ destination: EPHEMERAL.publicKey(), predicate: { unconditional: true } }],
        }),
      }),
    } as unknown as ReturnType<Horizon.Server['claimableBalances']>)

    jest.spyOn(Horizon.Server.prototype, 'loadAccount').mockImplementation(async (pub: string) => {
      if (pub === EPHEMERAL.publicKey()) throw make404()
      const payerAcct = new Account(FEE_PAYER.publicKey(), '950') as unknown as Horizon.AccountResponse
      ;(payerAcct as unknown as { balances: unknown[]; subentry_count: number }).balances = [
        { asset_type: 'native', balance: '25.0000000', selling_liabilities: '0.0000000' },
      ]
      ;(payerAcct as unknown as { subentry_count: number }).subentry_count = 0
      return payerAcct
    })

    const submitSpy = jest
      .spyOn(Horizon.Server.prototype, 'submitTransaction')
      .mockResolvedValueOnce({
        hash: 'tx_web_delivered',
      } as unknown as Horizon.HorizonApi.SubmitTransactionResponse)
      .mockRejectedValueOnce(new Error('Horizon 504 on accountMerge'))
      .mockResolvedValueOnce({
        hash: 'tx_web_merge_retry',
      } as unknown as Horizon.HorizonApi.SubmitTransactionResponse)

    const outcome = await claimWebLink({
      balanceId: BALANCE_ID,
      ephemeralSecret: EPHEMERAL.secret(),
      linkNetwork: 'testnet',
    })

    expect(outcome).toEqual({
      status: 'claimed',
      txHash: 'tx_web_delivered',
      mergeTxHash: null,
      reserveReleased: false,
      reserveReleaseError: 'Horizon 504 on accountMerge',
      amount: '15.0000000',
      assetCode: 'XLM',
      assetIssuer: null,
      destination: FEE_PAYER.publicKey(),
    })

    const retry = await retryWebReserveRelease({ ephemeralSecret: EPHEMERAL.secret() })
    expect(retry).toEqual({
      released: true,
      txHash: 'tx_web_merge_retry',
    })
    expect(submitSpy).toHaveBeenCalledTimes(3)
  })
})
