import * as SDK from '@veil/invisible-wallet-sdk'
import { appConfig } from './config'

export function useViteWallet() {
  // SDK is CJS-built; import as namespace and access the hook at runtime.
  return (SDK as any).useInvisibleWallet({
    factoryAddress: appConfig.factoryAddress,
    rpcUrl: appConfig.rpcUrl,
    networkPassphrase: appConfig.networkPassphrase,
  })
}
