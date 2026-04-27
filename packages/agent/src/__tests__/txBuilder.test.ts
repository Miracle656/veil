import { jest, describe, it, expect, beforeEach } from '@jest/globals'

// ── Shared mock state ─────────────────────────────────────────────────────────
// Declared before unstable_mockModule so the factory closure captures them.

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const mockToXDR: any = jest.fn().mockReturnValue('mock-xdr-string')
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const mockBuild: any = jest.fn()
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const mockSetTimeout: any = jest.fn()
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const mockAddMemo: any = jest.fn()
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const mockAddOperation: any = jest.fn()

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const mockTxInstance: any = {
  addOperation: mockAddOperation,
  addMemo: mockAddMemo,
  setTimeout: mockSetTimeout,
  build: mockBuild,
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const mockLoadAccount: any = jest.fn()
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const mockOperationPayment: any = jest.fn()
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const mockOperationPathPayment: any = jest.fn()
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const mockOperationChangeTrust: any = jest.fn()

// ── ESM mock (must precede dynamic import of txBuilder) ───────────────────────

jest.unstable_mockModule('@stellar/stellar-sdk', () => {
  const nativeAsset = {
    isNative: () => true,
    getCode: () => 'XLM',
    getIssuer: () => '',
  }

  function AssetConstructor(code: string, issuer: string) {
    return { isNative: () => false, getCode: () => code, getIssuer: () => issuer }
  }
  (AssetConstructor as any).native = () => nativeAsset

  return {
    Horizon: {
      Server: jest.fn().mockImplementation(() => ({ loadAccount: mockLoadAccount })),
    },
    TransactionBuilder: jest.fn().mockImplementation(() => mockTxInstance),
    Networks: {
      TESTNET: 'Test SDF Network ; September 2015',
      PUBLIC: 'Public Global Stellar Network ; September 2015',
    },
    Operation: {
      payment: mockOperationPayment,
      pathPaymentStrictSend: mockOperationPathPayment,
      changeTrust: mockOperationChangeTrust,
    },
    Asset: AssetConstructor,
    BASE_FEE: '100',
    rpc: { Server: jest.fn() },
    Contract: jest.fn(),
    Account: jest.fn(),
    Keypair: { random: jest.fn().mockReturnValue({ publicKey: () => 'GRANDOM' }) },
    nativeToScVal: jest.fn(),
    scValToNative: jest.fn(),
  }
})

// Dynamic import AFTER mock registration so txBuilder receives the mock
const { buildPayment, buildSwap } = await import('../txBuilder.js')
import type { PaymentInput, SwapInput } from '../txBuilder.js'

// ── Helpers ───────────────────────────────────────────────────────────────────

function resetChain() {
  mockAddOperation.mockReturnValue(mockTxInstance)
  mockAddMemo.mockReturnValue(mockTxInstance)
  mockSetTimeout.mockReturnValue(mockTxInstance)
  mockBuild.mockReturnValue({ toXDR: mockToXDR })
  mockToXDR.mockReturnValue('mock-xdr-string')
}

function makeAccount(balances: object[] = [{ asset_type: 'native', balance: '100.0000000' }]) {
  return { id: 'GTEST', balances }
}

// ── buildPayment ──────────────────────────────────────────────────────────────

describe('buildPayment', () => {
  beforeEach(() => {
    jest.clearAllMocks()
    resetChain()
    mockLoadAccount.mockResolvedValue(makeAccount())
  })

  it('returns an XDR string', async () => {
    const input: PaymentInput = { to_address: 'GDEST', asset: 'XLM', amount: 10, wallet_address: 'GSOURCE' }
    expect(await buildPayment(input)).toBe('mock-xdr-string')
  })

  it('passes the correct destination to Operation.payment', async () => {
    const input: PaymentInput = { to_address: 'GDEST123', asset: 'XLM', amount: 5, wallet_address: 'GSOURCE' }
    await buildPayment(input)
    expect(mockOperationPayment).toHaveBeenCalledWith(
      expect.objectContaining({ destination: 'GDEST123' }),
    )
  })

  it('formats amount to 7 decimal places', async () => {
    const input: PaymentInput = { to_address: 'GDEST', asset: 'XLM', amount: 1.5, wallet_address: 'GSOURCE' }
    await buildPayment(input)
    expect(mockOperationPayment).toHaveBeenCalledWith(
      expect.objectContaining({ amount: '1.5000000' }),
    )
  })

  it('adds text memo when memo is provided', async () => {
    const input: PaymentInput = { to_address: 'GDEST', asset: 'XLM', amount: 1, wallet_address: 'GSOURCE', memo: 'hello' }
    await buildPayment(input)
    expect(mockAddMemo).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'text', value: 'hello' }),
    )
  })

  it('does not add memo when memo is absent', async () => {
    const input: PaymentInput = { to_address: 'GDEST', asset: 'XLM', amount: 1, wallet_address: 'GSOURCE' }
    await buildPayment(input)
    expect(mockAddMemo).not.toHaveBeenCalled()
  })

  it('sets a 180-second timeout', async () => {
    const input: PaymentInput = { to_address: 'GDEST', asset: 'XLM', amount: 1, wallet_address: 'GSOURCE' }
    await buildPayment(input)
    expect(mockSetTimeout).toHaveBeenCalledWith(180)
  })

  it('loads the source account via wallet_address', async () => {
    const input: PaymentInput = { to_address: 'GDEST', asset: 'XLM', amount: 1, wallet_address: 'GMYWALLET' }
    await buildPayment(input)
    expect(mockLoadAccount).toHaveBeenCalledWith('GMYWALLET')
  })

  it('throws when Horizon rejects (invalid wallet_address)', async () => {
    mockLoadAccount.mockRejectedValueOnce(new Error('Account not found'))
    const input: PaymentInput = { to_address: 'GDEST', asset: 'XLM', amount: 1, wallet_address: 'GINVALID' }
    await expect(buildPayment(input)).rejects.toThrow('Account not found')
  })
})

