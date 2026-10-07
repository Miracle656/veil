import { signedOrigin, walletContractErrorMessage } from '../walletContractError'

/**
 * The real failure, from a real attempt.
 *
 * This is the HostError a user got on 2026-10-05 trying to sweep 0.0097655 XLM
 * out of their contract wallet on the web. The wallet had been created in the
 * mobile app, so the contract stores `android:apk-key-hash:…` and the web
 * assertion carried `https://app.useveilapp.xyz`. `__check_auth` compares the
 * two byte for byte and refused.
 *
 * What they saw was two thousand characters of diagnostic log. The point of
 * these tests is that they see a sentence instead — and specifically NOT
 * "try again", which can never work for this one.
 */
const REAL_ORIGIN_MISMATCH =
  'HostError: Error(Auth, InvalidAction) Event log (newest first): ' +
  '0: [Diagnostic Event] contract:CAS3J7GYLGXMF6TDJBBYYSE3HQ6BBSMLNUQ34T6TZMYMW2EVH34XOWMA, ' +
  'topics:[error, Error(Auth, InvalidAction)], data:["failed account authentication with error", ' +
  'CDUS5S3AENE5QREEHCIEHGKMP6LMBDELUYB35ZSFYETXETN2674MXQHK, Error(Contract, #9)] ' +
  '2: [Diagnostic Event] topics:[fn_call, CDUS5S3AENE5QREEHCIEHGKMP6LMBDELUYB35ZSFYETXETN2674MXQHK, __check_auth], ' +
  'data:[Bytes(040cf0b87a01c7b9bc00cb40787a1e023a6e48fddbc134b2692fd9c98bca2e8918f97283d3b0d26d45f86d5cba94e382eb98381ed2ca1ffe5a442da269b24a970c), ' +
  // clientDataJSON: {"type":"webauthn.get","challenge":"…","origin":"https://app.useveilapp.xyz","crossOrigin":false}
  'Bytes(7b2274797065223a22776562617574686e2e676574222c226368616c6c656e6765223a224c5a394d6541794a4435797649666b4c56775a594252366136385f6a74545a525031364634686c62396c63222c226f726967696e223a2268747470733a2f2f6170702e7573657665696c6170702e78797a222c2263726f73734f726967696e223a66616c73657d)]'

describe('the origin mismatch a user actually hit', () => {
  it('names it instead of printing the host error', () => {
    const message = walletContractErrorMessage(REAL_ORIGIN_MISMATCH)
    expect(message).toBeTruthy()
    expect(message).toMatch(/created/i)
    expect(message).toMatch(/cannot be signed here/i)
  })

  it('never tells them to try again, because it will never work', () => {
    // The contract stores one origin and compares it byte for byte. No number of
    // retries changes the origin the browser stamps into clientDataJSON.
    expect(walletContractErrorMessage(REAL_ORIGIN_MISMATCH)).not.toMatch(/try again/i)
  })

  it('does not leak the diagnostic dump into the sentence', () => {
    const message = walletContractErrorMessage(REAL_ORIGIN_MISMATCH)!
    expect(message).not.toMatch(/HostError|Diagnostic Event|Bytes\(/)
    expect(message.length).toBeLessThan(300)
  })

  it('reads the signed origin back out of the dump', () => {
    expect(signedOrigin(REAL_ORIGIN_MISMATCH)).toBe('https://app.useveilapp.xyz')
  })
})

describe('other wallet-contract failures', () => {
  const auth = (code: number) =>
    `HostError: Error(Auth, InvalidAction) … Error(Contract, #${code}) … __check_auth`

  it('tells someone to reload when the nonce moved under them', () => {
    expect(walletContractErrorMessage(auth(16))).toMatch(/reload/i)
  })

  it('names an unregistered signer', () => {
    expect(walletContractErrorMessage(auth(3))).toMatch(/not a signer/i)
  })

  it('names a domain mismatch separately from an origin one', () => {
    expect(walletContractErrorMessage(auth(8))).toMatch(/different domain/i)
  })
})

describe('what it refuses to name', () => {
  it('returns null for an auth failure it cannot place', () => {
    // So the caller shows the raw error. An unrecognised failure with its detail
    // intact is diagnosable; the same failure behind "something went wrong" is
    // not, and a wrong guess is worse than either.
    expect(walletContractErrorMessage('HostError: Error(Auth, InvalidAction) … Error(Contract, #42)')).toBeNull()
  })

  it('returns null for errors that are not auth failures at all', () => {
    expect(walletContractErrorMessage('HostError: Error(Budget, ExceededLimit)')).toBeNull()
    expect(walletContractErrorMessage('connection refused')).toBeNull()
  })

  it('returns null rather than throwing on an unparseable blob', () => {
    expect(signedOrigin('Bytes(7bdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef)')).toBeNull()
  })
})
