/**
 * @jest-environment node
 */
/**
 * Session keys against the interface of the wallet that is actually deployed.
 *
 * The argument order and types are checked against spec entries copied out of
 * the deployed WASM (fixtures/deployedWalletSpec.json), not against anything
 * written by hand, so "updating" a builder to `main`'s interface fails here.
 */

import {
  Address,
  Keypair,
  StrKey,
  TransactionBuilder,
  Account,
  Contract,
  hash,
  nativeToScVal,
  scValToNative,
  xdr,
} from '@stellar/stellar-sdk'

import { AuthEntryRejected, hostFunctionCalls } from '../authEntryGuard'
import {
  SESSION_KEY_EXPIRY_MARGIN_SECONDS,
  SESSION_KEY_SIGNATURE_VECTOR_LENGTH,
  SessionKeyError,
  SessionKeyNonceMismatch,
  assertSessionKeyExpiry,
  buildRegisterSessionKeyCall,
  buildRevokeSessionKeyCall,
  buildSessionKeySignatureVector,
  decodeSessionKeyRecord,
  maxSessionKeyExpiry,
  readSessionKey,
  sessionKeyLedgerKey,
  sessionKeyRetryableError,
  signAuthEntryWithSessionKey,
  walletAuthFailure,
} from '../sessionKey'
import deployedSpec from './fixtures/deployedWalletSpec.json'

const NETWORK = 'Test SDF Network ; September 2015'
const WALLET = StrKey.encodeContract(Buffer.alloc(32, 1))
const TOKEN = StrKey.encodeContract(Buffer.alloc(32, 3))
const OTHER_TOKEN = StrKey.encodeContract(Buffer.alloc(32, 4))
const RECIPIENT = StrKey.encodeEd25519PublicKey(Buffer.alloc(32, 5))
const SOURCE = StrKey.encodeEd25519PublicKey(Buffer.alloc(32, 9))

const LIMITS = { ledgerTime: 1_800_000_000n, maxEntryTtl: 3_110_400 }
const KEY_ID = new Uint8Array(32).fill(7)
const SESSION = Keypair.fromRawEd25519Seed(Buffer.alloc(32, 8))

function grant(overrides: Partial<Parameters<typeof buildRegisterSessionKeyCall>[1]> = {}) {
  return {
    pubkey: SESSION.rawPublicKey(),
    keyId: KEY_ID,
    targetContract: TOKEN,
    selector: 'transfer',
    amountCap: 5_000_000n,
    expiry: LIMITS.ledgerTime + 3600n,
    ...overrides,
  }
}

function specEntry(name: string): xdr.ScSpecEntry {
  const found = deployedSpec.entries.find((e) => e.name === name)
  if (!found) throw new Error(`The deployed spec has no ${name}`)
  return xdr.ScSpecEntry.fromXDR(found.xdr, 'base64')
}

/** The ScVal type a spec input type is encoded as. */
const SPEC_TO_SCVAL: Record<string, string> = {
  scSpecTypeBytesN: 'scvBytes',
  scSpecTypeAddress: 'scvAddress',
  scSpecTypeSymbol: 'scvSymbol',
  scSpecTypeI128: 'scvI128',
  scSpecTypeU64: 'scvU64',
}

function assertMatchesDeployedSpec(method: string, args: xdr.ScVal[], expectedNames: string[]) {
  const fn = specEntry(method).functionV0()
  const inputs = fn.inputs()
  expect(inputs.map((i) => i.name().toString())).toEqual(expectedNames)
  expect(args).toHaveLength(inputs.length)
  inputs.forEach((input, i) => {
    const type = input.type()
    expect(args[i].switch().name).toBe(SPEC_TO_SCVAL[type.switch().name])
    if (type.switch().name === 'scSpecTypeBytesN') {
      expect(args[i].bytes()).toHaveLength(type.bytesN().n())
    }
  })
}

