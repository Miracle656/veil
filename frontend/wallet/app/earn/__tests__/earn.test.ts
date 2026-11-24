import { TextEncoder, TextDecoder } from 'util'
Object.assign(globalThis, { TextEncoder, TextDecoder })

const mockLoadBlendPools = jest.fn()
const mockLoadBlendPositions = jest.fn()
const mockBuildBlendSupplyXdr = jest.fn()
const mockBuildBlendWithdrawXdr = jest.fn()
const mockDepositToVault = jest.fn()
const mockFetchLatestLedgerTimestamp = jest.fn()
const mockFetchVaultDetails = jest.fn()
const mockRequirePasskey = jest.fn()
const mockSignAndSubmitSorobanXdr = jest.fn()

jest.mock('next/navigation', () => ({
  useRouter: () => ({ replace: jest.fn(), push: jest.fn() }),
  useSearchParams: () => new URLSearchParams(),
}))

jest.mock('@/hooks/useInactivityLock', () => ({ useInactivityLock: jest.fn() }))
jest.mock('@/components/ui/primitives', () => ({ PageHeader: () => null }))
jest.mock('@/components/ui/VeilMark', () => ({ VeilMark: () => null }))
jest.mock('@/lib/txState', () => ({ beginTx: jest.fn(), endTx: jest.fn() }))
jest.mock('@/lib/passkeyAuth', () => ({ requirePasskey: (...args: unknown[]) => mockRequirePasskey(...args) }))
jest.mock('@/lib/passkeyOutcome', () => ({
  PasskeyCeremonyError: class extends Error {},
  isPasskeyCancellation: () => false,
}))
jest.mock('@/lib/blend', () => ({
  loadBlendPools: (...args: unknown[]) => mockLoadBlendPools(...args),
  loadBlendPositions: (...args: unknown[]) => mockLoadBlendPositions(...args),
  buildBlendSupplyXdr: (...args: unknown[]) => mockBuildBlendSupplyXdr(...args),
  buildBlendWithdrawXdr: (...args: unknown[]) => mockBuildBlendWithdrawXdr(...args),
}))
jest.mock('@/lib/sorobanTx', () => ({
  signAndSubmitSorobanXdr: (...args: unknown[]) => mockSignAndSubmitSorobanXdr(...args),
}))
jest.mock('@/lib/vault', () => ({
  depositToVault: (...args: unknown[]) => mockDepositToVault(...args),
  fetchLatestLedgerTimestamp: (...args: unknown[]) => mockFetchLatestLedgerTimestamp(...args),
  fetchVaultDetails: (...args: unknown[]) => mockFetchVaultDetails(...args),
  VAULT_STORAGE_KEY: 'veil_vault_contract',
}))

