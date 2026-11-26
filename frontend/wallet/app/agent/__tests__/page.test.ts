// Page-level test for the web agent approval flow (default export of page.tsx).
//
// Covers: rendering decoded transaction details, requiring an explicit
// destination & amount confirmation before signing can proceed, and refusing
// disallowed operations / mismatched source accounts. The refusal rules
// themselves (proposalRefusal) live in agentMessages and are covered there.

// react-dom/server needs TextEncoder at module load; jsdom omits it.
import { TextEncoder, TextDecoder } from 'util'
Object.assign(globalThis, { TextEncoder, TextDecoder });

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

jest.mock('next/navigation', () => ({
  useRouter: () => ({ push: jest.fn(), back: jest.fn(), replace: jest.fn() }),
  usePathname: () => '/agent',
  useSearchParams: () => new URLSearchParams(),
}))
jest.mock('@/hooks/useInactivityLock', () => ({ useInactivityLock: jest.fn() }))
jest.mock('@/lib/network', () => ({
  getNetwork: jest.fn(() => ({
    networkPassphrase: 'Test SDF Network ; September 2015',
    horizonUrl: 'http://localhost',
    displayName: 'Testnet',
  })),
}))
jest.mock('@/lib/passkeyAuth', () => ({
  requirePasskey: jest.fn().mockResolvedValue(undefined),
  isPasskeyCancellation: jest.fn(() => false),
}))
jest.mock('@/lib/walletStorage', () => ({
  walletLocal: { getItem: jest.fn(() => null), setItem: jest.fn() },
  walletSession: { getItem: jest.fn(() => null), setItem: jest.fn() },
}))
jest.mock('../../earn/prefill', () => ({ parseInvestIntent: jest.fn(() => null) }))

// Hoisted above the imports below so the mocked modules are registered before
// page.tsx (and this test file) resolves them.
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { createElement } from 'react'
import AgentPage from '../page'
import {
  Account,
  Asset,
  BASE_FEE,
  Keypair,
  Networks,
  Operation,
  TransactionBuilder,
} from '@stellar/stellar-sdk'
import { getNetwork } from '@/lib/network'
import { requirePasskey } from '@/lib/passkeyAuth'
import { walletSession } from '@/lib/walletStorage'

const NETWORK_PASSPHRASE = Networks.TESTNET

const mockGetNetwork = getNetwork as jest.Mock
mockGetNetwork.mockReturnValue({
  networkPassphrase: NETWORK_PASSPHRASE,
  horizonUrl: 'http://localhost',
  displayName: 'Testnet',
})

// The mocked fetch is shared across tests; each test queues its own response.
const mockFetch = jest.fn() as jest.Mock
globalThis.fetch = mockFetch as unknown as typeof fetch

beforeAll(() => {
  Element.prototype.scrollIntoView = jest.fn()
})

const feePayer = Keypair.random()
const destination = Keypair.random().publicKey()
const stranger = Keypair.random()

function buildPaymentXdr(source: string): string {
  return new TransactionBuilder(new Account(source, '0'), {
    fee: BASE_FEE,
    networkPassphrase: NETWORK_PASSPHRASE,
  })
    .addOperation(
      Operation.payment({ destination, asset: Asset.native(), amount: '1.0000000' }),
    )
    .setTimeout(180)
    .build()
    .toXDR()
}

function setOptionsXdr(source: string): string {
  return new TransactionBuilder(new Account(source, '0'), {
    fee: BASE_FEE,
    networkPassphrase: NETWORK_PASSPHRASE,
  })
    .addOperation(Operation.setOptions({ masterWeight: 0 }))
    .setTimeout(180)
    .build()
    .toXDR()
}

function setWallet(secret: string, address: string) {
  const mockGetItem = walletSession.getItem as jest.Mock
  mockGetItem.mockImplementation((key: string) =>
    key === 'veil_signer_secret' ? secret : key === 'invisible_wallet_address' ? address : null,
  )
}

function renderPage() {
  const container = document.createElement('div')
  document.body.appendChild(container)
  const root = createRoot(container)
  act(() => {
    root.render(createElement(AgentPage))
  })
  return {
    container,
    unmount: () => {
      act(() => {
        root.unmount()
      })
      document.body.removeChild(container)
    },
  }
}

async function sendMessage(container: HTMLDivElement, text = 'send payment') {
  const input = container.querySelector(
    'input[placeholder^="Ask me anything"]',
  ) as HTMLInputElement
  const sendBtn = container.querySelector(
    'button[aria-label="Send message"]',
  ) as HTMLButtonElement
  expect(input).not.toBeNull()
  expect(sendBtn).not.toBeNull()
  // Use the native value setter so React 18's controlled onChange state
  // actually updates before the send button is clicked.
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(
      input,
      text,
    )
    input.dispatchEvent(new Event('input', { bubbles: true }))
  })
  await act(async () => {
    sendBtn.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    await new Promise((r) => setTimeout(r, 0))
  })
}