describe('deployed interface', () => {
  it('the spec fixture comes from the wallet WASM mainnet runs', () => {
    expect(deployedSpec.wasm_sha256).toBe('b485f817469402ba4ccc24ea30077308f69589cbe0897db49087b15f58659ea5')
  })

  it('register_session_key matches the deployed argument names, order and types', () => {
    const call = buildRegisterSessionKeyCall(WALLET, grant(), LIMITS)
    expect(call.method).toBe('register_session_key')
    assertMatchesDeployedSpec(call.method, call.args, [
      'pubkey',
      'key_id',
      'target_contract',
      'selector',
      'amount_cap',
      'expiry',
    ])
  })

  it('revoke_session_key matches the deployed argument names, order and types', () => {
    const call = buildRevokeSessionKeyCall(WALLET, KEY_ID)
    expect(call.method).toBe('revoke_session_key')
    assertMatchesDeployedSpec(call.method, call.args, ['key_id'])
  })

  it('main-only entry points do not exist on the deployed wallet', () => {
    expect(deployedSpec.entries.map((e) => e.name)).not.toContain('register_session_key_scoped')
  })

  it('the stored record has exactly the deployed SessionKeyAcl fields', () => {
    const fields = specEntry('SessionKeyAcl').udtStructV0().fields().map((f) => f.name().toString())
    expect(fields.sort()).toEqual(['amount_cap', 'expiry', 'pubkey', 'selector', 'spent', 'target_contract'])
  })

  it('NonceMismatch is error 16 on the deployed wallet', () => {
    const cases = specEntry('WalletError').udtErrorEnumV0().cases()
    const nonce = cases.find((c) => c.name().toString() === 'NonceMismatch')
    expect(nonce?.value()).toBe(16)
  })
})

describe('buildRegisterSessionKeyCall', () => {
  it('encodes every argument', () => {
    const call = buildRegisterSessionKeyCall(WALLET, grant(), LIMITS)
    expect(call.contractId).toBe(WALLET)
    const [pubkey, keyId, target, selector, cap, expiry] = call.args
    expect(Buffer.from(pubkey.bytes())).toEqual(Buffer.from(SESSION.rawPublicKey()))
    expect(Buffer.from(keyId.bytes())).toEqual(Buffer.from(KEY_ID))
    expect(Address.fromScVal(target).toString()).toBe(TOKEN)
    expect(selector.sym().toString()).toBe('transfer')
    expect(scValToNative(cap)).toBe(5_000_000n)
    expect(scValToNative(expiry)).toBe(LIMITS.ledgerTime + 3600n)
  })

  it('the built call is what invokeAsWallet sends', () => {
    const call = buildRegisterSessionKeyCall(WALLET, grant(), LIMITS)
    const tx = new TransactionBuilder(new Account(SOURCE, '0'), { fee: '100', networkPassphrase: NETWORK })
      .addOperation(new Contract(call.contractId).call(call.method, ...call.args))
      .setTimeout(30)
      .build()
    const [invoked] = hostFunctionCalls(tx)
    expect(Address.fromScAddress(invoked.contractAddress()).toString()).toBe(WALLET)
    expect(invoked.functionName().toString()).toBe('register_session_key')
    expect(invoked.args().map((a) => a.toXDR('base64'))).toEqual(call.args.map((a) => a.toXDR('base64')))
  })

  it.each([
    ['a short pubkey', { pubkey: new Uint8Array(31) }],
    ['a short key id', { keyId: new Uint8Array(33) }],
    ['a selector that is not a symbol', { selector: 'trans fer' }],
    ['a zero cap', { amountCap: 0n }],
    ['a negative cap', { amountCap: -1n }],
    ['an expiry already past', { expiry: LIMITS.ledgerTime }],
  ])('refuses %s', (_label, overrides) => {
    expect(() => buildRegisterSessionKeyCall(WALLET, grant(overrides), LIMITS)).toThrow(SessionKeyError)
  })

  it('refuses an expiry the network cannot keep the record alive for', () => {
    const max = maxSessionKeyExpiry(LIMITS)
    expect(() => buildRegisterSessionKeyCall(WALLET, grant({ expiry: max }), LIMITS)).not.toThrow()
    expect(() => buildRegisterSessionKeyCall(WALLET, grant({ expiry: max + 1n }), LIMITS)).toThrow(
      /later than this network can keep/,
    )
  })
})

