import { TextEncoder, TextDecoder } from 'util'
Object.assign(globalThis, { TextEncoder, TextDecoder, IS_REACT_ACT_ENVIRONMENT: true })

import * as React from 'react'
import { act, createElement } from 'react'
Object.assign(globalThis, { React })
import { createRoot, type Root } from 'react-dom/client'
import {
  Account,
  Asset,
  BASE_FEE,
  Horizon,
  Keypair,
  Networks,
  Operation,
  StrKey,
  TransactionBuilder,
  type Transaction,
} from '@stellar/stellar-sdk'

const mockPush = jest.fn()
const mockBack = jest.fn()
const mockRequirePasskey = jest.fn<Promise<void>, []>()

jest.mock('next/navigation', () => ({
  useRouter: () => ({ push: mockPush, back: mockBack }),
}))

jest.mock('@/hooks/useInactivityLock', () => ({
  useInactivityLock: () => {},
}))

jest.mock('@/lib/passkeyAuth', () => ({
  requirePasskey: () => mockRequirePasskey(),
}))

import AgentPage from '../page'

const WALLET_CONTRACT = StrKey.encodeContract(Buffer.alloc(32, 9))

function buildUnsignedTx(
  source: Keypair,
  addOps: (builder: TransactionBuilder) => TransactionBuilder,
): string {
  const builder = new TransactionBuilder(new Account(source.publicKey(), '10'), {
    fee: BASE_FEE,
    networkPassphrase: Networks.TESTNET,
  })
  return addOps(builder).setTimeout(180).build().toXDR()
}

function setNativeInputValue(input: HTMLInputElement, value: string): void {
  const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')?.set
  setter?.call(input, value)
  input.dispatchEvent(new Event('input', { bubbles: true }))
  input.dispatchEvent(new Event('change', { bubbles: true }))
}