import React, { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { Asset, Keypair } from '@stellar/stellar-sdk'
import EarnPage from '../page'
import { getNetwork } from '@/lib/network'
import { walletLocal, walletSession } from '@/lib/walletStorage'
import { formatLocalDateTime } from '@/lib/savings'

const OWNER = Keypair.fromRawEd25519Seed(Buffer.alloc(32, 7))
const NATIVE = Asset.native().contractId(getNetwork().networkPassphrase)
const POOL = {
  id: 'CPOOL',
  name: 'Fixed pool',
  assets: [NATIVE],
  reserves: [{ assetId: NATIVE, code: 'XLM' as const, supplyApy: 0.0125, utilization: 0.95 }],
}
const VAULT = {
  contractId: 'CVault',
  config: { owner: OWNER.publicKey(), token: NATIVE, delaySeconds: 86_400 },
  balanceStroops: 0n,
  balanceXlm: '0',
  reservedStroops: 0n,
  reservedXlm: '0',
  availableStroops: 0n,
  availableXlm: '0',
  withdrawals: [],
}
const LEDGER_TIME = 1_800_000_000

let container: HTMLDivElement
let root: Root

function findButton(text: string): HTMLButtonElement {
  const button = [...container.querySelectorAll('button')]
    .find((candidate) => candidate.textContent?.includes(text))
  if (!button) throw new Error(`Could not find button containing "${text}".`)
  return button
}

async function clickButton(text: string): Promise<void> {
  act(() => {
    findButton(text).dispatchEvent(new MouseEvent('click', { bubbles: true }))
  })
  await new Promise((resolve) => setTimeout(resolve, 0))
}

async function enterAmount(value: string): Promise<void> {
  act(() => {
    const input = container.querySelector<HTMLInputElement>('input[aria-label="Amount in XLM"]')
    if (!input) throw new Error('Could not find the XLM amount input.')
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set
    if (!setter) throw new Error('Could not find the input value setter.')
    setter.call(input, value)
    input.dispatchEvent(new Event('input', { bubbles: true }))
  })
  await new Promise((resolve) => setTimeout(resolve, 0))
}

async function renderPage(): Promise<void> {
  act(() => {
    root.render(createElement(EarnPage))
  })
  for (let attempt = 0; attempt < 40; attempt += 1) {
    const depositButton = [...container.querySelectorAll('button')]
      .find((candidate) => candidate.textContent?.includes('Deposit XLM'))
    if (depositButton) return
    await new Promise((resolve) => setTimeout(resolve, 25))
  }
  throw new Error('Earn page did not render the deposit choices.')
}

beforeEach(() => {
  ;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true
  localStorage.clear()
  sessionStorage.clear()
  walletSession.setItem('invisible_wallet_address', OWNER.publicKey())
  walletSession.setItem('veil_signer_secret', OWNER.secret())
  walletLocal.setItem('veil_signer_public_key', OWNER.publicKey())
  localStorage.setItem('veil_vault_contract', VAULT.contractId)
  mockLoadBlendPools.mockReset().mockResolvedValue([POOL])
  mockLoadBlendPositions.mockReset().mockResolvedValue([])
  mockBuildBlendSupplyXdr.mockReset().mockResolvedValue('blend-xdr')
  mockBuildBlendWithdrawXdr.mockReset()
  mockDepositToVault.mockReset().mockResolvedValue('vault-tx-hash')
  mockFetchLatestLedgerTimestamp.mockReset().mockResolvedValue(LEDGER_TIME)
  mockFetchVaultDetails.mockReset().mockResolvedValue(VAULT)
  mockRequirePasskey.mockReset().mockResolvedValue(undefined)
  mockSignAndSubmitSorobanXdr.mockReset().mockResolvedValue('blend-tx-hash')
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
  localStorage.clear()
  sessionStorage.clear()
})

describe('Earn deposit choice', () => {
  it('does not prepare a transaction until a savings path is chosen and confirmed', async () => {
    await renderPage()
    await clickButton('Deposit XLM')
    await enterAmount('1')

    expect(findButton('Review deposit').disabled).toBe(true)
    expect(mockBuildBlendSupplyXdr).not.toHaveBeenCalled()
    expect(mockDepositToVault).not.toHaveBeenCalled()
    expect(mockSignAndSubmitSorobanXdr).not.toHaveBeenCalled()
  })

  it('confirms Flexible with liquidity copy and no lock date, then supplies to Blend', async () => {
    await renderPage()
    await clickButton('Deposit XLM')
    await enterAmount('1')
    await clickButton('Flexible')
    await clickButton('Review deposit')

    expect(container.textContent).toContain('subject to pool liquidity')
    expect(container.textContent).toContain('95.0% (nearly fully utilised)')
    expect(container.textContent).toContain('No lock date')
    expect(container.textContent).not.toContain('Earliest projected reach')
    expect(mockBuildBlendSupplyXdr).not.toHaveBeenCalled()
    expect(mockDepositToVault).not.toHaveBeenCalled()

    await clickButton('Confirm and sign Blend supply')

    expect(mockBuildBlendSupplyXdr).toHaveBeenCalledWith(expect.objectContaining({
      poolId: 'CPOOL',
      assetContract: NATIVE,
    }))
    expect(mockSignAndSubmitSorobanXdr).toHaveBeenCalled()
    expect(mockDepositToVault).not.toHaveBeenCalled()
  })

  it('confirms Locked with the projected local unlock date and early-exit rule, then deposits to the vault', async () => {
    await renderPage()
    await clickButton('Deposit XLM')
    await enterAmount('2.5')
    await clickButton('Locked')
    await clickButton('Review deposit')

    const expectedUnlock = LEDGER_TIME + VAULT.config.delaySeconds
    expect(container.textContent).toContain('1 day (1 day)')
    expect(container.textContent).toContain(formatLocalDateTime(expectedUnlock))
    expect(container.textContent).toContain('queue a withdrawal, wait for the full delay, then execute it')
    expect(container.textContent).toContain('no early-exit penalty')
    expect(container.textContent).toContain('commitment device, not a better deal')
    expect(container.textContent).not.toContain('% APY')
    expect(mockBuildBlendSupplyXdr).not.toHaveBeenCalled()
    expect(mockDepositToVault).not.toHaveBeenCalled()

    await clickButton('Confirm and sign vault deposit')

    expect(mockDepositToVault).toHaveBeenCalledWith({
      contractId: VAULT.contractId,
      amountXlm: '2.5',
      signerSecret: OWNER.secret(),
    })
    expect(mockBuildBlendSupplyXdr).not.toHaveBeenCalled()
    expect(container.textContent).toContain('Manage locked funds')
    expect([...container.querySelectorAll('button')].some((button) => button.textContent?.includes('Flexible'))).toBe(false)
  })

  it('does not render a rate when Blend has no runtime rate for the reserve', async () => {
    mockLoadBlendPools.mockResolvedValue([{
      ...POOL,
      reserves: [{ ...POOL.reserves[0], supplyApy: null }],
    }])
    await renderPage()
    await clickButton('Deposit XLM')

    expect(container.textContent).toContain('Blend APY unavailable')
    expect(container.textContent).not.toContain('% Blend APY')
  })
})
