// jsdom has no TextEncoder, and the Stellar SDK needs one the moment it loads.
// Must run before anything imports the SDK, including the mock factory below.
if (typeof TextEncoder === 'undefined') {
  const { TextEncoder: TE, TextDecoder: TD } = require('util')
  global.TextEncoder = TE
  global.TextDecoder = TD
}

import { Keypair } from '@stellar/stellar-sdk'

const mockGetContractData = jest.fn()
const mockLoadAccount = jest.fn()
const mockPeekFeePayerKeypair = jest.fn()

jest.mock('@stellar/stellar-sdk', () => {
  const actual = jest.requireActual('@stellar/stellar-sdk')
  return {
    ...actual,
    rpc: {
      ...actual.rpc,
      Server: jest.fn().mockImplementation(() => ({
        getContractData: (...args: unknown[]) => mockGetContractData(...args),
      })),
    },
    Horizon: {
      ...actual.Horizon,
      Server: jest.fn().mockImplementation(() => ({
        loadAccount: (...args: unknown[]) => mockLoadAccount(...args),
      })),
    },
  }
})

jest.mock('../network', () => ({
  getNetwork: () => ({ rpcUrl: 'https://rpc.test', horizonUrl: 'https://horizon.test' }),
}))

jest.mock('../feePayer', () => ({
  peekFeePayerKeypair: () => mockPeekFeePayerKeypair(),
}))

import {
  WalletNotActivatedError,
  ensureWalletDeployed,
  getDeploymentState,
} from '../walletDeployment'

const WALLET = 'CABCH3GZPGJOOZXPLN4EBXTLZSV6BUGFBXIKMNO2VJIPZ7ERENL7PCJ7'

function horizon404() {
  return Object.assign(new Error('Not Found'), { response: { status: 404 } })
}

beforeEach(() => {
  mockGetContractData.mockReset()
  mockLoadAccount.mockReset()
  mockPeekFeePayerKeypair.mockReset()
})

describe('getDeploymentState', () => {
  it('reports deployed when the contract instance exists', async () => {
    mockGetContractData.mockResolvedValue({})
    await expect(getDeploymentState(WALLET)).resolves.toBe('deployed')
  })

  it('reports undeployed when the RPC says the instance is not found', async () => {
    mockGetContractData.mockRejectedValue(new Error('Contract data not found'))
    await expect(getDeploymentState(WALLET)).resolves.toBe('undeployed')
  })

  it('reports unknown, not undeployed, when the RPC cannot be reached', async () => {
    // An unreachable RPC read as "undeployed" would show a working wallet as
    // not set up for as long as the network blinked.
    mockGetContractData.mockRejectedValue(new Error('socket hang up'))
    await expect(getDeploymentState(WALLET)).resolves.toBe('unknown')
  })

  it('does not ask the network about something that is not a contract address', async () => {
    await expect(getDeploymentState('GA6HCMBLTZS5VYYBCATRBRZ3BZJMAFUDKYYF6AH6MVCMGWMRDNSWJPIH')).resolves.toBe('unknown')
    await expect(getDeploymentState(null)).resolves.toBe('unknown')
    expect(mockGetContractData).not.toHaveBeenCalled()
  })
})

describe('ensureWalletDeployed', () => {
  it('does nothing for a wallet already on chain', async () => {
    mockGetContractData.mockResolvedValue({})
    const deploy = jest.fn()

    await ensureWalletDeployed(deploy, WALLET)

    expect(deploy).not.toHaveBeenCalled()
  })

  it('deploys with the spending key when the wallet is not on chain yet', async () => {
    const feePayer = Keypair.random()
    mockGetContractData.mockRejectedValue(new Error('not found'))
    mockPeekFeePayerKeypair.mockReturnValue(feePayer)
    mockLoadAccount.mockResolvedValue({})
    const deploy = jest.fn().mockResolvedValue({})

    await ensureWalletDeployed(deploy, WALLET)

    expect(deploy).toHaveBeenCalledWith(feePayer.secret())
  })

  it('says where to send XLM when the spending account does not exist', async () => {
    const feePayer = Keypair.random()
    mockGetContractData.mockRejectedValue(new Error('not found'))
    mockPeekFeePayerKeypair.mockReturnValue(feePayer)
    mockLoadAccount.mockRejectedValue(horizon404())
    const deploy = jest.fn()

    const attempt = ensureWalletDeployed(deploy, WALLET)

    await expect(attempt).rejects.toBeInstanceOf(WalletNotActivatedError)
    await expect(attempt).rejects.toMatchObject({ spendingAddress: feePayer.publicKey() })
    expect(deploy).not.toHaveBeenCalled()
  })

  it('turns an underfunded deploy into the same actionable error', async () => {
    const feePayer = Keypair.random()
    mockGetContractData.mockRejectedValue(new Error('not found'))
    mockPeekFeePayerKeypair.mockReturnValue(feePayer)
    mockLoadAccount.mockResolvedValue({})
    const deploy = jest.fn().mockRejectedValue(new Error('txInsufficientBalance'))

    await expect(ensureWalletDeployed(deploy, WALLET)).rejects.toMatchObject({
      name: 'WalletNotActivatedError',
      spendingAddress: feePayer.publicKey(),
    })
  })

  it('passes through a deploy failure that is not about funds', async () => {
    mockGetContractData.mockRejectedValue(new Error('not found'))
    mockPeekFeePayerKeypair.mockReturnValue(Keypair.random())
    mockLoadAccount.mockResolvedValue({})
    const deploy = jest.fn().mockRejectedValue(new Error('User cancelled the passkey prompt'))

    await expect(ensureWalletDeployed(deploy, WALLET)).rejects.toThrow('User cancelled the passkey prompt')
  })

  it('refuses without a spending key rather than deploying nothing', async () => {
    mockGetContractData.mockRejectedValue(new Error('not found'))
    mockPeekFeePayerKeypair.mockReturnValue(null)

    await expect(ensureWalletDeployed(jest.fn(), WALLET)).rejects.toMatchObject({
      name: 'WalletNotActivatedError',
      spendingAddress: null,
    })
  })

  it('refuses without a wallet address', async () => {
    await expect(ensureWalletDeployed(jest.fn(), null)).rejects.toThrow(/No wallet address/)
  })
})