function cardOf(container: HTMLDivElement) {
  return container.querySelector('.agent-tx-card')
}

function buttonOf(container: HTMLDivElement) {
  return container.querySelector('.agent-tx-card__btn') as HTMLButtonElement | null
}

describe('Agent page approval flow', () => {
  beforeEach(() => {
    jest.clearAllMocks()
    // Seed a completed onboarding profile so AgentPage renders the chat
    // composer instead of the setup view (getUserProfile reads localStorage).
    localStorage.setItem(
      'veil_user_profile',
      JSON.stringify({ role: 'explorer', name: 'Tester' }),
    )
    mockGetNetwork.mockReturnValue({
      networkPassphrase: NETWORK_PASSPHRASE,
      horizonUrl: 'http://localhost',
      displayName: 'Testnet',
    })
  })

  afterEach(() => {
    jest.restoreAllMocks()
    localStorage.removeItem('veil_user_profile')
  })

  it('renders the decoded destination and amount and blocks signing until confirmed', async () => {
    setWallet(feePayer.secret(), feePayer.publicKey())
    const xdr = buildPaymentXdr(feePayer.publicKey())
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        response: 'Ready',
        pendingTxXdr: xdr,
        pendingTxSummary: 'Send 1 XLM',
      }),
    })

    const { container, unmount } = renderPage()
    try {
      await sendMessage(container)

      expect(cardOf(container)).not.toBeNull()
      expect(container.textContent).toContain('Destination:')
      expect(container.textContent).toContain(destination)
      expect(container.textContent).toContain('Amount:')
      expect(container.textContent).toContain('1.0000000 XLM')

      const button = buttonOf(container)
      expect(button).not.toBeNull()
      // Signing is blocked until the user explicitly confirms destination & amount.
      expect(button!.disabled).toBe(true)
      expect(button!.textContent).toContain('Confirm destination & amount')

      const checkbox = container.querySelector('input[type="checkbox"]') as HTMLInputElement
      expect(checkbox.checked).toBe(false)

      await act(async () => {
        checkbox.click()
      })

      expect(buttonOf(container)!.disabled).toBe(false)
      expect(buttonOf(container)!.textContent).toContain('Approve & Submit')
    } finally {
      unmount()
    }
  })

  it('refuses a transaction sourced from a different account than the fee payer', async () => {
    setWallet(feePayer.secret(), feePayer.publicKey())
    const xdr = buildPaymentXdr(stranger.publicKey())
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        response: 'Ready',
        pendingTxXdr: xdr,
        pendingTxSummary: 'Send 1 XLM',
      }),
    })

    const { container, unmount } = renderPage()
    try {
      await sendMessage(container)
      expect(cardOf(container)).not.toBeNull()
      expect(buttonOf(container)!.disabled).toBe(true)

      // Confirm destination & amount so the (disabled) approve button becomes
      // enabled; the page must still refuse on the source mismatch.
      const checkbox = container.querySelector('input[type="checkbox"]') as HTMLInputElement
      await act(async () => {
        checkbox.click()
      })
      expect(buttonOf(container)!.disabled).toBe(false)

      await act(async () => {
        buttonOf(container)!.dispatchEvent(new MouseEvent('click', { bubbles: true }))
      })
      await new Promise((r) => setTimeout(r, 0))

      // The mismatched-source proposal is refused; the card is removed and no
      // passkey ceremony is reached.
      expect(cardOf(container)).toBeNull()
      expect(container.textContent).toContain('not this wallet\'s fee payer')
      expect(requirePasskey).not.toHaveBeenCalled()
    } finally {
      unmount()
    }
  })

  it('refuses a transaction containing a disallowed operation (setOptions)', async () => {
    setWallet(feePayer.secret(), feePayer.publicKey())
    const xdr = setOptionsXdr(feePayer.publicKey())
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        response: 'Ready',
        pendingTxXdr: xdr,
        pendingTxSummary: 'Change options',
      }),
    })

    const { container, unmount } = renderPage()
    try {
      await sendMessage(container)
      expect(cardOf(container)).not.toBeNull()

      // For transactions without a payment operation (such as setOptions),
      // no destination & amount confirmation checkbox is rendered.
      expect(container.querySelector('input[type="checkbox"]')).toBeNull()

      await act(async () => {
        buttonOf(container)!.dispatchEvent(new MouseEvent('click', { bubbles: true }))
      })
      await new Promise((r) => setTimeout(r, 0))

      expect(cardOf(container)).toBeNull()
      expect(container.textContent).toContain('cannot show you')
      expect(requirePasskey).not.toHaveBeenCalled()
    } finally {
      unmount()
    }
  })
})
