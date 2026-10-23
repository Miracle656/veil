/**
 * Telling "this wallet has never spent" from "something went wrong".
 *
 * A Veil wallet's contract is deployed on its first spend, so a brand-new
 * wallet legitimately has no contract at its address. The classifier exists to
 * recognise that, and it recognised only two of the several ways a node says
 * it — so a tester opening Passkeys on an unspent wallet was shown this,
 * verbatim, on a settings screen:
 *
 *   HostError: Error(Storage, MissingValue) … "trying to get non-existing
 *   value for contract instance" … fn_call, CCDRZY5F…, get_signers
 *
 * Classifying that as `unknown` is what let the caller carry on and read a
 * signer list that could not exist.
 */

// The module imports the Stellar SDK, which needs these before it will load
// under jsdom. Same shim the other suites here use.
import { webcrypto } from 'crypto'
import { TextEncoder, TextDecoder } from 'util'

Object.defineProperty(globalThis, 'crypto', { value: webcrypto, configurable: true, writable: true })
Object.assign(globalThis, { TextEncoder, TextDecoder })

import { Horizon, Keypair, rpc as SorobanRpc, StrKey } from '@stellar/stellar-sdk'

import { peekFeePayerKeypair } from '../feePayer'
import {
  WalletNotActivatedError,
  classifyContractDataError,
  ensureWalletDeployed,
  getDeploymentState,
} from '../walletDeployment'

jest.mock('../feePayer', () => ({
  peekFeePayerKeypair: jest.fn(),
}))

/**
 * A full 56-character C... address: the contract id of the zero-filled key.
 * Derived rather than written out, so it cannot be a truncated literal.
 */
const CONTRACT_ID = StrKey.encodeContract(Buffer.alloc(32))

const mockPeekFeePayerKeypair = peekFeePayerKeypair as jest.MockedFunction<typeof peekFeePayerKeypair>

let feePayer: Keypair
let deploy: jest.Mock<Promise<unknown>, [string]>
let loadAccount: jest.SpyInstance
let getContractData: jest.SpyInstance

beforeEach(() => {
  jest.clearAllMocks()
  feePayer = Keypair.random()
  mockPeekFeePayerKeypair.mockReturnValue(feePayer)
  loadAccount = jest.spyOn(Horizon.Server.prototype, 'loadAccount').mockResolvedValue({} as never)
  getContractData = jest
    .spyOn(SorobanRpc.Server.prototype, 'getContractData')
    .mockResolvedValue({} as never)
  deploy = jest.fn().mockResolvedValue({ alreadyDeployed: false })
})

afterEach(() => {
  jest.restoreAllMocks()
})

describe('classifyContractDataError', () => {
  // Each of these is a real way a node reports an absent contract instance.
  // The first is the one a tester actually hit, in full.
  it.each([
    [
      'the storage error a tester saw',
      'Simulation failed: HostError: Error(Storage, MissingValue) Event log (newest first): 0: [Diagnostic Event] topics:[error, Error(Storage, MissingValue)], data:"trying to get non-existing value for contract instance" 1: [Diagnostic Event] topics:[fn_call, CCDRZY5F4IRZFPIOIAHOJTCURLTFF736NAFB7WU3FPTP4SJJJZWAMDOE, get_signers], data:Void',
    ],
    ['a plain not-found', 'Contract data not found'],
    ['an HTTP 404', 'Request failed with status code 404'],
    ['a bare MissingValue', 'Error(Storage, MissingValue)'],
    ['mixed case', 'ERROR(STORAGE, MISSINGVALUE)'],
  ])('recognises %s as undeployed', (_label, message) => {
    expect(classifyContractDataError(new Error(message))).toBe('undeployed')
  })

  // A network failure is NOT "this wallet has never spent", and saying so would
  // tell someone with a real, funded wallet that it does not exist.
  it.each([
    ['a network failure', 'fetch failed'],
    ['a timeout', 'The operation timed out'],
    ['a server error', 'Request failed with status code 502'],
    ['a rate limit', 'Too many requests'],
  ])('does not claim %s means undeployed', (_label, message) => {
    expect(classifyContractDataError(new Error(message))).toBe('unknown')
  })

  it('survives a non-Error being thrown', () => {
    expect(classifyContractDataError('Error(Storage, MissingValue)')).toBe('undeployed')
    expect(classifyContractDataError(undefined)).toBe('unknown')
  })
})