// ── buildSwap ─────────────────────────────────────────────────────────────────

describe('buildSwap', () => {
  beforeEach(() => {
    jest.clearAllMocks()
    resetChain()
    mockLoadAccount.mockResolvedValue(makeAccount())
  })

  it('returns an XDR string', async () => {
    const input: SwapInput = { from_asset: 'XLM', to_asset: 'XLM', amount: 10, wallet_address: 'GSOURCE' }
    expect(await buildSwap(input)).toBe('mock-xdr-string')
  })

  it('adds a pathPaymentStrictSend operation', async () => {
    const input: SwapInput = { from_asset: 'XLM', to_asset: 'XLM', amount: 5, wallet_address: 'GSOURCE' }
    await buildSwap(input)
    expect(mockOperationPathPayment).toHaveBeenCalled()
  })

  it('formats sendAmount to 7 decimal places', async () => {
    const input: SwapInput = { from_asset: 'XLM', to_asset: 'XLM', amount: 3.14, wallet_address: 'GSOURCE' }
    await buildSwap(input)
    expect(mockOperationPathPayment).toHaveBeenCalledWith(
      expect.objectContaining({ sendAmount: '3.1400000' }),
    )
  })

  it('defaults destMin to amount * 0.995 when min_received is absent', async () => {
    const input: SwapInput = { from_asset: 'XLM', to_asset: 'XLM', amount: 100, wallet_address: 'GSOURCE' }
    await buildSwap(input)
    expect(mockOperationPathPayment).toHaveBeenCalledWith(
      expect.objectContaining({ destMin: (100 * 0.995).toFixed(7) }),
    )
  })

  it('uses explicit min_received as destMin', async () => {
    const input: SwapInput = { from_asset: 'XLM', to_asset: 'XLM', amount: 100, min_received: 95, wallet_address: 'GSOURCE' }
    await buildSwap(input)
    expect(mockOperationPathPayment).toHaveBeenCalledWith(
      expect.objectContaining({ destMin: '95.0000000' }),
    )
  })

  it('prepends changeTrust when destination asset trustline is missing', async () => {
    mockLoadAccount.mockResolvedValueOnce(makeAccount([]))
    const input: SwapInput = { from_asset: 'XLM', to_asset: 'USDC:GUSDC_ISSUER', amount: 10, wallet_address: 'GSOURCE' }
    await buildSwap(input)
    expect(mockOperationChangeTrust).toHaveBeenCalled()
  })

  it('does not prepend changeTrust when account already holds the destination asset', async () => {
    mockLoadAccount.mockResolvedValueOnce(makeAccount([
      { asset_type: 'credit_alphanum4', asset_code: 'USDC', asset_issuer: 'GUSDC_ISSUER', balance: '0.0000000' },
    ]))
    const input: SwapInput = { from_asset: 'XLM', to_asset: 'USDC:GUSDC_ISSUER', amount: 10, wallet_address: 'GSOURCE' }
    await buildSwap(input)
    expect(mockOperationChangeTrust).not.toHaveBeenCalled()
  })

  it('does not prepend changeTrust for native XLM destination', async () => {
    mockLoadAccount.mockResolvedValueOnce(makeAccount([]))
    const input: SwapInput = { from_asset: 'XLM', to_asset: 'XLM', amount: 10, wallet_address: 'GSOURCE' }
    await buildSwap(input)
    expect(mockOperationChangeTrust).not.toHaveBeenCalled()
  })

  it('sets a 180-second timeout', async () => {
    const input: SwapInput = { from_asset: 'XLM', to_asset: 'XLM', amount: 1, wallet_address: 'GSOURCE' }
    await buildSwap(input)
    expect(mockSetTimeout).toHaveBeenCalledWith(180)
  })

  it('throws for malformed asset string (missing issuer)', async () => {
    const input: SwapInput = { from_asset: 'BADTOKEN', to_asset: 'XLM', amount: 1, wallet_address: 'GSOURCE' }
    await expect(buildSwap(input)).rejects.toThrow(/"BADTOKEN" must be "CODE:ISSUER"/)
  })

  it('throws when Horizon rejects (invalid wallet_address)', async () => {
    mockLoadAccount.mockRejectedValueOnce(new Error('Account not found'))
    const input: SwapInput = { from_asset: 'XLM', to_asset: 'XLM', amount: 1, wallet_address: 'GINVALID' }
    await expect(buildSwap(input)).rejects.toThrow('Account not found')
  })
})
