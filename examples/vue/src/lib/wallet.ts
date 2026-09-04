import { useInvisibleWallet } from 'invisible-wallet-sdk/vue'
import { appConfig } from './config'

/**
 * One wallet for the whole app.
 *
 * `useInvisibleWallet` creates an independent wallet on every call, so calling
 * it once here — at module scope — keeps every view reading and writing the
 * same reactive state. Components just `import { wallet }`.
 *
 * In an SSR app (Nuxt) you would instead call the composable inside `setup()`,
 * or hand it out through `provide`/`inject`, so each request gets its own.
 */
export const wallet = useInvisibleWallet({
  factoryAddress: appConfig.factoryAddress,
  rpcUrl: appConfig.rpcUrl,
  networkPassphrase: appConfig.networkPassphrase,
})