describe('maxSessionKeyExpiry', () => {
  /** The contract's own arithmetic: ledgers it asks to extend the record to. */
  const contractLedgersNeeded = (expiry: bigint, now: bigint) => (expiry - now) / 5n + 10n

  it('without the margin, lands on the last lifetime the network accepts', () => {
    // Measured on testnet against the deployed WASM: maxEntryTtl - 1 ledgers is
    // accepted, maxEntryTtl fails the whole registration with Error(Storage, InvalidAction).
    const edge = maxSessionKeyExpiry(LIMITS) + SESSION_KEY_EXPIRY_MARGIN_SECONDS
    expect(contractLedgersNeeded(edge, LIMITS.ledgerTime)).toBe(BigInt(LIMITS.maxEntryTtl - 1))
    expect(contractLedgersNeeded(edge + 1n, LIMITS.ledgerTime)).toBe(BigInt(LIMITS.maxEntryTtl))
  })

  it('is about 180 days on a network with the mainnet setting', () => {
    const days = Number(maxSessionKeyExpiry(LIMITS) - LIMITS.ledgerTime) / 86_400
    expect(days).toBeGreaterThan(179)
    expect(days).toBeLessThan(180)
  })

  it('assertSessionKeyExpiry accepts the maximum and refuses one second more', () => {
    const max = maxSessionKeyExpiry(LIMITS)
    expect(() => assertSessionKeyExpiry(max, LIMITS)).not.toThrow()
    expect(() => assertSessionKeyExpiry(max + 1n, LIMITS)).toThrow(SessionKeyError)
  })
})

describe('buildRevokeSessionKeyCall', () => {
  it('encodes the key id', () => {
    const call = buildRevokeSessionKeyCall(WALLET, KEY_ID)
    expect(call.contractId).toBe(WALLET)
    expect(call.args).toHaveLength(1)
    expect(Buffer.from(call.args[0].bytes())).toEqual(Buffer.from(KEY_ID))
  })

  it('refuses a key id that is not 32 bytes', () => {
    expect(() => buildRevokeSessionKeyCall(WALLET, new Uint8Array(16))).toThrow(SessionKeyError)
  })
})

function transferCall(token = TOKEN, amount = 1_000n, to = RECIPIENT): xdr.InvokeContractArgs {
  return new xdr.InvokeContractArgs({
    contractAddress: new Address(token).toScAddress(),
    functionName: 'transfer',
    args: [new Address(WALLET).toScVal(), new Address(to).toScVal(), nativeToScVal(amount, { type: 'i128' })],
  })
}

function authEntry(call: xdr.InvokeContractArgs, wallet = WALLET): xdr.SorobanAuthorizationEntry {
  return new xdr.SorobanAuthorizationEntry({
    credentials: xdr.SorobanCredentials.sorobanCredentialsAddress(
      new xdr.SorobanAddressCredentials({
        address: new Address(wallet).toScAddress(),
        nonce: xdr.Int64.fromString('42'),
        signatureExpirationLedger: 0,
        signature: xdr.ScVal.scvVoid(),
      }),
    ),
    rootInvocation: new xdr.SorobanAuthorizedInvocation({
      function: xdr.SorobanAuthorizedFunction.sorobanAuthorizedFunctionTypeContractFn(call),
      subInvocations: [],
    }),
  })
}