describe('AgentPage approval flow (#1315)', () => {
  let container: HTMLDivElement
  let root: Root
  let feePayer: Keypair
  let recipient: Keypair
  let stranger: Keypair
  let submitSpy: jest.SpiedFunction<typeof Horizon.Server.prototype.submitTransaction>
  let originalFetch: typeof global.fetch | undefined

  beforeEach(() => {
    jest.clearAllMocks()
    localStorage.clear()
    sessionStorage.clear()

    feePayer = Keypair.random()
    recipient = Keypair.random()
    stranger = Keypair.random()

    localStorage.setItem(
      'veil_user_profile',
      JSON.stringify({ name: 'Ada', role: 'saver', language: 'English' }),
    )
    sessionStorage.setItem('invisible_wallet_address', WALLET_CONTRACT)
    sessionStorage.setItem('veil_signer_secret', feePayer.secret())

    Element.prototype.scrollIntoView = jest.fn()
    mockRequirePasskey.mockResolvedValue(undefined)
    submitSpy = jest
      .spyOn(Horizon.Server.prototype, 'submitTransaction')
      .mockResolvedValue({ hash: 'deadbeef1315' } as Horizon.HorizonApi.SubmitTransactionResponse)

    originalFetch = global.fetch

    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
  })

  afterEach(async () => {
    await act(async () => {
      root.unmount()
    })
    container.remove()
    submitSpy.mockRestore()
    if (originalFetch) {
      global.fetch = originalFetch
    }
  })

  async function sendChatAndReceive(replyBody: Record<string, unknown>, prompt = 'Send 25 XLM') {
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => replyBody,
    } as unknown as Response)

    await act(async () => {
      root.render(createElement(AgentPage))
    })

    const input = container.querySelector('input.agent-input') as HTMLInputElement
    expect(input).not.toBeNull()

    await act(async () => {
      setNativeInputValue(input, prompt)
    })

    const sendButton = container.querySelector('button[aria-label="Send message"]') as HTMLButtonElement
    expect(sendButton).not.toBeNull()
    expect(sendButton.disabled).toBe(false)

    await act(async () => {
      sendButton.click()
    })
  }

  it('requires an explicit destination and amount confirmation step before passkey signing', async () => {
    const paymentXdr = buildUnsignedTx(feePayer, (b) =>
      b.addOperation(
        Operation.payment({
          destination: recipient.publicKey(),
          asset: Asset.native(),
          amount: '25.5000000',
        }),
      ),
    )

    await sendChatAndReceive({
      response: 'I prepared your payment.',
      pendingTxXdr: paymentXdr,
      // Model summary intentionally disagrees with the XDR to prove UI uses decoded XDR
      pendingTxSummary: 'Send 1 XLM to a friend',
    })

    const card = container.querySelector('[data-testid="agent-proposal-card"]')
    expect(card).not.toBeNull()
    expect(container.querySelector('[data-testid="agent-explicit-confirmation"]')).toBeNull()
    expect(mockRequirePasskey).not.toHaveBeenCalled()
    expect(submitSpy).not.toHaveBeenCalled()

    // Step 1 -> Step 2: advance to the explicit destination & amount confirmation view
    const reviewBtn = container.querySelector(
      '[data-testid="review-confirmation-step-button"]',
    ) as HTMLButtonElement
    expect(reviewBtn).not.toBeNull()

    await act(async () => {
      reviewBtn.click()
    })

    const confirmPanel = container.querySelector('[data-testid="agent-explicit-confirmation"]')
    expect(confirmPanel).not.toBeNull()
    expect(container.querySelector('[data-testid="confirm-amount"]')?.textContent).toBe(
      '25.5000000 XLM',
    )
    expect(container.querySelector('[data-testid="confirm-destination"]')?.textContent).toBe(
      recipient.publicKey(),
    )

    const confirmAndSignBtn = container.querySelector(
      '[data-testid="confirm-and-sign-button"]',
    ) as HTMLButtonElement
    expect(confirmAndSignBtn).not.toBeNull()
    // Cannot sign before ticking the explicit destination + amount confirmation checkbox
    expect(confirmAndSignBtn.disabled).toBe(true)
    expect(mockRequirePasskey).not.toHaveBeenCalled()
    expect(submitSpy).not.toHaveBeenCalled()

    const checkbox = container.querySelector(
      '[data-testid="confirm-destination-amount-checkbox"]',
    ) as HTMLInputElement
    expect(checkbox).not.toBeNull()

    await act(async () => {
      checkbox.click()
    })
    expect(confirmAndSignBtn.disabled).toBe(false)

    await act(async () => {
      confirmAndSignBtn.click()
    })

    expect(mockRequirePasskey).toHaveBeenCalledTimes(1)
    expect(submitSpy).toHaveBeenCalledTimes(1)
    const submittedTx = submitSpy.mock.calls[0][0] as Transaction
    expect(submittedTx.source).toBe(feePayer.publicKey())
    expect(submittedTx.signatures.length).toBe(1)
    expect(container.textContent).toContain('Transaction submitted.')
    expect(container.textContent).toContain('deadbeef1315')
  })

  it('refuses a transaction containing an unsupported operation and never prompts passkey or signs', async () => {
    const takeoverXdr = buildUnsignedTx(feePayer, (b) =>
      b
        .addOperation(
          Operation.payment({
            destination: recipient.publicKey(),
            asset: Asset.native(),
            amount: '1.0000000',
          }),
        )
        .addOperation(Operation.setOptions({ masterWeight: 0 })),
    )

    await sendChatAndReceive({
      response: 'Approve this harmless 1 XLM payment.',
      pendingTxXdr: takeoverXdr,
      pendingTxSummary: 'Send 1 XLM',
    })

    const refusalEl = container.querySelector('[data-testid="agent-proposal-refusal"]')
    expect(refusalEl).not.toBeNull()
    expect(refusalEl?.textContent).toMatch(/contains an operation this app cannot show you/)
    expect(container.querySelector('[data-testid="review-confirmation-step-button"]')).toBeNull()
    expect(container.querySelector('[data-testid="confirm-and-sign-button"]')).toBeNull()
    expect(mockRequirePasskey).not.toHaveBeenCalled()
    expect(submitSpy).not.toHaveBeenCalled()
  })

  it('refuses a transaction sourced from another account and never prompts passkey or signs', async () => {
    const mismatchedSourceXdr = buildUnsignedTx(stranger, (b) =>
      b.addOperation(
        Operation.payment({
          destination: recipient.publicKey(),
          asset: Asset.native(),
          amount: '5.0000000',
        }),
      ),
    )

    await sendChatAndReceive({
      response: 'Approve this payment.',
      pendingTxXdr: mismatchedSourceXdr,
      pendingTxSummary: 'Send 5 XLM',
    })

    const refusalEl = container.querySelector('[data-testid="agent-proposal-refusal"]')
    expect(refusalEl).not.toBeNull()
    expect(refusalEl?.textContent).toMatch(/not this wallet's fee payer/)
    expect(container.querySelector('[data-testid="review-confirmation-step-button"]')).toBeNull()
    expect(container.querySelector('[data-testid="confirm-and-sign-button"]')).toBeNull()
    expect(mockRequirePasskey).not.toHaveBeenCalled()
    expect(submitSpy).not.toHaveBeenCalled()
  })

  it('allows declining a valid proposal without signing or submitting', async () => {
    const paymentXdr = buildUnsignedTx(feePayer, (b) =>
      b.addOperation(
        Operation.payment({
          destination: recipient.publicKey(),
          asset: Asset.native(),
          amount: '3.0000000',
        }),
      ),
    )

    await sendChatAndReceive({
      response: 'Ready when you are.',
      pendingTxXdr: paymentXdr,
      pendingTxSummary: 'Send 3 XLM',
    })

    const declineBtn = container.querySelector(
      '[data-testid="decline-proposal-button"]',
    ) as HTMLButtonElement
    expect(declineBtn).not.toBeNull()

    await act(async () => {
      declineBtn.click()
    })

    expect(container.querySelector('[data-testid="agent-proposal-card"]')).toBeNull()
    expect(container.textContent).toContain('Cancelled — nothing was sent.')
    expect(mockRequirePasskey).not.toHaveBeenCalled()
    expect(submitSpy).not.toHaveBeenCalled()
  })
})
