/* eslint-disable no-console */
/**
 * Veil allowance-spend spike — Stellar TESTNET ONLY.
 *
 * Proves, with real testnet transactions, how a "spender" spends from a Veil
 * wallet's on-chain allowance (the `Address` branch of the wallet's
 * `__check_auth`), and what that branch refuses.
 *
 * The TESTNET factory deploys an OLDER wallet build than mainnet runs, so the
 * whole sequence is run twice, side by side, against two wallets:
 *   [factory]       a wallet deployed by the testnet factory (old code), and
 *   [mainnet-code]  a wallet instantiated ON TESTNET from the exact wasm bytes
 *                   mainnet wallets run (the bytes are read from mainnet RPC,
 *                   read-only, hash-checked, then uploaded to testnet).
 *
 * Run (fresh throwaway keys every run, nothing is read from this machine):
 *   node scripts/spikes/allowance-spike.cjs      (from a folder where @stellar/stellar-sdk is installed)
 *
 * Takes about 7 minutes: step 8 has to wait for an allowance to expire.
 * Writes `spike-result.json` next to this file.
 */
const crypto = require('crypto')
const fs = require('fs')
const path = require('path')
const S = require('@stellar/stellar-sdk')
const { xdr, Address, Keypair, Contract, TransactionBuilder, Operation, Asset, nativeToScVal, scValToNative } = S

// ── Network: testnet, hard-coded. There is no mainnet submission path here. ──
const PASSPHRASE = 'Test SDF Network ; September 2015'
const RPC_URL = 'https://soroban-testnet.stellar.org'
const FRIENDBOT = 'https://friendbot.stellar.org/?addr='
const FACTORY = 'CAUK4MWO3TTFM6PLURSH2GPK3AB747SZGABKTCVLKCU7W2MGKHKP35GA'
// Mainnet is only ever READ (factory instance + wallet wasm bytes). Nothing is sent to it.
const MAINNET_RPC = 'https://mainnet.sorobanrpc.com'
const MAINNET_FACTORY = 'CCZ3JLRESNLDADGXWNEH4YQ4NXUUAHRJNCWZHYG6QB4KTDYHOH6OQ7BK'

const RP_ID = 'app.useveilapp.xyz'
const ORIGIN = 'https://app.useveilapp.xyz'
const XLM = Asset.native().contractId(PASSPHRASE)
const USDC = new Asset('USDC', 'GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5').contractId(PASSPHRASE)
const STROOPS = 10_000_000n
const FEE = '100000'

const rpc = new S.rpc.Server(RPC_URL)
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const sha256 = (b) => crypto.createHash('sha256').update(b).digest()
const NETWORK_ID = sha256(Buffer.from(PASSPHRASE))
const addr = (a) => new Address(a).toScVal()
const i128 = (n) => nativeToScVal(BigInt(n), { type: 'i128' })
const u64 = (n) => nativeToScVal(BigInt(n), { type: 'u64' })
const randomNonce = () => xdr.Int64.fromString(BigInt('0x' + crypto.randomBytes(7).toString('hex')).toString())

/** A step recorder for one run; `rows` becomes that run's table. */
function recorder(tag) {
  const rows = []
  const record = (step, what, outcome, hash, detail) => {
    rows.push({ step, what, outcome, hash: hash || '', detail: detail || '' })
    console.log(`\n[${tag} ${step}] ${what}\n    outcome: ${outcome}${hash ? `\n    tx:      ${hash}` : ''}${detail ? `\n    detail:  ${detail}` : ''}`)
  }
  return { rows, record }
}

// ── Error extraction ─────────────────────────────────────────────────────────
/**
 * Why a simulation was refused: every distinct `Error(Type, code)` found in the
 * error string AND in the diagnostic events (the wallet's own contract error
 * code only shows up in the events).
 */
