import { TextEncoder, TextDecoder } from 'util'
Object.assign(globalThis, { TextEncoder, TextDecoder })

import {
  isPrivacyEnabled,
  getPrivacyConfig,
  PRIVACY_CONFIGS,
} from '../privacy/config'
import {
  getPrivateBalance,
  setPrivateBalance,
  unshield,
} from '../privacy/client'
import { walletLocal } from '../walletStorage'

describe('Privacy Config & Mainnet Lockout', () => {
  it('enables privacy on testnet and strictly locks out mainnet', () => {
    expect(isPrivacyEnabled('testnet')).toBe(true)
    expect(isPrivacyEnabled('mainnet')).toBe(false)
  })

  it('returns canonical SPP testnet pool configurations', () => {
    const config = getPrivacyConfig('testnet')
    expect(config).not.toBeNull()
    expect(config?.pools.XLM.contractId).toBe('CD2W5LURT7H33ZMSXZQZNDD2MDR725J3B6Y7G22Y26L65I32FHK4XZ4L')
    expect(config?.pools.EURC.contractId).toBe('CBMRWHTP23BAMQZ73N4Y5V5KDJM2KEX77R5G6H3N4WUSQ7R2T2J2NUVS')
  })

  it('returns null config on mainnet', () => {
    expect(getPrivacyConfig('mainnet')).toBeNull()
  })
})

describe('Privacy Client & Unshield Flow', () => {
  beforeEach(() => {
    walletLocal.setItem('veil_private_bal_XLM', '100.0000000')
    walletLocal.setItem('veil_private_bal_USDC', '50.0000000')
  })

  it('loads and manages private balance correctly', async () => {
    const balance = await getPrivateBalance('XLM')
    expect(balance).toBe('100.0000000')

    await setPrivateBalance('80.0000000', 'XLM')
    const updated = await getPrivateBalance('XLM')
    expect(updated).toBe('80.0000000')
  })

  it('blocks withdrawing more than private balance before any proof is generated', async () => {
    const onProgress = jest.fn()

    await expect(
      unshield({
        amount: '150.0000000',
        asset: 'XLM',
        destinationAddress: 'GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5',
        onProgress,
      }),
    ).rejects.toThrow(/Insufficient private balance/)

    // Proof progress should never have been triggered
    expect(onProgress).not.toHaveBeenCalled()

    // Balance must remain unchanged
    const balance = await getPrivateBalance('XLM')
    expect(balance).toBe('100.0000000')
  })

  it('blocks invalid withdrawal amounts (zero or negative)', async () => {
    await expect(
      unshield({
        amount: '0',
        asset: 'XLM',
        destinationAddress: 'GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5',
      }),
    ).rejects.toThrow(/Invalid withdrawal amount/)

    await expect(
      unshield({
        amount: '-10.5',
        asset: 'XLM',
        destinationAddress: 'GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5',
      }),
    ).rejects.toThrow(/Invalid withdrawal amount/)
  })

  it('blocks invalid or missing destination address', async () => {
    await expect(
      unshield({
        amount: '20.0000000',
        asset: 'XLM',
        destinationAddress: '',
      }),
    ).rejects.toThrow(/Valid destination address required/)
  })

  it('successfully executes unshield, notifies progress, and updates private balance', async () => {
    const progressSteps: string[] = []
    const dest = 'GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5'

    const result = await unshield({
      amount: '35.0000000',
      asset: 'XLM',
      destinationAddress: dest,
      onProgress: (status) => progressSteps.push(status),
    })

    expect(result.amount).toBe('35.0000000')
    expect(result.asset).toBe('XLM')
    expect(result.destinationAddress).toBe(dest)
    expect(result.txHash).toBeDefined()
    expect(result.txHash.length).toBe(64)

    // Verify progress callbacks were invoked
    expect(progressSteps.length).toBeGreaterThan(0)
    expect(progressSteps.some((s) => s.includes('proof'))).toBe(true)

    // Verify private balance was decremented (100 - 35 = 65)
    const newBal = await getPrivateBalance('XLM')
    expect(newBal).toBe('65.0000000')
  })
})
