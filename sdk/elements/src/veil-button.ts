import { createInvisibleWallet, type WalletConfig } from 'invisible-wallet-sdk/vanilla'

/**
 * <veil-button> — a drop-in custom element that wraps the Invisible Wallet SDK.
 *
 * On click it creates a passkey-backed wallet (WebAuthn) and computes its
 * Stellar contract address, then emits a `veil:success` (or `veil:error`)
 * event. It works on any HTML page, including no-build static sites, once the
 * bundled script is loaded.
 *
 * @example
 * <veil-button
 *   network="testnet"
 *   factory-address="C..."
 *   label="Create wallet"
 * ></veil-button>
 * <script type="module" src="./veil-button.js"></script>
 *
 * Attributes:
 *   - network          "testnet" (default) | "mainnet"
 *   - factory-address  the Veil factory contract id (C...). Required to compute
 *                      a real wallet address; registration still runs without it.
 *   - rpc-url          Soroban RPC URL. Defaults to the network's public RPC.
 *   - username         optional passkey username/display name.
 *   - label            button text. Defaults to "Create wallet with passkey".
 *   - disabled         present to disable the button.
 *
 * Events (both bubble and cross shadow boundaries):
 *   - veil:success     detail: { walletAddress: string; publicKeyHex: string }
 *   - veil:error       detail: { error: string }
 */

const NETWORK_PASSPHRASES: Record<string, string> = {
  testnet: 'Test SDF Network ; September 2015',
  mainnet: 'Public Global Stellar Network ; September 2015',
}

const DEFAULT_RPC: Record<string, string> = {
  testnet: 'https://soroban-testnet.stellar.org',
  mainnet: 'https://mainnet.sorobanrpc.com',
}

function toHex(bytes: Uint8Array): string {
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('')
}

export class VeilButton extends HTMLElement {
  static get observedAttributes() {
    return ['label', 'disabled']
  }

  private button: HTMLButtonElement
  private busy = false

  constructor() {
    super()
    const root = this.attachShadow({ mode: 'open' })
    const style = document.createElement('style')
    style.textContent = `
      :host { display: inline-block; font-family: inherit; }
      button {
        font: inherit;
        font-weight: 600;
        cursor: pointer;
        padding: 0.6rem 1.1rem;
        border-radius: 0.5rem;
        border: 1px solid #4338ca;
        background: #4f46e5;
        color: #fff;
        transition: opacity 0.15s, background 0.15s;
      }
      button:hover:not(:disabled) { background: #4338ca; }
      button:disabled { opacity: 0.6; cursor: default; }
    `
    this.button = document.createElement('button')
    this.button.type = 'button'
    this.button.addEventListener('click', () => void this.handleClick())
    root.append(style, this.button)
    this.render()
  }

  connectedCallback() {
    this.render()
  }

  attributeChangedCallback() {
    this.render()
  }

  private get label(): string {
    return this.getAttribute('label') || 'Create wallet with passkey'
  }

  private render() {
    this.button.textContent = this.busy ? 'Creating…' : this.label
    this.button.disabled = this.busy || this.hasAttribute('disabled')
  }

  private walletConfig(): WalletConfig {
    const network = (this.getAttribute('network') || 'testnet').toLowerCase()
    const networkPassphrase = NETWORK_PASSPHRASES[network] || NETWORK_PASSPHRASES.testnet
    return {
      factoryAddress: this.getAttribute('factory-address') || '',
      rpcUrl: this.getAttribute('rpc-url') || DEFAULT_RPC[network] || DEFAULT_RPC.testnet,
      networkPassphrase,
    }
  }

  private emit(type: 'veil:success' | 'veil:error', detail: Record<string, unknown>) {
    this.dispatchEvent(new CustomEvent(type, { detail, bubbles: true, composed: true }))
  }

  private async handleClick() {
    if (this.busy) return
    this.busy = true
    this.render()
    try {
      const wallet = createInvisibleWallet(this.walletConfig())
      const username = this.getAttribute('username') || undefined
      const { walletAddress, publicKeyBytes } = await wallet.register(username)
      this.emit('veil:success', { walletAddress, publicKeyHex: toHex(publicKeyBytes) })
    } catch (err) {
      this.emit('veil:error', { error: err instanceof Error ? err.message : String(err) })
    } finally {
      this.busy = false
      this.render()
    }
  }
}

// Self-register the element when this module loads (idempotent).
if (typeof customElements !== 'undefined' && !customElements.get('veil-button')) {
  customElements.define('veil-button', VeilButton)
}
