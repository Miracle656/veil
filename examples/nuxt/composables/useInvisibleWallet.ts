import { readonly, ref } from 'vue'
// Types only — erased at compile time, so the (CommonJS) SDK never enters the
// server bundle. The runtime module is pulled in via a client-only dynamic
// import below, which keeps WebAuthn/localStorage code out of SSR entirely.
import type * as Vanilla from 'invisible-wallet-sdk/vanilla'

type InvisibleWallet = Vanilla.InvisibleWallet
type WalletConfig = Vanilla.WalletConfig
type RegisterResult = Vanilla.RegisterResult
type DeployResult = Vanilla.DeployResult

/**
 * Vue adapter for the Invisible Wallet SDK (issue #312 / Vue adapter #173).
 *
 * The SDK ships a framework-agnostic `vanilla` build and a React hook; this
 * composable wraps the vanilla `InvisibleWallet` in Vue reactivity so the rest
 * of the example can treat the wallet like any other piece of reactive state.
 *
 * The underlying SDK relies on WebAuthn (`navigator.credentials`) and
 * `localStorage`, both of which only exist in the browser. To stay SSR-safe the
 * SDK is imported and instantiated lazily on the client only — every method
 * throws a clear error if called during server rendering. Wrap any UI that
 * reads wallet state in `<ClientOnly>` (see `pages/dashboard.vue`).
 */

// One wallet instance per browser tab, shared across composable calls.
let walletSingleton: InvisibleWallet | null = null

async function getWallet(config: WalletConfig): Promise<InvisibleWallet> {
  if (!import.meta.client) {
    throw new Error('Invisible Wallet is only available in the browser')
  }
  if (!walletSingleton) {
    const vanilla = await import('invisible-wallet-sdk/vanilla')
    walletSingleton = vanilla.createInvisibleWallet(config)
  }
  return walletSingleton
}

export function useInvisibleWallet(config?: WalletConfig) {
  const resolved = config ?? useNetwork().walletConfig

  const address = ref<string | null>(null)
  const isDeployed = ref(false)
  const ready = ref(false)

  // Hydrate reactive state from whatever the SDK restored from localStorage.
  if (import.meta.client) {
    void getWallet(resolved).then((w) => {
      address.value = w.address
      isDeployed.value = w.isDeployed
      ready.value = true
    })
  }

  function sync(w: InvisibleWallet) {
    address.value = w.address
    isDeployed.value = w.isDeployed
  }

  /** Create a passkey credential and compute the wallet's contract address. */
  async function register(username?: string): Promise<RegisterResult> {
    const w = await getWallet(resolved)
    const result = await w.register(username)
    sync(w)
    return result
  }

  /** Deploy the wallet contract via the factory, paying fees with `feePayerSecret`. */
  async function deploy(feePayerSecret: string): Promise<DeployResult> {
    const w = await getWallet(resolved)
    const result = await w.deploy(feePayerSecret)
    sync(w)
    return result
  }

  /** Resume a wallet already stored on this device; returns null if none/undeployed. */
  async function login(): Promise<{ walletAddress: string } | null> {
    const w = await getWallet(resolved)
    const result = await w.login()
    sync(w)
    return result
  }

  /** Forget the wallet on this device (does not touch on-chain state). */
  function logout() {
    if (!import.meta.client) return
    for (const key of [
      'invisible_wallet_address',
      'invisible_wallet_pubkey',
      'invisible_wallet_credential_id',
      'veil_fee_payer_secret',
    ]) {
      localStorage.removeItem(key)
    }
    walletSingleton = null
    address.value = null
    isDeployed.value = false
  }

  return {
    address: readonly(address),
    isDeployed: readonly(isDeployed),
    ready: readonly(ready),
    register,
    deploy,
    login,
    logout,
  }
}
