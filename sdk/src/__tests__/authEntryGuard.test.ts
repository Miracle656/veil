/**
 * A simulation response is network input, and these are the hostile shapes it
 * can take. Each case asserts the refusal happens, and the integration test at
 * the bottom asserts it happens *before* the passkey is asked for — a guard
 * that refuses after the user has already approved a prompt has not protected
 * anyone.
 */

import {
  Account,
  Address,
  Operation,
  StrKey,
  TransactionBuilder,
  nativeToScVal,
  xdr,
} from '@stellar/stellar-sdk'

import {
  AUTH_EXPIRY_LEDGER_WINDOW,
  AuthEntryRejected,
  assertEntryAuthorized,
  cappedExpiration,
  hostFunctionCalls,
  rootContractCall,
} from '../authEntryGuard'

const NETWORK = 'Test SDF Network ; September 2015'
const WALLET = StrKey.encodeContract(Buffer.alloc(32, 1))
const ATTACKER = StrKey.encodeContract(Buffer.alloc(32, 2))
const TOKEN = StrKey.encodeContract(Buffer.alloc(32, 3))

const SOURCE = StrKey.encodeEd25519PublicKey(Buffer.alloc(32, 9))

function call(contract: string, fn: string, args: xdr.ScVal[] = []): xdr.InvokeContractArgs {
  return new xdr.InvokeContractArgs({
    contractAddress: new Address(contract).toScAddress(),
    functionName: fn,
    args,
  })
}

/** An auth entry as recording-mode simulation returns it: expiry 0, no signature. */
function entry(options: {
  credentialAddress?: string
  contract?: string
  fn?: string
  args?: xdr.ScVal[]
  expiry?: number
}): xdr.SorobanAuthorizationEntry {
  const {
    credentialAddress = WALLET,
    contract = WALLET,
    fn = 'add_signer',
    args = [],
    expiry = 0,
  } = options
  return new xdr.SorobanAuthorizationEntry({
    credentials: xdr.SorobanCredentials.sorobanCredentialsAddress(
      new xdr.SorobanAddressCredentials({
        address: new Address(credentialAddress).toScAddress(),
        nonce: xdr.Int64.fromString('987654321'),
        signatureExpirationLedger: expiry,
        signature: xdr.ScVal.scvVoid(),
      })
    ),
    rootInvocation: new xdr.SorobanAuthorizedInvocation({
      function: xdr.SorobanAuthorizedFunction.sorobanAuthorizedFunctionTypeContractFn(
        call(contract, fn, args)
      ),
      subInvocations: [],
    }),
  })
}

/** A transaction invoking one contract function, as the SDK builds them. */
function txInvoking(contract: string, fn: string, args: xdr.ScVal[] = []) {
  return new TransactionBuilder(new Account(SOURCE, '100'), {
    fee: '100',
    networkPassphrase: NETWORK,
  })
    .addOperation(
      Operation.invokeHostFunction({
        func: xdr.HostFunction.hostFunctionTypeInvokeContract(call(contract, fn, args)),
        auth: [],
      })
    )
    .setTimeout(30)
    .build()
}

describe('hostFunctionCalls', () => {
  it('reads the calls a transaction actually makes', () => {
    const calls = hostFunctionCalls(txInvoking(WALLET, 'add_signer'))
    expect(calls).toHaveLength(1)
    expect(calls[0].functionName().toString()).toBe('add_signer')
  })

  it('ignores operations that are not contract invocations', () => {
    const tx = new TransactionBuilder(new Account(SOURCE, '100'), {
      fee: '100',
      networkPassphrase: NETWORK,
    })
      .addOperation(Operation.bumpSequence({ bumpTo: '200' }))
      .setTimeout(30)
      .build()
    expect(hostFunctionCalls(tx)).toHaveLength(0)
  })
})

