/**
 * @jest-environment node
 *
 * What a contract call asks a person to approve, and what Veil refuses.
 *
 * Every address here is made up in the test: contract ids from fixed filler
 * bytes, accounts from throw-away keys. The XDR is built with the real SDK, so
 * a tree the network could really return is what gets read.
 */
import { Address, Keypair, StrKey, nativeToScVal, scValToNative, xdr } from '@stellar/stellar-sdk'

import { MAX_PAY_AMOUNT } from '../connect'
import { invokeArgsToScVals, readAuthEntries, showScVal, type AuthContext } from '../connectInvoke'

const contractId = (fill: number) => StrKey.encodeContract(Buffer.alloc(32, fill))

const WALLET = contractId(1)
const APP_CONTRACT = contractId(2)
const USDC = contractId(3)
const OTHER_TOKEN = contractId(4)
const SPENDING = Keypair.random().publicKey()
const STRANGER = Keypair.random().publicKey()

const ctx: AuthContext = { wallet: WALLET, spending: SPENDING, knownTokens: { [USDC]: 'USDC' } }

const addr = (a: string) => nativeToScVal(a, { type: 'address' })
const i128 = (n: bigint) => nativeToScVal(n, { type: 'i128' })

function call(contract: string, method: string, args: xdr.ScVal[], subs: xdr.SorobanAuthorizedInvocation[] = []) {
  return new xdr.SorobanAuthorizedInvocation({
    function: xdr.SorobanAuthorizedFunction.sorobanAuthorizedFunctionTypeContractFn(
      new xdr.InvokeContractArgs({
        contractAddress: new Address(contract).toScAddress(),
        functionName: method,
        args,
      }),
    ),
    subInvocations: subs,
  })
}

function asAddress(who: string, root: xdr.SorobanAuthorizedInvocation, nonce = 1) {
  return new xdr.SorobanAuthorizationEntry({
    credentials: xdr.SorobanCredentials.sorobanCredentialsAddress(
      new xdr.SorobanAddressCredentials({
        address: new Address(who).toScAddress(),
        nonce: xdr.Int64.fromString(String(nonce)),
        signatureExpirationLedger: 0,
        signature: xdr.ScVal.scvVoid(),
      }),
    ),
    rootInvocation: root,
  })
}

function asSource(root: xdr.SorobanAuthorizedInvocation) {
  return new xdr.SorobanAuthorizationEntry({
    credentials: xdr.SorobanCredentials.sorobanCredentialsSourceAccount(),
    rootInvocation: root,
  })
}

const transfer = (token: string, from: string, to: string, amount: bigint) =>
  call(token, 'transfer', [addr(from), addr(to), i128(amount)])

const join = (subs: xdr.SorobanAuthorizedInvocation[] = []) =>
  call(APP_CONTRACT, 'join_challenge', [addr(WALLET), nativeToScVal(7, { type: 'u32' })], subs)

describe('invokeArgsToScVals', () => {
  it('carries each type as the contract expects it', () => {
    const vals = invokeArgsToScVals([
      { type: 'address', value: WALLET },
      { type: 'bool', value: 'true' },
      { type: 'u32', value: '7' },
      { type: 'i128', value: '-170141183460469231731687303715884105728' },
      { type: 'u64', value: '18446744073709551615' },
      { type: 'string', value: 'hello' },
      { type: 'symbol', value: 'gold' },
      { type: 'bytes', value: 'deadbeef' },
    ])
    expect(vals.map((v) => v.switch().name)).toEqual([
      'scvAddress', 'scvBool', 'scvU32', 'scvI128', 'scvU64', 'scvString', 'scvSymbol', 'scvBytes',
    ])
    expect(Address.fromScVal(vals[0]).toString()).toBe(WALLET)
    expect(scValToNative(vals[3])).toBe(-170141183460469231731687303715884105728n)
    expect(scValToNative(vals[4])).toBe(18446744073709551615n)
    expect(Buffer.from(vals[7].bytes()).toString('hex')).toBe('deadbeef')
  })
})

describe('showScVal', () => {
  it('writes an address in full and a large number without losing digits', () => {
    expect(showScVal(addr(WALLET))).toBe(WALLET)
    expect(showScVal(i128(123456789012345678901234567890n))).toBe('123456789012345678901234567890')
    expect(showScVal(nativeToScVal(Buffer.from('ab', 'hex'), { type: 'bytes' }))).toBe('0xab')
  })
})