function simErrors(sim) {
  const out = []
  const add = (text) => { for (const m of String(text).matchAll(/Error\((\w+), ([#\w]+)\)/g)) { const t = `Error(${m[1]}, ${m[2].replace(/^scec/, '')})`; if (!out.includes(t)) out.push(t) } }
  add(sim.error)
  for (const line of eventErrors(sim.events || [])) add(line)
  const contract = out.filter((t) => t.startsWith('Error(Contract'))
  return (contract.length ? `WALLET ${contract.join(' ')} <- ` : '') + out.join(' / ')
}
function firstLines(text, n = 3) {
  return String(text).split('\n').map((l) => l.trim()).filter(Boolean).slice(0, n).join(' | ').slice(0, 700)
}
function renderVal(v) {
  try {
    if (v.switch().name === 'scvError') {
      const e = v.error()
      return e.switch().name === 'sceContract' ? `Error(Contract, #${e.contractCode()})` : `Error(${e.switch().name.slice(3)}, ${e.code().name})`
    }
    const n = scValToNative(v)
    return typeof n === 'bigint' ? n.toString() : typeof n === 'string' ? n : JSON.stringify(n, (_, x) => (typeof x === 'bigint' ? x.toString() : x))
  } catch { return '?' }
}
/** The `error` diagnostic events in a list of DiagnosticEvent, as text. */
function eventErrors(events) {
  const out = []
  for (const d of events) {
    try {
      const body = d.event().body().v0()
      const topics = body.topics()
      if (!topics.length || topics[0].switch().name !== 'scvSymbol' || topics[0].sym().toString() !== 'error') continue
      out.push(`${topics.slice(1).map(renderVal).join(',')}: ${renderVal(body.data()).slice(0, 160)}`)
    } catch { /* */ }
  }
  return out
}
/** The `error` diagnostic events of a failed transaction. */
function txErrors(res) {
  let events = []
  try { if (res.diagnosticEventsXdr) events = res.diagnosticEventsXdr } catch { /* */ }
  if (!events.length) {
    try {
      const meta = res.resultMetaXdr
      events = meta.switch() === 4 ? meta.v4().diagnosticEvents() : meta.v3().sorobanMeta().diagnosticEvents()
    } catch { /* */ }
  }
  return eventErrors(events)
}

// ── Plumbing ─────────────────────────────────────────────────────────────────
async function buildTx(sourcePub, op) {
  const acct = await rpc.getAccount(sourcePub)
  return new TransactionBuilder(acct, { fee: FEE, networkPassphrase: PASSPHRASE }).addOperation(op).setTimeout(120).build()
}
async function sendAndWait(tx, ...signers) {
  for (const s of signers) tx.sign(s)
  const sent = await rpc.sendTransaction(tx)
  if (sent.status === 'ERROR') {
    return { hash: sent.hash, status: 'REJECTED', errors: [sent.errorResult ? sent.errorResult.toXDR('base64') : 'unknown'] }
  }
  for (let i = 0; i < 60; i++) {
    await sleep(1000)
    const res = await rpc.getTransaction(sent.hash)
    if (res.status === 'NOT_FOUND') continue
    return { hash: sent.hash, status: res.status, errors: res.status === 'SUCCESS' ? [] : txErrors(res), returnValue: res.returnValue, ledger: res.ledger }
  }
  return { hash: sent.hash, status: 'TIMEOUT', errors: [] }
}
/** Read-only call: simulate and decode the return value. */
async function view(contractId, method, ...args) {
  const tx = new TransactionBuilder(new S.Account(Keypair.random().publicKey(), '0'), { fee: FEE, networkPassphrase: PASSPHRASE })
    .addOperation(new Contract(contractId).call(method, ...args)).setTimeout(30).build()
  const sim = await rpc.simulateTransaction(tx)
  if (S.rpc.Api.isSimulationError(sim)) throw new Error(`view ${method}: ${firstLines(sim.error)}`)
  return scValToNative(sim.result.retval)
}
/** A plain contract call authorised by a classic G account that is also the source. */
async function invokeAsAccount(kp, contractId, method, args) {
  const tx = await buildTx(kp.publicKey(), new Contract(contractId).call(method, ...args))
  const sim = await rpc.simulateTransaction(tx)
  if (S.rpc.Api.isSimulationError(sim)) throw new Error(`simulate ${method}: ${firstLines(sim.error)}`)
  const res = await sendAndWait(S.rpc.assembleTransaction(tx, sim).build(), kp)
  if (res.status !== 'SUCCESS') throw new Error(`${method} ${res.status}: ${res.errors.join(' ; ')}`)
  return res
}
const instanceKey = (contractId) => xdr.LedgerKey.contractData(new xdr.LedgerKeyContractData({
  contract: new Address(contractId).toScAddress(),
  key: xdr.ScVal.scvLedgerKeyContractInstance(),
  durability: xdr.ContractDataDurability.persistent(),
}))
const codeKey = (hashHex) => xdr.LedgerKey.contractCode(new xdr.LedgerKeyContractCode({ hash: Buffer.from(hashHex, 'hex') }))
/** The wasm hash a contract instance runs. */
async function wasmHashOf(server, contractId) {
  const r = await server.getLedgerEntries(instanceKey(contractId))
  if (!r.entries.length) return null
  return r.entries[0].val.contractData().val().instance().executable().wasmHash().toString('hex')
}
/** The wallet wasm hash a Veil factory is configured to deploy (its `WasmHash` instance-storage entry). */
async function factoryWalletHash(server, factoryId) {
  const r = await server.getLedgerEntries(instanceKey(factoryId))
  for (const e of r.entries[0].val.contractData().val().instance().storage() || []) {
    const k = scValToNative(e.key())
    if (Array.isArray(k) && k[0] === 'WasmHash') return Buffer.from(scValToNative(e.val())).toString('hex')
  }
  return null
}
/** Exported contract functions of a wasm, from its embedded spec. */
function wasmFunctions(wasm) {
  return S.contract.Spec.fromWasm(wasm).funcs().map((f) => f.name().toString()).sort()
}

// ── Two ways to get a wallet on testnet ──────────────────────────────────────
const initArgs = (ctx) => [xdr.ScVal.scvBytes(ctx.passkey.pub65), xdr.ScVal.scvBytes(Buffer.from(RP_ID)), xdr.ScVal.scvBytes(Buffer.from(ORIGIN))]
/** Through the testnet factory, exactly as the SDK does. */
async function deployViaFactory(ctx) {
  const dep = await invokeAsAccount(ctx.feePayer, FACTORY, 'deploy', initArgs(ctx))
  return { wallet: scValToNative(dep.returnValue), hash: dep.hash, what: 'factory.deploy(P-256 pubkey, rp_id, origin)' }
}
/** From the mainnet wallet wasm: upload the bytes to testnet if absent, instantiate, init. */
function deployFromWasm(wasm, hashHex) {
  return async (ctx) => {
    const send = async (op) => {
      const tx = await buildTx(ctx.feePayer.publicKey(), op)
      const sim = await rpc.simulateTransaction(tx)
      if (S.rpc.Api.isSimulationError(sim)) throw new Error(`simulate: ${firstLines(sim.error)}`)
      const res = await sendAndWait(S.rpc.assembleTransaction(tx, sim).build(), ctx.feePayer)
      if (res.status !== 'SUCCESS') throw new Error(`${res.status}: ${res.errors.join(' ; ')}`)
      return res
    }
    let upload = 'already on testnet'
    if (!(await rpc.getLedgerEntries(codeKey(hashHex))).entries.length) upload = `tx ${(await send(Operation.uploadContractWasm({ wasm }))).hash}`
    const create = await send(Operation.createCustomContract({
      address: new Address(ctx.feePayer.publicKey()), wasmHash: Buffer.from(hashHex, 'hex'), salt: crypto.randomBytes(32),
    }))
    const wallet = scValToNative(create.returnValue)
    const init = await invokeAsAccount(ctx.feePayer, wallet, 'init', initArgs(ctx))
    return { wallet, hash: create.hash, what: `createCustomContract(mainnet wallet wasm) + init  [wasm upload: ${upload}; init tx ${init.hash}]` }
  }
}

// ── Software "passkey": a P-256 key that produces WebAuthn-shaped assertions ─
function makePasskey() {
  const { privateKey, publicKey } = crypto.generateKeyPairSync('ec', { namedCurve: 'P-256' })
  const jwk = publicKey.export({ format: 'jwk' })
  const pub65 = Buffer.concat([Buffer.from([4]), Buffer.from(jwk.x, 'base64url'), Buffer.from(jwk.y, 'base64url')])
  const N = BigInt('0xFFFFFFFF00000000FFFFFFFFFFFFFFFFBCE6FAADA7179E84F3B9CAC2FC632551')
  let counter = 0
  /** Sign a 32-byte Soroban auth payload the way an authenticator would. */
  function assert(payload) {
    // authenticatorData = SHA256(rp_id) || flags (UP 0x01 | UV 0x04) || 4-byte counter
    const authData = Buffer.concat([sha256(Buffer.from(RP_ID)), Buffer.from([0x05]), Buffer.from([0, 0, 0, ++counter])])
    // The contract only does substring checks: "type":"webauthn.get", the
    // base64url challenge, and the exact value after "origin":" — so no key
    // order is required, but no whitespace may appear inside those tokens.
    const clientDataJSON = Buffer.from(JSON.stringify({
      type: 'webauthn.get', challenge: Buffer.from(payload).toString('base64url'), origin: ORIGIN, crossOrigin: false,
    }))
    const raw = crypto.sign('sha256', Buffer.concat([authData, sha256(clientDataJSON)]), { key: privateKey, dsaEncoding: 'ieee-p1363' })
    let s = BigInt('0x' + raw.subarray(32).toString('hex'))
    if (s > N / 2n) s = N - s // low-S, required by the secp256r1 host function
    const signature = Buffer.concat([raw.subarray(0, 32), Buffer.from(s.toString(16).padStart(64, '0'), 'hex')])
    return { authData, clientDataJSON, signature }
  }
  return { pub65, assert }
}

/** The hash a signer of this auth entry signs (and that `__check_auth` receives as `signature_payload`). */
function authPayload(nonce, rootInvocation, validUntil) {
  return sha256(xdr.HashIdPreimage.envelopeTypeSorobanAuthorization(new xdr.HashIdPreimageSorobanAuthorization({
    networkId: NETWORK_ID, nonce, invocation: rootInvocation, signatureExpirationLedger: validUntil,
  })).toXDR())
}

/**
 * PASSKEY PATH — mirrors frontend/wallet/lib/walletInvoke.ts `invokeAsWallet`:
 * record-simulate, sign each address entry, enforce-simulate, assemble from the
 * second simulation, sign with the fee payer, submit.
 */
async function invokeAsWalletPasskey(ctx, contractId, method, args) {
  const nonce = await view(ctx.wallet, 'get_nonce')
  const tx = await buildTx(ctx.feePayer.publicKey(), new Contract(contractId).call(method, ...args))
  const sim = await rpc.simulateTransaction(tx, { cpuInstructions: 5_000_000 })
  if (S.rpc.Api.isSimulationError(sim)) return { stage: 'simulate(record)', simError: sim.error, why: simErrors(sim) }
  const validUntil = (await rpc.getLatestLedger()).sequence + 100
  const entries = sim.result.auth || []
  for (const e of entries) {
    if (e.credentials().switch().name !== 'sorobanCredentialsAddress') continue
    const c = e.credentials().address()
    const a = ctx.passkey.assert(authPayload(c.nonce(), e.rootInvocation(), validUntil))
    e.credentials(xdr.SorobanCredentials.sorobanCredentialsAddress(new xdr.SorobanAddressCredentials({
      address: c.address(), nonce: c.nonce(), signatureExpirationLedger: validUntil,
      signature: xdr.ScVal.scvVec([
        xdr.ScVal.scvBytes(ctx.passkey.pub65), xdr.ScVal.scvBytes(a.authData), xdr.ScVal.scvBytes(a.clientDataJSON),
        xdr.ScVal.scvBytes(a.signature), u64(nonce),
      ]),
    })))
  }
  const op = tx.operations[0]
  const tx2 = await buildTx(ctx.feePayer.publicKey(), Operation.invokeHostFunction({ func: op.func, auth: entries }))
  const sim2 = await rpc.simulateTransaction(tx2)
  if (S.rpc.Api.isSimulationError(sim2)) return { stage: 'simulate(enforce)', simError: sim2.error, why: simErrors(sim2) }
  return sendAndWait(S.rpc.assembleTransaction(tx2, sim2).build(), ctx.feePayer)
}

/**
 * ALLOWANCE PATH — build the transaction for `contractId.method(args)` that
 * needs the WALLET's authorisation, satisfied by a spender instead of the passkey.
 *
 *   mode 'a'      spender is the tx source, wallet entry only (no spender entry)
 *   mode 'b'      spender is the tx source + a SOURCE-ACCOUNT credentials entry
 *                 whose root invocation is wallet.__check_auth(payload, sig, contexts)
 *   mode 'c'      someone else is the source + an ADDRESS credentials entry for
 *                 the spender (own nonce + expiry, ed25519-signed), same root
 *   mode 'c-root' like 'c' but the spender entry is rooted at the transfer
 *                 itself (the intuitive, WRONG construction)
 *
 * `claimed` is the address put in the wallet entry's signature (defaults to the
 * signing spender). `fixed` lets two builds share nonces + expiry, so a passing
 * twin's simulation can supply the footprint for a transaction that must fail.
 */
async function buildSpend(ctx, { mode, spender, claimed, contractId, method, args, fixed }) {
  const sourceKp = mode === 'a' || mode === 'b' ? spender : ctx.feePayer
  const claimedAddr = claimed || spender.publicKey()
  const f = fixed || {}
  f.walletNonce = f.walletNonce || randomNonce()
  f.spenderNonce = f.spenderNonce || randomNonce()
  f.validUntil = f.validUntil || (await rpc.getLatestLedger()).sequence + 100

  // 1. The wallet's own entry. Deterministic, so no recording simulation is
  //    needed: root = the call that does `wallet.require_auth()`, no children.
  //    Nobody signs this entry: its nonce and expiry are simply chosen here.
  const rootInvocation = new xdr.SorobanAuthorizedInvocation({
    function: xdr.SorobanAuthorizedFunction.sorobanAuthorizedFunctionTypeContractFn(new xdr.InvokeContractArgs({
      contractAddress: new Address(contractId).toScAddress(), functionName: method, args,
    })),
    subInvocations: [],
  })
  const walletEntry = new xdr.SorobanAuthorizationEntry({
    credentials: xdr.SorobanCredentials.sorobanCredentialsAddress(new xdr.SorobanAddressCredentials({
      address: new Address(ctx.wallet).toScAddress(),
      nonce: f.walletNonce,
      signatureExpirationLedger: f.validUntil,
      signature: addr(claimedAddr), // <- a bare Address selects the allowance branch
    })),
    rootInvocation,
  })

  // 2. What the host will pass to __check_auth, reproduced exactly:
  //    (signature_payload: BytesN<32>, signature: Val, auth_contexts: Vec<Context>)
  const payload = authPayload(f.walletNonce, rootInvocation, f.validUntil)
  const context = xdr.ScVal.scvVec([
    xdr.ScVal.scvSymbol('Contract'),
    xdr.ScVal.scvMap([ // keys in sorted order: args, contract, fn_name
      new xdr.ScMapEntry({ key: xdr.ScVal.scvSymbol('args'), val: xdr.ScVal.scvVec(args) }),
      new xdr.ScMapEntry({ key: xdr.ScVal.scvSymbol('contract'), val: addr(contractId) }),
      new xdr.ScMapEntry({ key: xdr.ScVal.scvSymbol('fn_name'), val: xdr.ScVal.scvSymbol(method) }),
    ]),
  ])
  const checkAuthInvocation = new xdr.SorobanAuthorizedInvocation({
    function: xdr.SorobanAuthorizedFunction.sorobanAuthorizedFunctionTypeContractFn(new xdr.InvokeContractArgs({
      contractAddress: new Address(ctx.wallet).toScAddress(),
      functionName: '__check_auth',
      args: [xdr.ScVal.scvBytes(payload), addr(claimedAddr), xdr.ScVal.scvVec([context])],
    })),
    subInvocations: [],
  })

  // 3. The spender's authorisation of that __check_auth call.
  const auth = [walletEntry]
  if (mode === 'b') {
    auth.push(new xdr.SorobanAuthorizationEntry({
      credentials: xdr.SorobanCredentials.sorobanCredentialsSourceAccount(),
      rootInvocation: checkAuthInvocation,
    }))
  } else if (mode === 'c' || mode === 'c-root') {
    const unsigned = new xdr.SorobanAuthorizationEntry({
      credentials: xdr.SorobanCredentials.sorobanCredentialsAddress(new xdr.SorobanAddressCredentials({
        address: new Address(spender.publicKey()).toScAddress(),
        nonce: f.spenderNonce,
        signatureExpirationLedger: 0,
        signature: xdr.ScVal.scvVoid(),
      })),
      rootInvocation: mode === 'c' ? checkAuthInvocation : rootInvocation,
    })
    // Standard account signature: Vec[ Map{ public_key: Bytes32, signature: Bytes64 } ]
    auth.push(await S.authorizeEntry(unsigned, spender, f.validUntil, PASSPHRASE))
  }

  const func = xdr.HostFunction.hostFunctionTypeInvokeContract(new xdr.InvokeContractArgs({
    contractAddress: new Address(contractId).toScAddress(), functionName: method, args,
  }))
  const tx = await buildTx(sourceKp.publicKey(), Operation.invokeHostFunction({ func, auth }))
  return { tx, sourceKp, fixed: f, auth }
}

/** Build, enforce-simulate, and (if the simulation passes) submit an allowance spend. */
async function spend(ctx, opts) {
  const built = await buildSpend(ctx, opts)
  const sim = await rpc.simulateTransaction(built.tx) // auth present => enforce mode
  if (S.rpc.Api.isSimulationError(sim)) return { simError: sim.error, why: simErrors(sim), built }
  const res = await sendAndWait(S.rpc.assembleTransaction(built.tx, sim).build(), built.sourceKp)
  return { ...res, built, sim }
}

/**
 * Put a transaction that simulation refuses ON CHAIN anyway, to get a real
 * failed-transaction hash: borrow footprint and fee from a passing "twin"
 * (same nonces/expiry/keys touched, different arguments or mode).
 */
async function forceOnChain(ctx, failing, twin) {
  const fixed = {}
  const twinBuilt = await buildSpend(ctx, { ...twin, fixed })
  const twinSim = await rpc.simulateTransaction(twinBuilt.tx)
  if (S.rpc.Api.isSimulationError(twinSim)) return { status: 'TWIN_SIM_FAILED', errors: [simErrors(twinSim)], hash: '' }
  const failBuilt = await buildSpend(ctx, { ...failing, fixed })
  return sendAndWait(S.rpc.assembleTransaction(failBuilt.tx, twinSim).build(), failBuilt.sourceKp)
}

const transferArgs = (from, to, amount) => [addr(from), addr(to), i128(amount)]
const fmtAllowance = (a) => (a ? `{amount: ${a.amount} stroops, expiry: ${a.expiry === undefined || a.expiry === null ? 'none' : a.expiry}}` : 'none (no record)')

/** The whole sequence against one wallet. */
async function runSequence(tag, deployWallet) {
  const { rows, record } = recorder(tag)
  // ── 1. Keys, funding, deploy ───────────────────────────────────────────────
  const ctx = { feePayer: Keypair.random(), passkey: makePasskey() }
  const s1 = Keypair.random(), s2 = Keypair.random(), s3 = Keypair.random(), third = Keypair.random()
  const fb = await fetch(FRIENDBOT + ctx.feePayer.publicKey())
  if (!fb.ok) throw new Error(`friendbot ${fb.status}`)
  const acct = await rpc.getAccount(ctx.feePayer.publicKey())
  const b = new TransactionBuilder(acct, { fee: FEE, networkPassphrase: PASSPHRASE })
  for (const k of [s1, s2, s3, third]) b.addOperation(Operation.createAccount({ destination: k.publicKey(), startingBalance: '100' }))
  const created = await sendAndWait(b.setTimeout(120).build(), ctx.feePayer)
  if (created.status !== 'SUCCESS') throw new Error('createAccount failed')
  record('1a', 'Friendbot-fund fee payer; create spender1/2/3 + third accounts (100 XLM each)', 'SUCCESS', created.hash)

  const dep = await deployWallet(ctx)
  ctx.wallet = dep.wallet
  const walletWasm = await wasmHashOf(rpc, ctx.wallet)
  record('1b', dep.what, 'SUCCESS', dep.hash, `wallet ${ctx.wallet} runs wasm ${walletWasm}`)

  // ── 2. Fund the wallet with 20 XLM through the native SAC ──────────────────
  const fund = await invokeAsAccount(ctx.feePayer, XLM, 'transfer', transferArgs(ctx.feePayer.publicKey(), ctx.wallet, 20n * STROOPS))
  record('2', 'XLM SAC transfer(feePayer -> wallet, 20 XLM)', 'SUCCESS', fund.hash, `wallet balance ${await view(XLM, 'balance', addr(ctx.wallet))} stroops`)

  // ── 3. Passkey path: approve(spender1, XLM, 5 XLM, now+1h) ─────────────────
  const now = () => Math.floor(Date.now() / 1000)
  const ap = await invokeAsWalletPasskey(ctx, ctx.wallet, 'approve', [addr(s1.publicKey()), addr(XLM), i128(5n * STROOPS), u64(now() + 3600)])
  if (ap.status !== 'SUCCESS') throw new Error(`approve failed: ${ap.simError || ap.errors}`)
  record('3', 'PASSKEY wallet.approve(spender1, XLM, 5 XLM, now+1h)', 'SUCCESS', ap.hash,
    `get_allowance = ${fmtAllowance(await view(ctx.wallet, 'get_allowance', addr(s1.publicKey()), addr(XLM)))}`)

  // ── 8 (set-up). Short-lived allowance for spender3; prepare its spend now ──
  const s3Expiry = now() + 90
  const ap3 = await invokeAsWalletPasskey(ctx, ctx.wallet, 'approve', [addr(s3.publicKey()), addr(XLM), i128(100), u64(s3Expiry)])
  record('8a', 'PASSKEY wallet.approve(spender3, XLM, 100 stroops, now+90s)', ap3.status, ap3.hash)
  // Simulate the spend while it is still valid, keep the footprint, submit it after expiry.
  const s3Opts = { mode: 'b', spender: s3, contractId: XLM, method: 'transfer', args: transferArgs(ctx.wallet, third.publicKey(), 10) }
  const s3Fixed = { validUntil: (await rpc.getLatestLedger()).sequence + 400 }
  const s3Pre = await buildSpend(ctx, { ...s3Opts, fixed: s3Fixed })
  const s3PreSim = await rpc.simulateTransaction(s3Pre.tx)
  record('8b', 'spender3 spend simulated BEFORE expiry (not submitted)', S.rpc.Api.isSimulationError(s3PreSim) ? 'SIM FAILED' : 'simulation passes', '',
    S.rpc.Api.isSimulationError(s3PreSim) ? simErrors(s3PreSim) : '')

  // ── 10 (before) ────────────────────────────────────────────────────────────
  const nonceBefore = await view(ctx.wallet, 'get_nonce')

  // ── 4. THE KEY QUESTION ────────────────────────────────────────────────────
  const thirdBefore = await view(XLM, 'balance', addr(third.publicKey()))
  const oneXlm = { spender: s1, contractId: XLM, method: 'transfer', args: transferArgs(ctx.wallet, third.publicKey(), STROOPS) }

  // Does a recording simulation reveal the nested requirement? (It should return only the wallet's entry.)
  {
    const probe = await buildTx(s1.publicKey(), new Contract(XLM).call('transfer', ...oneXlm.args))
    const sim = await rpc.simulateTransaction(probe)
    const d = S.rpc.Api.isSimulationError(sim) ? `error ${simErrors(sim)}` :
      `${sim.result.auth.length} entry(ies): ${sim.result.auth.map((e) => `${e.credentials().switch().name} root=${e.rootInvocation().function().contractFn().functionName()}`).join('; ')}`
    record('4.0', 'recording-mode simulation of transfer(from=wallet)', 'info', '', d)
  }

  // (a) spender is the source, no spender entry
  const a = await spend(ctx, { ...oneXlm, mode: 'a' })
  record('4a', 'spender = SOURCE, wallet entry only (enforce simulation)', a.simError ? 'REFUSED in simulation' : a.status, a.hash,
    a.simError ? a.why : '')
  const aChain = await forceOnChain(ctx, { ...oneXlm, mode: 'a' }, { ...oneXlm, mode: 'b' })
  record('4a-chain', 'same, forced on chain with footprint borrowed from (b)', aChain.status, aChain.hash, aChain.errors.join(' ; '))

  // (c-root) the intuitive wrong construction: spender entry rooted at the transfer
  const cr = await spend(ctx, { ...oneXlm, mode: 'c-root' })
  record('4c-root', 'spender NOT source, address entry rooted at the TRANSFER (enforce simulation)', cr.simError ? 'REFUSED in simulation' : cr.status, cr.hash,
    cr.simError ? cr.why : '')

  // (b) spender is the source + source-account entry rooted at __check_auth
  const bRes = await spend(ctx, { ...oneXlm, mode: 'b' })
  record('4b', 'spender = SOURCE + sourceAccount entry rooted at wallet.__check_auth — 1 XLM', bRes.simError ? 'REFUSED in simulation' : bRes.status, bRes.hash,
    bRes.simError ? bRes.why : '')

  // ── 5. Confirm ─────────────────────────────────────────────────────────────
  const thirdAfter = await view(XLM, 'balance', addr(third.publicKey()))
  record('5', 'third address balance delta; get_allowance(spender1, XLM)', 'info', '',
    `third +${thirdAfter - thirdBefore} stroops | allowance ${fmtAllowance(await view(ctx.wallet, 'get_allowance', addr(s1.publicKey()), addr(XLM)))}`)

  // (c) fee payer is the source + address-credential entry for the spender
  const cRes = await spend(ctx, { ...oneXlm, mode: 'c', args: transferArgs(ctx.wallet, third.publicKey(), STROOPS / 2n) })
  record('4c', 'spender NOT source (fee payer pays) + ADDRESS entry for spender rooted at wallet.__check_auth — 0.5 XLM', cRes.simError ? 'REFUSED in simulation' : cRes.status, cRes.hash,
    cRes.simError ? cRes.why :
      `third +${(await view(XLM, 'balance', addr(third.publicKey()))) - thirdAfter} | allowance ${fmtAllowance(await view(ctx.wallet, 'get_allowance', addr(s1.publicKey()), addr(XLM)))}`)
  if (cRes.sim && !cRes.simError) {
    const fp = cRes.sim.transactionData.build().resources().footprint()
    record('4c-fp', 'footprint of the working (c) transaction', 'info', '', `readOnly ${fp.readOnly().length} keys, readWrite ${fp.readWrite().length} keys; minResourceFee ${cRes.sim.minResourceFee}`)
  }

  // ── 10 (after) ─────────────────────────────────────────────────────────────
  const nonceAfter = await view(ctx.wallet, 'get_nonce')
  record('10', 'wallet.get_nonce() before / after the allowance spends', nonceBefore === nonceAfter ? 'UNCHANGED' : 'CHANGED', '', `before ${nonceBefore}, after ${nonceAfter}`)

  // ── 6. The cap ─────────────────────────────────────────────────────────────
  const tenXlm = { ...oneXlm, mode: 'b', args: transferArgs(ctx.wallet, third.publicKey(), 10n * STROOPS) }
  const cap = await spend(ctx, tenXlm)
  record('6', 'spend 10 XLM with 3.5 XLM left (enforce simulation)', cap.simError ? 'REFUSED in simulation' : cap.status, cap.hash, cap.simError ? cap.why : '')
  const capChain = await forceOnChain(ctx, tenXlm, { ...oneXlm, mode: 'b' })
  record('6-chain', 'same, forced on chain', capChain.status, capChain.hash, capChain.errors.join(' ; '))

  // ── 7. What the allowance does NOT allow ───────────────────────────────────
  const usdc = await spend(ctx, { mode: 'b', spender: s1, contractId: USDC, method: 'transfer', args: transferArgs(ctx.wallet, third.publicKey(), 1) })
  record('7i', 'different token: USDC transfer(from=wallet) by spender1', usdc.simError ? 'REFUSED in simulation' : usdc.status, usdc.hash, usdc.simError ? usdc.why : '')

  const latest = (await rpc.getLatestLedger()).sequence
  const tokApprove = await spend(ctx, { mode: 'b', spender: s1, contractId: XLM, method: 'approve',
    args: [addr(ctx.wallet), addr(s1.publicKey()), i128(STROOPS), nativeToScVal(latest + 1000, { type: 'u32' })] })
  record('7ii-a', 'not a transfer: XLM token approve(from=wallet, spender1, …)', tokApprove.simError ? 'REFUSED in simulation' : tokApprove.status, tokApprove.hash, tokApprove.simError ? tokApprove.why : '')
  const addSigner = await spend(ctx, { mode: 'b', spender: s1, contractId: ctx.wallet, method: 'add_signer', args: [xdr.ScVal.scvBytes(makePasskey().pub65)] })
  record('7ii-b', 'not a transfer: wallet.add_signer(new key)', addSigner.simError ? 'REFUSED in simulation' : addSigner.status, addSigner.hash, addSigner.simError ? addSigner.why : '')

  const other1 = await spend(ctx, { ...oneXlm, mode: 'b', spender: s2 })
  record('7iii-a', 'spender2 signs and presents ITSELF (no allowance of its own)', other1.simError ? 'REFUSED in simulation' : other1.status, other1.hash, other1.simError ? other1.why : '')
  const other2 = await spend(ctx, { ...oneXlm, mode: 'b', spender: s2, claimed: s1.publicKey() })
  record('7iii-b', 'spender2 signs (source) but the wallet entry CLAIMS spender1', other2.simError ? 'REFUSED in simulation' : other2.status, other2.hash, other2.simError ? other2.why : '')
  const other3 = await spend(ctx, { ...oneXlm, mode: 'c', spender: s2, claimed: s1.publicKey() })
  record('7iii-c', 'spender2 address-entry signature while the wallet entry CLAIMS spender1', other3.simError ? 'REFUSED in simulation' : other3.status, other3.hash, other3.simError ? other3.why : '')

  // ── 9. Taking it back ──────────────────────────────────────────────────────
  const s1Args = [addr(s1.publicKey()), addr(XLM)]
  const zero = await invokeAsWalletPasskey(ctx, ctx.wallet, 'approve', [...s1Args, i128(0), xdr.ScVal.scvVoid()])
  record('9a', 'PASSKEY wallet.approve(spender1, XLM, amount = 0)', zero.simError ? `REFUSED at ${zero.stage}` : zero.status, zero.hash,
    zero.simError ? zero.why : fmtAllowance(await view(ctx.wallet, 'get_allowance', ...s1Args)))
  const revoke = await invokeAsWalletPasskey(ctx, ctx.wallet, 'revoke_allowance', s1Args)
  record('9b', 'PASSKEY wallet.revoke_allowance(spender1, XLM)', revoke.simError ? `REFUSED at ${revoke.stage}` : revoke.status, revoke.hash,
    revoke.simError ? revoke.why : fmtAllowance(await view(ctx.wallet, 'get_allowance', ...s1Args)))
  const before9 = await view(ctx.wallet, 'get_allowance', ...s1Args)
  const stop = await invokeAsWalletPasskey(ctx, ctx.wallet, 'approve', [...s1Args, i128(1), u64(0)])
  record('9c', 'PASSKEY wallet.approve(spender1, XLM, 1 stroop, expiry 0)  [STOP_REPLACEMENT]', stop.simError ? `REFUSED at ${stop.stage}` : stop.status, stop.hash,
    stop.simError ? stop.why : `before ${fmtAllowance(before9)} -> after ${fmtAllowance(await view(ctx.wallet, 'get_allowance', ...s1Args))}`)
  const oneStroop = { ...oneXlm, mode: 'b', args: transferArgs(ctx.wallet, third.publicKey(), 1) }
  const afterStop = await spend(ctx, oneStroop)
  record('9d', 'spender1 spends 1 stroop after the stop', afterStop.simError ? 'REFUSED in simulation' : afterStop.status, afterStop.hash, afterStop.simError ? afterStop.why : '')

  // ── 8. Expiry ──────────────────────────────────────────────────────────────
  const waitUntil = s3Expiry + 185
  console.log(`\n[${tag}] … waiting ${Math.max(0, waitUntil - now())}s so spender3's allowance is 3 minutes past its expiry`)
  while (now() < waitUntil) await sleep(5000)
  const exp = await spend(ctx, s3Opts)
  record('8c', 'spender3 spends 10 stroops, 3+ min after expiry (enforce simulation)', exp.simError ? 'REFUSED in simulation' : exp.status, exp.hash, exp.simError ? exp.why : '')
  if (!S.rpc.Api.isSimulationError(s3PreSim)) {
    const late = await buildSpend(ctx, { ...s3Opts, fixed: s3Fixed })
    const expChain = await sendAndWait(S.rpc.assembleTransaction(late.tx, s3PreSim).build(), s3)
    record('8c-chain', 'same spend, footprint from the pre-expiry simulation, submitted on chain', expChain.status, expChain.hash, expChain.errors.join(' ; '))
  }
  record('8d', 'get_allowance(spender3, XLM) after expiry', 'info', '', fmtAllowance(await view(ctx.wallet, 'get_allowance', addr(s3.publicKey()), addr(XLM))))

  const addresses = {
    wallet: ctx.wallet, walletWasmHash: walletWasm, feePayer: ctx.feePayer.publicKey(), spender1: s1.publicKey(),
    spender2: s2.publicKey(), spender3: s3.publicKey(), third: third.publicKey(), passkeyPublicKeyHex: ctx.passkey.pub65.toString('hex'),
  }
  return { tag, addresses, rows }
}

async function main() {
  // ── 0. Which code is where? ────────────────────────────────────────────────
  const mainnet = new S.rpc.Server(MAINNET_RPC)
  const testnetHash = await factoryWalletHash(rpc, FACTORY)
  const mainnetHash = await factoryWalletHash(mainnet, MAINNET_FACTORY)
  const mainnetWasm = (await mainnet.getLedgerEntries(codeKey(mainnetHash))).entries[0].val.contractCode().code()
  if (sha256(mainnetWasm).toString('hex') !== mainnetHash) throw new Error('mainnet wasm bytes do not hash to the factory value')
  const testnetWasm = (await rpc.getLedgerEntries(codeKey(testnetHash))).entries[0].val.contractCode().code()
  const tf = wasmFunctions(testnetWasm), mf = wasmFunctions(mainnetWasm)
  console.log(`[0] wallet wasm the TESTNET factory deploys: ${testnetHash} (${testnetWasm.length} bytes, ${tf.length} functions)`)
  console.log(`[0] wallet wasm the MAINNET factory deploys: ${mainnetHash} (${mainnetWasm.length} bytes, ${mf.length} functions)`)
  console.log(`[0] ${testnetHash === mainnetHash ? 'SAME CODE' : 'DIFFERENT CODE'}; functions only on mainnet: ${mf.filter((f) => !tf.includes(f)).join(', ') || '-'}; only on testnet: ${tf.filter((f) => !mf.includes(f)).join(', ') || '-'}`)

  const settled = await Promise.allSettled([
    runSequence('factory', deployViaFactory),
    runSequence('mainnet-code', deployFromWasm(mainnetWasm, mainnetHash)),
  ])
  const runs = []
  for (const r of settled) { if (r.status === 'fulfilled') runs.push(r.value); else console.error('\nRUN FAILED', r.reason) }

  // ── Summary ────────────────────────────────────────────────────────────────
  console.log(`\ncommon: xlmToken ${XLM} | usdcToken ${USDC} | testnet factory ${FACTORY}`)
  for (const run of runs) {
    console.log(`\n================ [${run.tag}] ADDRESSES ================`)
    for (const [k, v] of Object.entries(run.addresses)) console.log(`${k.padEnd(20)} ${v}`)
    console.log(`================ [${run.tag}] STEPS ====================`)
    for (const r of run.rows) console.log(`${r.step.padEnd(9)}| ${r.outcome.padEnd(26)}| ${(r.hash || '-').padEnd(64)} | ${r.what}${r.detail ? `  => ${r.detail}` : ''}`)
  }
  fs.writeFileSync(path.join(__dirname, 'spike-result.json'),
    JSON.stringify({ testnetFactoryWalletWasm: testnetHash, mainnetFactoryWalletWasm: mainnetHash, xlmToken: XLM, usdcToken: USDC, runs }, (_, v) => (typeof v === 'bigint' ? v.toString() : v), 2))
  if (runs.length !== settled.length) process.exit(1)
}

main().catch((e) => { console.error('\nFATAL', e); process.exit(1) })