describe('assertEntryAuthorized', () => {
  const allowed = hostFunctionCalls(txInvoking(WALLET, 'add_signer'))

  it('accepts the entry the transaction asked for', () => {
    expect(() =>
      assertEntryAuthorized(entry({}), { walletAddress: WALLET, allowed })
    ).not.toThrow()
  })

  it('refuses an entry that authorises a different address', () => {
    expect(() =>
      assertEntryAuthorized(entry({ credentialAddress: ATTACKER }), {
        walletAddress: WALLET,
        allowed,
      })
    ).toThrow(AuthEntryRejected)
  })

  it('refuses a foreign transfer smuggled in beside the expected call', () => {
    // The shape that matters: the credential is this wallet, so an
    // address-only check passes, but the invocation is a token transfer the
    // transaction never contained.
    const hostile = entry({
      contract: TOKEN,
      fn: 'transfer',
      args: [
        new Address(WALLET).toScVal(),
        new Address(ATTACKER).toScVal(),
        nativeToScVal(9_999_999_999, { type: 'i128' }),
      ],
    })
    expect(() =>
      assertEntryAuthorized(hostile, { walletAddress: WALLET, allowed })
    ).toThrow(/not a call this transaction makes/)
  })

  it('refuses the right function on the right contract with different arguments', () => {
    const withArgs = hostFunctionCalls(
      txInvoking(TOKEN, 'transfer', [
        new Address(WALLET).toScVal(),
        new Address(SOURCE).toScVal(),
        nativeToScVal(10, { type: 'i128' }),
      ])
    )
    const redirected = entry({
      contract: TOKEN,
      fn: 'transfer',
      args: [
        new Address(WALLET).toScVal(),
        new Address(ATTACKER).toScVal(),
        nativeToScVal(10, { type: 'i128' }),
      ],
    })
    expect(() =>
      assertEntryAuthorized(redirected, { walletAddress: WALLET, allowed: withArgs })
    ).toThrow(AuthEntryRejected)
  })

  it('refuses a credential that is not an address credential', () => {
    const sourceCredential = new xdr.SorobanAuthorizationEntry({
      credentials: xdr.SorobanCredentials.sorobanCredentialsSourceAccount(),
      rootInvocation: new xdr.SorobanAuthorizedInvocation({
        function: xdr.SorobanAuthorizedFunction.sorobanAuthorizedFunctionTypeContractFn(
          call(WALLET, 'add_signer')
        ),
        subInvocations: [],
      }),
    })
    expect(() =>
      assertEntryAuthorized(sourceCredential, { walletAddress: WALLET, allowed })
    ).toThrow(/not an address credential/)
  })

  it('refuses when the transaction makes no contract call at all', () => {
    expect(() =>
      assertEntryAuthorized(entry({}), { walletAddress: WALLET, allowed: [] })
    ).toThrow(AuthEntryRejected)
  })

  it('names the contract and function it refused, so the log is readable', () => {
    expect(() =>
      assertEntryAuthorized(entry({ contract: TOKEN, fn: 'transfer' }), {
        walletAddress: WALLET,
        allowed,
      })
    ).toThrow(new RegExp(`${TOKEN}\\.transfer`))
  })
})

describe('rootContractCall', () => {
  it('returns null for an authorisation that is not a contract call', () => {
    const creating = new xdr.SorobanAuthorizationEntry({
      credentials: xdr.SorobanCredentials.sorobanCredentialsAddress(
        new xdr.SorobanAddressCredentials({
          address: new Address(WALLET).toScAddress(),
          nonce: xdr.Int64.fromString('1'),
          signatureExpirationLedger: 0,
          signature: xdr.ScVal.scvVoid(),
        })
      ),
      rootInvocation: new xdr.SorobanAuthorizedInvocation({
        function: xdr.SorobanAuthorizedFunction.sorobanAuthorizedFunctionTypeCreateContractHostFn(
          new xdr.CreateContractArgs({
            contractIdPreimage: xdr.ContractIdPreimage.contractIdPreimageFromAddress(
              new xdr.ContractIdPreimageFromAddress({
                address: new Address(WALLET).toScAddress(),
                salt: Buffer.alloc(32),
              })
            ),
            executable: xdr.ContractExecutable.contractExecutableWasm(Buffer.alloc(32)),
          })
        ),
        subInvocations: [],
      }),
    })
    expect(rootContractCall(creating)).toBeNull()
  })
})

describe('cappedExpiration', () => {
  it('supplies a real expiry when the simulation returned none', () => {
    expect(cappedExpiration(0, 5000)).toBe(5000 + AUTH_EXPIRY_LEDGER_WINDOW)
  })

  it('brings a distant expiry back to the window', () => {
    // An entry valid for years is a signature that can be kept and replayed.
    expect(cappedExpiration(50_000_000, 5000)).toBe(5000 + AUTH_EXPIRY_LEDGER_WINDOW)
  })

  it('leaves a nearer expiry alone', () => {
    expect(cappedExpiration(5010, 5000)).toBe(5010)
  })
})