describe('WalletNotActivatedError', () => {
  // Breaks: the UI can no longer tell the user which spending address needs XLM, so setup stalls with no instruction.
  it('keeps the full spending address and names itself', () => {
    const spendingAddress = Keypair.random().publicKey()
    expect(spendingAddress).toHaveLength(56)

    const err = new WalletNotActivatedError(spendingAddress)

    expect(err).toBeInstanceOf(Error)
    expect(err.name).toBe('WalletNotActivatedError')
    expect(err.spendingAddress).toBe(spendingAddress)
    expect(err.message).toContain(spendingAddress)
  })

  // Breaks: a wallet with no spending key is told to fund "null" instead of being told to unlock again.
  it('explains that no spending key is available when the address is null', () => {
    const err = new WalletNotActivatedError(null)

    expect(err.spendingAddress).toBeNull()
    expect(err.message).toContain('no spending key')
    expect(err.message).not.toContain('null')
  })
})

describe('getDeploymentState', () => {
  // Breaks: a session with no address is reported as "not deployed", and the UI offers to deploy a wallet it cannot name.
  it('returns unknown for a missing address without touching the RPC', async () => {
    await expect(getDeploymentState(null)).resolves.toBe('unknown')
    expect(getContractData).not.toHaveBeenCalled()
  })

  // Breaks: a G... spending account is sent to the contract-instance lookup, wasting an RPC round trip to learn nothing.
  it('returns unknown for an address that is not a contract id', async () => {
    const spendingAddress = feePayer.publicKey()
    expect(spendingAddress).toHaveLength(56)

    await expect(getDeploymentState(spendingAddress)).resolves.toBe('unknown')
    expect(getContractData).not.toHaveBeenCalled()
  })

  // Breaks: every spend on a live wallet re-attempts deployment, and the factory's duplicate refusal surfaces as an error.
  it('reports deployed when the contract instance resolves', async () => {
    await expect(getDeploymentState(CONTRACT_ID)).resolves.toBe('deployed')
    expect(getContractData).toHaveBeenCalledWith(
      CONTRACT_ID,
      expect.anything(),
      SorobanRpc.Durability.Persistent,
    )
  })

  // Breaks: a never-spent wallet is treated as unknown, so the caller proceeds without ever proving the contract is absent.
  it('reports undeployed when the node says the instance is missing', async () => {
    getContractData.mockRejectedValue(new Error('Error(Storage, MissingValue)'))

    await expect(getDeploymentState(CONTRACT_ID)).resolves.toBe('undeployed')
  })

  // Breaks: a network blip is told to the user as "your wallet does not exist", which is false for a funded wallet.
  it('reports unknown when the RPC itself fails', async () => {
    getContractData.mockRejectedValue(new Error('fetch failed'))

    await expect(getDeploymentState(CONTRACT_ID)).resolves.toBe('unknown')
  })
})