describe('signAuthEntryWithSessionKey', () => {
  const options = {
    sessionKey: SESSION,
    keyId: KEY_ID,
    walletAddress: WALLET,
    allowed: [transferCall()],
    walletNonce: 3n,
    validUntilLedger: 1234,
    networkPassphrase: NETWORK,
  }

  it('produces [key_id, ed25519 signature over the auth payload, wallet nonce]', () => {
    const { signature, entry } = signAuthEntryWithSessionKey(authEntry(transferCall()), options)
    const items = signature.vec()!
    expect(items).toHaveLength(SESSION_KEY_SIGNATURE_VECTOR_LENGTH)
    expect(items[0].switch().name).toBe('scvBytes')
    expect(Buffer.from(items[0].bytes())).toEqual(Buffer.from(KEY_ID))
    expect(items[1].switch().name).toBe('scvBytes')
    expect(items[1].bytes()).toHaveLength(64)
    expect(items[2].switch().name).toBe('scvU64')
    expect(scValToNative(items[2])).toBe(3n)

    const cred = entry.credentials().address()
    expect(cred.signatureExpirationLedger()).toBe(1234)
    expect(cred.signature().toXDR('base64')).toBe(signature.toXDR('base64'))

    const payload = hash(
      xdr.HashIdPreimage.envelopeTypeSorobanAuthorization(
        new xdr.HashIdPreimageSorobanAuthorization({
          networkId: hash(Buffer.from(NETWORK)),
          nonce: cred.nonce(),
          invocation: entry.rootInvocation(),
          signatureExpirationLedger: 1234,
        }),
      ).toXDR(),
    )
    expect(SESSION.verify(payload, Buffer.from(items[1].bytes()))).toBe(true)
  })

  it('refuses an entry for a call the transaction does not make', () => {
    expect(() =>
      signAuthEntryWithSessionKey(authEntry(transferCall(TOKEN, 999_999n)), options),
    ).toThrow(AuthEntryRejected)
  })

  it('refuses an entry on a different token', () => {
    expect(() => signAuthEntryWithSessionKey(authEntry(transferCall(OTHER_TOKEN)), options)).toThrow(
      AuthEntryRejected,
    )
  })

  it('refuses an entry for a different wallet', () => {
    const otherWallet = StrKey.encodeContract(Buffer.alloc(32, 6))
    expect(() => signAuthEntryWithSessionKey(authEntry(transferCall(), otherWallet), options)).toThrow(
      AuthEntryRejected,
    )
  })

  it('buildSessionKeySignatureVector refuses a signature that is not 64 bytes', () => {
    expect(() => buildSessionKeySignatureVector(KEY_ID, new Uint8Array(63), 0n)).toThrow(SessionKeyError)
  })
})

function storedRecord(extra: xdr.ScMapEntry[] = []): xdr.ScVal {
  const field = (name: string, val: xdr.ScVal) => new xdr.ScMapEntry({ key: xdr.ScVal.scvSymbol(name), val })
  return xdr.ScVal.scvMap([
    field('amount_cap', nativeToScVal(5_000_000n, { type: 'i128' })),
    field('expiry', nativeToScVal(1_800_003_600n, { type: 'u64' })),
    ...extra,
    field('pubkey', nativeToScVal(Buffer.from(SESSION.rawPublicKey()), { type: 'bytes' })),
    field('selector', xdr.ScVal.scvSymbol('transfer')),
    field('spent', nativeToScVal(1_000n, { type: 'i128' })),
    field('target_contract', new Address(TOKEN).toScVal()),
  ])
}

function fakeServer(response: { entries: unknown[]; latestLedger: number }) {
  const getLedgerEntries = jest.fn().mockResolvedValue(response)
  return { server: { getLedgerEntries } as never, getLedgerEntries }
}

function ledgerEntry(val: xdr.ScVal, liveUntilLedgerSeq: number) {
  const data = new xdr.ContractDataEntry({
    ext: new xdr.ExtensionPoint(0),
    contract: new Address(WALLET).toScAddress(),
    key: sessionKeyLedgerKey(WALLET, KEY_ID).contractData().key(),
    durability: xdr.ContractDataDurability.temporary(),
    val,
  })
  return { val: xdr.LedgerEntryData.contractData(data), liveUntilLedgerSeq }
}