describe('readAuthEntries', () => {
  it('reads a call that takes no money', () => {
    const r = readAuthEntries([asAddress(WALLET, join())], ctx)
    if (!r.ok) throw new Error(r.reason)
    expect(r.movements).toEqual([])
    expect(r.approvals).toEqual([
      { signer: 'wallet', calls: [{ depth: 0, contract: APP_CONTRACT, method: 'join_challenge', args: [WALLET, '7'] }] },
    ])
  })

  it('shows money a nested call takes from the wallet, in whole units, with the full destination', () => {
    const r = readAuthEntries([asAddress(WALLET, join([transfer(USDC, WALLET, APP_CONTRACT, 50_000_000n)]))], ctx)
    if (!r.ok) throw new Error(r.reason)
    expect(r.movements).toEqual([
      { token: USDC, code: 'USDC', from: 'wallet', to: APP_CONTRACT, raw: 50_000_000n, amount: '5' },
    ])
    expect(r.approvals[0].calls.map((c) => [c.depth, c.method])).toEqual([[0, 'join_challenge'], [1, 'transfer']])
  })

  it('shows a token Veil does not know by its contract, with no made-up amount', () => {
    const r = readAuthEntries([asAddress(WALLET, join([transfer(OTHER_TOKEN, WALLET, APP_CONTRACT, 12n)]))], ctx)
    if (!r.ok) throw new Error(r.reason)
    expect(r.movements).toEqual([
      { token: OTHER_TOKEN, code: null, from: 'wallet', to: APP_CONTRACT, raw: 12n, amount: null },
    ])
  })

  it('reads what the spending account approves by carrying the transaction', () => {
    const r = readAuthEntries([asSource(join([transfer(USDC, SPENDING, APP_CONTRACT, 15_000_000n)]))], ctx)
    if (!r.ok) throw new Error(r.reason)
    expect(r.approvals[0].signer).toBe('spending')
    expect(r.movements[0]).toMatchObject({ from: 'spending', amount: '1.5', code: 'USDC' })
  })

  it('reads transfer_from, burn and burn_from as money leaving', () => {
    const tree = join([
      call(USDC, 'transfer_from', [addr(APP_CONTRACT), addr(WALLET), addr(STRANGER), i128(10_000_000n)]),
      call(USDC, 'burn', [addr(WALLET), i128(20_000_000n)]),
      call(USDC, 'burn_from', [addr(APP_CONTRACT), addr(WALLET), i128(30_000_000n)]),
    ])
    const r = readAuthEntries([asAddress(WALLET, tree)], ctx)
    if (!r.ok) throw new Error(r.reason)
    expect(r.movements.map((m) => [m.amount, m.to])).toEqual([['1', STRANGER], ['2', null], ['3', null]])
  })

  it('does not count a transfer out of somebody else as the person\'s money', () => {
    const r = readAuthEntries([asAddress(WALLET, join([transfer(USDC, APP_CONTRACT, WALLET, 9n)]))], ctx)
    if (!r.ok) throw new Error(r.reason)
    expect(r.movements).toEqual([])
    expect(r.approvals[0].calls).toHaveLength(2)
  })

  it('refuses an approval by an address that is not the wallet', () => {
    const r = readAuthEntries([asAddress(STRANGER, join())], ctx)
    expect(r).toEqual({ ok: false, reason: expect.stringContaining('not your wallet') })
  })

  it('refuses any call into the wallet itself, however deep', () => {
    const takeover = call(WALLET, 'add_signer', [nativeToScVal(Buffer.alloc(65, 4), { type: 'bytes' })])
    const r = readAuthEntries([asAddress(WALLET, join([call(APP_CONTRACT, 'helper', [], [takeover])]))], ctx)
    expect(r).toEqual({ ok: false, reason: expect.stringContaining('change your wallet itself') })
  })

  it('refuses a standing allowance', () => {
    const approve = call(USDC, 'approve', [addr(WALLET), addr(APP_CONTRACT), i128(1n), nativeToScVal(99, { type: 'u32' })])
    const r = readAuthEntries([asAddress(WALLET, join([approve]))], ctx)
    expect(r).toEqual({ ok: false, reason: expect.stringContaining('keep spending') })
  })

  it('refuses more of a known token than one request may carry, and allows exactly the limit', () => {
    const limit = BigInt(MAX_PAY_AMOUNT) * 10_000_000n
    expect(readAuthEntries([asAddress(WALLET, join([transfer(USDC, WALLET, APP_CONTRACT, limit)]))], ctx).ok).toBe(true)
    const over = readAuthEntries([asAddress(WALLET, join([transfer(USDC, WALLET, APP_CONTRACT, limit + 1n)]))], ctx)
    expect(over).toEqual({ ok: false, reason: expect.stringContaining('over the limit') })
  })

  it('refuses a negative amount', () => {
    const r = readAuthEntries([asAddress(WALLET, join([transfer(USDC, WALLET, APP_CONTRACT, -1n)]))], ctx)
    expect(r.ok).toBe(false)
  })

  it('refuses deploying a contract', () => {
    const deploy = new xdr.SorobanAuthorizedInvocation({
      function: xdr.SorobanAuthorizedFunction.sorobanAuthorizedFunctionTypeCreateContractHostFn(
        new xdr.CreateContractArgs({
          contractIdPreimage: xdr.ContractIdPreimage.contractIdPreimageFromAddress(
            new xdr.ContractIdPreimageFromAddress({
              address: new Address(WALLET).toScAddress(),
              salt: Buffer.alloc(32, 9),
            }),
          ),
          executable: xdr.ContractExecutable.contractExecutableStellarAsset(),
        }),
      ),
      subInvocations: [],
    })
    const r = readAuthEntries([asAddress(WALLET, deploy)], ctx)
    expect(r).toEqual({ ok: false, reason: expect.stringContaining('deploy a contract') })
  })

  describe('digest', () => {
    const read = (entries: xdr.SorobanAuthorizationEntry[]) => {
      const r = readAuthEntries(entries, ctx)
      if (!r.ok) throw new Error(r.reason)
      return r.digest
    }
    const tree = (amount: bigint) => join([transfer(USDC, WALLET, APP_CONTRACT, amount)])

    it('is the same for the same trees whatever the nonce or the order', () => {
      const a = read([asAddress(WALLET, tree(5n), 1), asSource(join())])
      const b = read([asSource(join()), asAddress(WALLET, tree(5n), 987654)])
      expect(a).toBe(b)
    })

    it('changes when the amount, the destination or who approves changes', () => {
      const base = read([asAddress(WALLET, tree(5n))])
      expect(read([asAddress(WALLET, tree(6n))])).not.toBe(base)
      expect(read([asAddress(WALLET, join([transfer(USDC, WALLET, STRANGER, 5n)]))])).not.toBe(base)
      expect(read([asSource(tree(5n))])).not.toBe(base)
      expect(read([asAddress(WALLET, tree(5n)), asSource(join())])).not.toBe(base)
    })
  })
})