describe('ensureWalletDeployed', () => {
  // Breaks: the module asks the RPC about null and throws an SDK error instead of the unlock instruction.
  it('refuses a missing address before any network call', async () => {
    await expect(ensureWalletDeployed(deploy, null)).rejects.toThrow(
      'No wallet address in this session',
    )

    expect(getContractData).not.toHaveBeenCalled()
    expect(deploy).not.toHaveBeenCalled()
  })

  // Breaks: a deployed wallet is redeployed on every spend; the factory refuses the duplicate and the user sees a failure for a working wallet.
  it('does not deploy a wallet the chain already has', async () => {
    await expect(ensureWalletDeployed(deploy, CONTRACT_ID)).resolves.toBeUndefined()
    expect(deploy).not.toHaveBeenCalled()
  })

  // Breaks: a browser with no fee payer asks the network to deploy with no funding source, producing an opaque error instead of "unlock again".
  it('reports no spending key when the fee payer is absent', async () => {
    getContractData.mockRejectedValue(new Error('Error(Storage, MissingValue)'))
    mockPeekFeePayerKeypair.mockReturnValue(null)

    const err = await ensureWalletDeployed(deploy, CONTRACT_ID).catch((e: unknown) => e)

    expect(err).toBeInstanceOf(WalletNotActivatedError)
    expect((err as WalletNotActivatedError).spendingAddress).toBeNull()
    expect(deploy).not.toHaveBeenCalled()
  })

  // Breaks: the user is shown a raw Horizon 404 instead of the full spending address they must fund.
  it('turns an unfunded fee payer (Horizon 404) into an actionable error', async () => {
    getContractData.mockRejectedValue(new Error('Error(Storage, MissingValue)'))
    loadAccount.mockRejectedValue(
      Object.assign(new Error('Not Found'), { response: { status: 404 } }),
    )

    const err = await ensureWalletDeployed(deploy, CONTRACT_ID).catch((e: unknown) => e)

    expect(err).toBeInstanceOf(WalletNotActivatedError)
    const spendingAddress = feePayer.publicKey()
    expect(spendingAddress).toHaveLength(56)
    expect((err as WalletNotActivatedError).spendingAddress).toBe(spendingAddress)
    expect((err as WalletNotActivatedError).message).toContain(spendingAddress)
    expect(deploy).not.toHaveBeenCalled()
  })

  // Breaks: a 500 from Horizon is misreported as an unfunded wallet, telling a funded user to send XLM they do not need.
  it('rethrows a Horizon failure that is not a 404', async () => {
    getContractData.mockRejectedValue(new Error('Error(Storage, MissingValue)'))
    const horizonFailure = Object.assign(new Error('Horizon unavailable'), {
      response: { status: 503 },
    })
    loadAccount.mockRejectedValue(horizonFailure)

    await expect(ensureWalletDeployed(deploy, CONTRACT_ID)).rejects.toBe(horizonFailure)
    expect(deploy).not.toHaveBeenCalled()
  })

  // Breaks: a transport failure with no HTTP status is read as "unfunded" and the user is told to send XLM for a network outage.
  it('rethrows a transport failure that has no response status', async () => {
    getContractData.mockRejectedValue(new Error('Error(Storage, MissingValue)'))
    const transportFailure = new Error('fetch failed')
    loadAccount.mockRejectedValue(transportFailure)

    await expect(ensureWalletDeployed(deploy, CONTRACT_ID)).rejects.toBe(transportFailure)
    expect(deploy).not.toHaveBeenCalled()
  })

  // Breaks: an empty spending account surfaces the raw simulation text instead of the address the user must top up.
  it.each(['insufficient balance', 'account underfunded', 'balance too low', 'txInsufficientFee'])(
    'turns a deploy rejection (%s) into the funded-address error',
    async (message) => {
      getContractData.mockRejectedValue(new Error('Error(Storage, MissingValue)'))
      deploy.mockRejectedValue(new Error(message))

      const err = await ensureWalletDeployed(deploy, CONTRACT_ID).catch((e: unknown) => e)

      expect(err).toBeInstanceOf(WalletNotActivatedError)
      const spendingAddress = feePayer.publicKey()
      expect(spendingAddress).toHaveLength(56)
      expect((err as WalletNotActivatedError).spendingAddress).toBe(spendingAddress)
      expect((err as WalletNotActivatedError).message).toContain(spendingAddress)
      expect(deploy).toHaveBeenCalledWith(feePayer.secret())
    },
  )

  // Breaks: an SDK that rejects with a string instead of an Error is rethrown raw, losing the funded-address instruction.
  it('recognises an unfunded rejection that is not an Error object', async () => {
    getContractData.mockRejectedValue(new Error('Error(Storage, MissingValue)'))
    deploy.mockRejectedValue('insufficient balance')

    const err = await ensureWalletDeployed(deploy, CONTRACT_ID).catch((e: unknown) => e)

    expect(err).toBeInstanceOf(WalletNotActivatedError)
    expect((err as WalletNotActivatedError).spendingAddress).toBe(feePayer.publicKey())
  })

  // Breaks: a real defect is disguised as an unfunded wallet, so the user tops up XLM and retries a deploy that can never succeed.
  it('rethrows a deploy failure that is not about funding', async () => {
    getContractData.mockRejectedValue(new Error('Error(Storage, MissingValue)'))
    const deployFailure = new Error('Transaction rejected: invalid signature')
    deploy.mockRejectedValue(deployFailure)

    await expect(ensureWalletDeployed(deploy, CONTRACT_ID)).rejects.toBe(deployFailure)
    expect(deploy).toHaveBeenCalledTimes(1)
  })
})

