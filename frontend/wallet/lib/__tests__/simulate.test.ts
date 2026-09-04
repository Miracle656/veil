// @stellar/stellar-sdk needs TextEncoder at module load; jsdom omits it.
import { TextEncoder, TextDecoder } from 'util'
Object.assign(globalThis, { TextEncoder, TextDecoder })

import {
  Account,
  Address,
  Asset,
  BASE_FEE,
  Contract,
  Keypair,
  Networks,
  Operation,
  StrKey,
  TransactionBuilder,
  nativeToScVal,
  xdr,
} from '@stellar/stellar-sdk'
import {
  buildSwapPreview,
  decodeTransfers,
  extractInvocation,
  formatAmount,
  previewTransaction,
  type ContractInvocation,
  type DecodedEvent,
  type SimulateCapable,
} from '../simulate'

const NETWORK = Networks.TESTNET

function randomAddress(): string {
  return Keypair.random().publicKey()
}

function buildInvokeXdr(
  contractId: string,
  fn: string,
  args: xdr.ScVal[],
): string {
  const source = new Account(randomAddress(), '0')
  return new TransactionBuilder(source, { fee: BASE_FEE, networkPassphrase: NETWORK })
    .addOperation(new Contract(contractId).call(fn, ...args))
    .setTimeout(30)
    .build()
    .toXDR()
}

/** A fake RPC server that always returns the supplied simulation response. */
function fakeServer(sim: unknown): SimulateCapable {
  return { simulateTransaction: async () => sim as never }
}

// Generated at runtime so no Stellar-format string literal is committed.
const TOKEN = StrKey.encodeContract(Buffer.alloc(32, 7))

describe('formatAmount', () => {
  it('applies decimals and trims trailing zeros', () => {
    expect(formatAmount(123456789n, 7)).toBe('12.3456789')
    expect(formatAmount(50_000_000n, 7)).toBe('5')
    expect(formatAmount(1n, 7)).toBe('0.0000001')
    expect(formatAmount(0n, 7)).toBe('0')
  })

  it('handles negatives and zero-decimal tokens', () => {
    expect(formatAmount(-2500000n, 7)).toBe('-0.25')
    expect(formatAmount(42n, 0)).toBe('42')
  })
})

describe('extractInvocation', () => {
  it('reads contract id, function name and args from an invoke op', () => {
    const args = [
      new Address(randomAddress()).toScVal(),
      new Address(randomAddress()).toScVal(),
      nativeToScVal(123n, { type: 'i128' }),
    ]
    const tx = TransactionBuilder.fromXDR(buildInvokeXdr(TOKEN, 'transfer', args), NETWORK)

    const invocation = extractInvocation(tx)
    expect(invocation?.contractId).toBe(TOKEN)
    expect(invocation?.functionName).toBe('transfer')
    expect(invocation?.args).toHaveLength(3)
  })

  it('returns null for non-Soroban operations', () => {
    const source = new Account(randomAddress(), '0')
    const tx = new TransactionBuilder(source, { fee: BASE_FEE, networkPassphrase: NETWORK })
      .addOperation(
        Operation.payment({
          destination: randomAddress(),
          asset: Asset.native(),
          amount: '1',
        }),
      )
      .setTimeout(30)
      .build()

    expect(extractInvocation(tx)).toBeNull()
  })
})

describe('decodeTransfers', () => {
  it('extracts SAC transfer amount from raw i128 data', () => {
    const events: DecodedEvent[] = [
      {
        type: 'contract',
        contractId: TOKEN,
        topics: ['transfer', 'GFROM', 'GTO'],
        data: 500000000n,
      },
    ]
    const [transfer] = decodeTransfers(events)
    expect(transfer.token).toBe(TOKEN)
    expect(transfer.from).toBe('GFROM')
    expect(transfer.to).toBe('GTO')
    expect(transfer.amount).toBe(500000000n)
    // amount + decimals shown to the user
    expect(formatAmount(transfer.amount, 7)).toBe('50')
  })

  it('extracts amount from protocol-22 map-form data', () => {
    const events: DecodedEvent[] = [
      { type: 'contract', contractId: TOKEN, topics: ['transfer', 'GA', 'GB'], data: { amount: 250n } },
    ]
    expect(decodeTransfers(events)[0].amount).toBe(250n)
  })

  it('ignores non-transfer events', () => {
    const events: DecodedEvent[] = [
      { type: 'contract', contractId: TOKEN, topics: ['mint', 'GA'], data: 1n },
    ]
    expect(decodeTransfers(events)).toHaveLength(0)
  })
})

describe('buildSwapPreview', () => {
  it('surfaces the slippage floor (min receive) and simulated estimate', () => {
    const invocation: ContractInvocation = {
      contractId: TOKEN,
      functionName: 'swap_exact_tokens_for_tokens',
      args: [
        nativeToScVal(500000000n, { type: 'i128' }), // amount_in
        nativeToScVal(510000000n, { type: 'i128' }), // amount_out_min
      ],
    }
    const swap = buildSwapPreview(invocation, [500000000n, 512000000n], 7)
    expect(swap?.minReceiveDisplay).toBe('51')
    expect(swap?.estimatedReceiveDisplay).toBe('51.2')
  })

  it('returns null for non-swap functions', () => {
    const invocation: ContractInvocation = { contractId: TOKEN, functionName: 'transfer', args: [] }
    expect(buildSwapPreview(invocation, null, 7)).toBeNull()
  })
})

describe('previewTransaction', () => {
  it('hard-blocks when simulation reports an error', async () => {
    const xdrStr = buildInvokeXdr(TOKEN, 'transfer', [nativeToScVal(1n, { type: 'i128' })])
    const result = await previewTransaction({
      xdr: xdrStr,
      networkPassphrase: NETWORK,
      server: fakeServer({ error: 'contract trapped', events: [] }),
    })

    expect(result.status).toBe('blocked')
    if (result.status === 'blocked') {
      expect(result.error).toBe('contract trapped')
    }
  })

  it('hard-blocks on malformed XDR without calling the network', async () => {
    let called = false
    const result = await previewTransaction({
      xdr: 'not-valid-xdr',
      networkPassphrase: NETWORK,
      server: { simulateTransaction: async () => { called = true; return {} as never } },
    })

    expect(result.status).toBe('blocked')
    expect(called).toBe(false)
  })

  it('builds a ready swap preview with min-receive from a successful simulation', async () => {
    const xdrStr = buildInvokeXdr(TOKEN, 'swap_exact_tokens_for_tokens', [
      nativeToScVal(500000000n, { type: 'i128' }),
      nativeToScVal(510000000n, { type: 'i128' }),
    ])
    const retval = xdr.ScVal.scvVec([
      nativeToScVal(500000000n, { type: 'i128' }),
      nativeToScVal(512000000n, { type: 'i128' }),
    ])
    const result = await previewTransaction({
      xdr: xdrStr,
      networkPassphrase: NETWORK,
      server: fakeServer({ events: [], minResourceFee: '1250000', result: { retval } }),
    })

    expect(result.status).toBe('ready')
    if (result.status === 'ready') {
      expect(result.functionName).toBe('swap_exact_tokens_for_tokens')
      expect(result.swap?.minReceiveDisplay).toBe('51')
      expect(result.swap?.estimatedReceiveDisplay).toBe('51.2')
      expect(result.feeStroops).toBe('1250000')
    }
  })
})