describe('readSessionKey', () => {
  it('reads SessionDataKey::Acl(key_id) from temporary storage', () => {
    const key = sessionKeyLedgerKey(WALLET, KEY_ID).contractData()
    expect(key.durability()).toEqual(xdr.ContractDataDurability.temporary())
    expect(Address.fromScAddress(key.contract()).toString()).toBe(WALLET)
    const [variant, id] = key.key().vec()!
    expect(variant.sym().toString()).toBe('Acl')
    expect(Buffer.from(id.bytes())).toEqual(Buffer.from(KEY_ID))
  })

  it('returns the record', async () => {
    const { server, getLedgerEntries } = fakeServer({ entries: [ledgerEntry(storedRecord(), 2000)], latestLedger: 1000 })
    const record = await readSessionKey(server, WALLET, KEY_ID)
    expect(getLedgerEntries.mock.calls[0][0].toXDR('base64')).toBe(sessionKeyLedgerKey(WALLET, KEY_ID).toXDR('base64'))
    expect(record).toEqual({
      pubkey: new Uint8Array(SESSION.rawPublicKey()),
      targetContract: TOKEN,
      selector: 'transfer',
      amountCap: 5_000_000n,
      spent: 1_000n,
      expiry: 1_800_003_600n,
    })
  })

  it('returns null when there is no record', async () => {
    const { server } = fakeServer({ entries: [], latestLedger: 1000 })
    await expect(readSessionKey(server, WALLET, KEY_ID)).resolves.toBeNull()
  })

  it('returns null for a record past its storage lifetime', async () => {
    const { server } = fakeServer({ entries: [ledgerEntry(storedRecord(), 999)], latestLedger: 1000 })
    await expect(readSessionKey(server, WALLET, KEY_ID)).resolves.toBeNull()
  })

  it("refuses a record shaped like main's, with payees", () => {
    const payees = new xdr.ScMapEntry({ key: xdr.ScVal.scvSymbol('payees'), val: xdr.ScVal.scvVec([]) })
    expect(() => decodeSessionKeyRecord(storedRecord([payees]))).toThrow(/Unexpected session key record fields/)
  })
})

/** The diagnostic event the host emits when a wallet's `__check_auth` refuses, as observed on testnet. */
function authFailureEvent(wallet: string, error: xdr.ScError): xdr.DiagnosticEvent {
  return new xdr.DiagnosticEvent({
    inSuccessfulContractCall: false,
    event: new xdr.ContractEvent({
      ext: new xdr.ExtensionPoint(0),
      contractId: null,
      type: xdr.ContractEventType.diagnostic(),
      body: new xdr.ContractEventBody(
        0,
        new xdr.ContractEventV0({
          topics: [
            xdr.ScVal.scvSymbol('error'),
            xdr.ScVal.scvError(xdr.ScError.sceAuth(xdr.ScErrorCode.scecInvalidAction())),
          ],
          data: xdr.ScVal.scvVec([
            xdr.ScVal.scvString('failed account authentication with error'),
            new Address(wallet).toScVal(),
            xdr.ScVal.scvError(error),
          ]),
        }),
      ),
    }),
  })
}

describe('sessionKeyRetryableError', () => {
  it('reports the wallet refusing with NonceMismatch as a distinct, retryable error', () => {
    const events = [authFailureEvent(WALLET, xdr.ScError.sceContract(16))]
    const error = sessionKeyRetryableError({ events }, WALLET)
    expect(error).toBeInstanceOf(SessionKeyNonceMismatch)
    expect(error?.retryable).toBe(true)
  })

  it.each([
    ['an ACL violation', xdr.ScError.sceContract(20)],
    ['an expired key', xdr.ScError.sceContract(19)],
    ['an unknown key', xdr.ScError.sceContract(3)],
    ['a bad ed25519 signature', xdr.ScError.sceCrypto(xdr.ScErrorCode.scecInvalidInput())],
  ])('does not treat %s as retryable', (_label, scError) => {
    expect(sessionKeyRetryableError({ events: [authFailureEvent(WALLET, scError)] }, WALLET)).toBeNull()
  })

  it('ignores error 16 reported for a different account', () => {
    const otherWallet = StrKey.encodeContract(Buffer.alloc(32, 6))
    const events = [authFailureEvent(otherWallet, xdr.ScError.sceContract(16))]
    expect(sessionKeyRetryableError({ events }, WALLET)).toBeNull()
  })

  it('returns null without diagnostic events', () => {
    expect(sessionKeyRetryableError({}, WALLET)).toBeNull()
  })

  it('walletAuthFailure returns the wallet error', () => {
    const failure = walletAuthFailure([authFailureEvent(WALLET, xdr.ScError.sceContract(20))], WALLET)
    expect(failure?.contractCode()).toBe(20)
  })
})