describe('ensureWalletDeployed retry safety', () => {
  // Breaks: a retry after a submission failure could pick a different fee payer, stranding XLM sent to the first spending address.
  it('retries with the same fee payer after a failed submission', async () => {
    getContractData.mockRejectedValue(new Error('Error(Storage, MissingValue)'))
    const submissionFailure = new Error('Transaction failed with status: TRY_AGAIN_LATER')
    deploy.mockRejectedValueOnce(submissionFailure)

    await expect(ensureWalletDeployed(deploy, CONTRACT_ID)).rejects.toBe(submissionFailure)
    await expect(ensureWalletDeployed(deploy, CONTRACT_ID)).resolves.toBeUndefined()

    expect(deploy).toHaveBeenCalledTimes(2)
    const [firstSecret] = deploy.mock.calls[0]
    const [secondSecret] = deploy.mock.calls[1]
    expect(secondSecret).toBe(firstSecret)
    expect(secondSecret).toBe(feePayer.secret())
  })

  // Breaks: a deploy that actually landed is submitted again, and the factory's duplicate refusal becomes a permanent error for a live wallet.
  it('does not redeploy when the failed attempt actually landed', async () => {
    getContractData
      .mockRejectedValueOnce(new Error('fetch failed'))
      .mockResolvedValueOnce({} as never)
    const submissionFailure = new Error('Transaction failed with status: TRY_AGAIN_LATER')
    deploy.mockRejectedValueOnce(submissionFailure)

    await expect(ensureWalletDeployed(deploy, CONTRACT_ID)).rejects.toBe(submissionFailure)
    await expect(ensureWalletDeployed(deploy, CONTRACT_ID)).resolves.toBeUndefined()

    expect(getContractData).toHaveBeenCalledTimes(2)
    expect(deploy).toHaveBeenCalledTimes(1)
  })

  // Breaks: a wallet deployed by a concurrent request is treated as a fresh deploy, producing a second attempt the factory refuses.
  it('treats an already-deployed factory result as success', async () => {
    getContractData.mockRejectedValue(new Error('Error(Storage, MissingValue)'))
    deploy.mockResolvedValue({ alreadyDeployed: true })

    await expect(ensureWalletDeployed(deploy, CONTRACT_ID)).resolves.toBeUndefined()
    expect(deploy).toHaveBeenCalledTimes(1)
  })

  // Breaks: an RPC blip blocks the first spend of a brand-new wallet, even though deployment is idempotent at the SDK level.
  it('still deploys when the state is unknown', async () => {
    getContractData.mockRejectedValue(new Error('fetch failed'))

    await expect(ensureWalletDeployed(deploy, CONTRACT_ID)).resolves.toBeUndefined()
    expect(deploy).toHaveBeenCalledWith(feePayer.secret())
  })
})
